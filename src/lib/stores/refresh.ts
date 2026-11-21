// Signing in, refreshing and signing out of store accounts, with the guards
// that keep a bad answer from emptying a library. Ported from BoilR's
// boilr-stores lib.rs.
//
// The app refreshes libraries that got old in the background at start, and
// the Store Account parser fetches an old one before it lists its games
// (refreshIfStale): in the app it waits for that only briefly when there's
// a list from before, on the command line in full. A failed refresh keeps
// the last list, so a network problem never takes an account's games out of
// Steam.
//
// A cookie store's login is the cookies of its browser partition, which is
// in memory only. They are saved with the session (encrypted by the host,
// like every sign-in) after a sign-in and after every refresh, and put back
// into the partition before a refresh's first request when it doesn't hold
// them: after a restart, in the command line, or when another SRM saved
// newer ones.

import * as _ from "lodash";
import { getStoreHost, hostRefreshes, StoreHost } from "./host";
import {
  isLoginRejected,
  isSiteCookie,
  isTransient,
  loginRejected,
  messageOf,
  redact,
  StoreHttp,
  transient,
} from "./http";
import { storeClient } from "./registry";
import * as storage from "./storage";
import {
  AccountStatus,
  COOKIE_STORES,
  ListContext,
  LoginCapture,
  OwnedGame,
  OwnedLibrary,
  PendingLogin,
  STORE_NAMES,
  SavedCookie,
  StoreClient,
  StoreContext,
  StoreKey,
  StoreSession,
} from "./types";

// Libraries older than this are fetched again (refreshIfStale's default).
export const LIBRARY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// After a failed refresh, refreshIfStale waits this long before it tries
// again; a partial library is fetched again after this long too.
export const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;

// A refresh that takes longer than this is given up, whatever the store is
// doing.
export const REFRESH_DEADLINE_MS = 3 * 60 * 1000;

// A library this long or longer isn't replaced by one less than half its
// size when the refresh was automatic.
export const SHRINK_GUARD_MIN_GAMES = 20;

// How a refresh was asked for: by the user (or right after a sign-in), when
// a much shorter list is taken as it is; or because the cache got old, when
// it isn't trusted.
export type Asked = "explicitly" | "automatically";

export interface RefreshOptions {
  // (tests)
  deadlineMs?: number;
}

// The account was signed out of, or signed in again, while a refresh ran:
// the refresh's results belong to the old login and were dropped.
export class AccountChanged extends Error {
  name = "AccountChanged";
}

export function isAccountChanged(err: unknown) {
  for (let e: any = err; e; e = e.cause) {
    if (e instanceof AccountChanged) {
      return true;
    }
  }
  return false;
}

function accountChanged(store: StoreKey) {
  return new AccountChanged(
    `The ${STORE_NAMES[store]} account changed while its games were being fetched; that list was dropped.`,
  );
}

// The error as one message without secrets, keeping its kind: a refused
// login, a transient failure, or an account that changed meanwhile.
export function redacted(err: unknown): Error {
  const message = redact(messageOf(err));
  if (isAccountChanged(err)) {
    return new AccountChanged(message);
  }
  if (isLoginRejected(err)) {
    return loginRejected(message);
  }
  if (isTransient(err)) {
    return transient(message);
  }
  return new Error(message);
}

let clock = () => Date.now();

// (tests) Sets the clock the stores use; none puts back the real one.
export function setStoreClock(now?: () => number) {
  clock = now || (() => Date.now());
}

// Something about an account changed (sign-in, refresh, sign-out): the app
// tells its windows.
type Listener = (store: StoreKey) => void;
const listeners = new Set<Listener>();

export function onStoresChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(store: StoreKey) {
  for (const listener of listeners) {
    try {
      listener(store);
    } catch {
      // (a listener's problem is not the store's)
    }
  }
}

function log(host: StoreHost, message: string) {
  host.log?.(redact(message));
}

function clientFor(store: StoreKey): StoreClient {
  const client = storeClient(store);
  if (!client) {
    throw new Error(
      `Signing in to ${STORE_NAMES[store]} comes with a later version of SRM.`,
    );
  }
  return client;
}

function storeContext(
  store: StoreKey,
  host: StoreHost,
  signal?: AbortSignal,
): StoreContext {
  const ctx: StoreContext = {
    http: new StoreHttp(host.fetchFor(store), { signal }),
    now: () => clock(),
    log: (message) => log(host, message),
  };
  // (only a cookie store's partition holds its login)
  if (COOKIE_STORES.includes(store)) {
    if (host.cookies) {
      const read = host.cookies.bind(host);
      ctx.cookies = (url) => read(store, url);
    }
    if (host.setCookies) {
      const set = host.setCookies.bind(host);
      ctx.setCookies = (cookies) => set(store, cookies);
    }
  }
  return ctx;
}

// ---- a cookie store's partition and its saved cookies ----

// Which saved cookies (their cookiesRev; null: none saved) each cookie
// store's partition in this process holds, or holds a newer state of
// (renewals this process couldn't save yet). Not known (after a restart, in
// the command line, after a sign-in that didn't finish) or another SRM's
// (it signed in or refreshed meanwhile): the saved cookies are put back
// before the next refresh's first request.
const partitionHolds = new Map<StoreKey, string | null>();

// The sites whose cookies are a cookie store's login.
function cookieSites(store: StoreKey): string[] {
  return storeClient(store)?.beginLogin().siteDomains ?? [];
}

// The cookies of a cookie store's partition to save with its session: the
// store's own sites' only, never another site's (a Google, Steam or Apple
// single sign-on its sign-in page offered). Undefined for a token store, or
// a host without partitions.
async function partitionCookies(
  store: StoreKey,
  host: StoreHost,
): Promise<SavedCookie[] | undefined> {
  if (!COOKIE_STORES.includes(store) || !host.exportCookies) {
    return undefined;
  }
  const sites = cookieSites(store);
  const cookies = await host.exportCookies(store, sites);
  return cookies.filter((cookie) => isSiteCookie(cookie.domain, sites));
}

// This process just saved the session, or put the saved cookies into the
// partition: the partition holds what's saved, or newer. (Under the account
// lock.)
function partitionSaved(store: StoreKey) {
  if (!COOKIE_STORES.includes(store)) {
    return;
  }
  try {
    partitionHolds.set(
      store,
      storage.readSessionInfo(store)?.cookiesRev ?? null,
    );
  } catch {
    partitionHolds.delete(store);
  }
}

// Replaces the partition's cookies with the saved ones (the host leaves out
// expired ones). (Under the account lock.)
async function putBackCookies(
  store: StoreKey,
  host: StoreHost,
  saved: { cookiesRev: string | null; cookies: SavedCookie[] },
) {
  if (!host.importCookies) {
    return;
  }
  partitionHolds.delete(store);
  await host.importCookies(store, saved.cookies);
  partitionHolds.set(store, saved.cookiesRev);
}

// Puts a cookie store's saved cookies into its partition before a refresh
// sends anything, unless the partition holds them already. Under the account
// lock, and only while the session is the one the refresh loaded (`rev`): a
// sign-out or a new sign-in meanwhile wins, and what it removed doesn't come
// back.
async function restorePartition(store: StoreKey, host: StoreHost, rev: string) {
  if (!COOKIE_STORES.includes(store) || !host.importCookies) {
    return;
  }
  await storage.withAccountLock(store, async () => {
    const saved = storage.loadSessionCookies(store, host);
    if (!saved || saved.rev !== rev) {
      throw accountChanged(store);
    }
    if (
      partitionHolds.has(store) &&
      partitionHolds.get(store) === saved.cookiesRev
    ) {
      return;
    }
    await putBackCookies(store, host, saved);
  });
}

// Whether saved cookies are the same as `cookies`, whatever their order.
function sameCookies(
  cookies: readonly SavedCookie[],
  saved: readonly SavedCookie[] | undefined,
) {
  const key = (c: SavedCookie) => `${c.domain}\n${c.path}\n${c.name}`;
  return !!saved && _.isEqual(_.sortBy(cookies, key), _.sortBy(saved, key));
}

function needsRefreshingHost(host: StoreHost, store: StoreKey) {
  if (!host.canRefresh) {
    throw new Error(
      "This SRM can't talk to the stores; it uses the games the app last fetched.",
    );
  }
  if (!hostRefreshes(host, store)) {
    throw new Error(
      `This SRM can't fetch the ${STORE_NAMES[store]} library; it uses the games the app last fetched.`,
    );
  }
}

// Offline mode (SRM's setting): libraries aren't fetched by themselves, the
// cached ones are used. A refresh the user asks for still runs. The app
// gives a function that reads its live setting.
let isOffline: () => boolean = () => false;

export function setStoresOffline(offline: boolean | (() => boolean)) {
  isOffline = typeof offline === "function" ? offline : () => offline;
}

// One refresh per store at a time in this process; lockRefresh (storage.ts)
// is the same across processes. Two refreshes of one account at once would
// both use (and rotate) the same refresh token.
const queues = new Map<StoreKey, Promise<unknown>>();
const refreshing = new Set<StoreKey>();
// What stops the refresh running now, per store (sign-out uses it).
const running = new Map<StoreKey, AbortController>();

function oneAtATime<T>(store: StoreKey, work: () => Promise<T>): Promise<T> {
  const before = queues.get(store) || Promise.resolve();
  const run = before.then(work, work);
  queues.set(
    store,
    run.catch(() => undefined),
  );
  return run;
}

// The sign-in in progress per store. A login started in one place (the
// window, or a link the user opens in their browser) is finished in another
// (a pasted value), so both must use the same PendingLogin: its state can
// hold a PKCE verifier.
const pendingLogins = new Map<StoreKey, PendingLogin>();

// The sign-in in progress for `store`, started on first use; completeLogin
// ends it when it works.
export function pendingLogin(store: StoreKey): PendingLogin {
  let pending = pendingLogins.get(store);
  if (!pending) {
    pending = clientFor(store).beginLogin();
    pendingLogins.set(store, pending);
  }
  return pending;
}

export function endPendingLogin(store: StoreKey) {
  pendingLogins.delete(store);
}

// Finishes a login and saves the session. Returns the account name, when the
// store has one. Fetching the games is up to the caller (refreshLibrary).
export async function completeLogin(
  pending: PendingLogin,
  capture: LoginCapture,
): Promise<string | null> {
  const store = pending.store;
  const host = getStoreHost();
  try {
    needsRefreshingHost(host, store);
    const session = await clientFor(store).completeLogin(
      pending,
      capture,
      storeContext(store, host),
    );
    await saveNewLogin(store, session, host);
    endPendingLogin(store);
    recordFailure(store, null);
    return session.accountName;
  } catch (err) {
    await forgetUnfinishedLogin(store);
    throw redacted(err);
  } finally {
    changed(store);
  }
}

// A cookie store's sign-in that didn't finish (it failed, or the user closed
// the window): its partition may hold a working login, which SRM would show
// as "not signed in", with no way to sign out. It's emptied, unless the
// account is signed in (signing in again): then it gets the account's saved
// cookies back, as they were before the window. (A damaged sign-in's
// cookies can't be read: the partition is left as it is.)
export async function forgetUnfinishedLogin(store: StoreKey) {
  const host = getStoreHost();
  if (!COOKIE_STORES.includes(store)) {
    return;
  }
  try {
    await storage.withAccountLock(store, async () => {
      partitionHolds.delete(store);
      if (!signedIn(store)) {
        await host.clearStoreData?.(store);
        return;
      }
      const saved = storage.loadSessionCookies(store, host);
      if (saved) {
        await putBackCookies(store, host, saved);
      }
    });
  } catch (err) {
    log(
      host,
      `Could not clear the ${STORE_NAMES[store]} sign-in data: ${messageOf(err)}`,
    );
  }
}

// Saves a new login: a cookie store's with its partition's cookies, which
// are the login (an earlier login's saved cookies go). The cached library is
// kept, to be fetched again on next use, only when it's known to be the same
// account's: another account's games must not show under this one, and an
// account without games could never replace them (an empty list never
// replaces one with games).
export async function saveNewLogin(
  store: StoreKey,
  session: StoreSession,
  host: StoreHost = getStoreHost(),
) {
  await storage.withAccountLock(store, async () => {
    const cookies = await partitionCookies(store, host);
    storage.saveSession(
      store,
      session,
      host,
      cookies ?? (COOKIE_STORES.includes(store) ? [] : undefined),
    );
    partitionSaved(store);
    const library = cachedLibrary(store);
    if (!library) {
      return;
    }
    const sameAccount =
      library.accountName !== null &&
      session.accountName !== null &&
      library.accountName === session.accountName;
    if (sameAccount) {
      storage.saveLibrary(store, { ...library, fetchedAt: 0 });
    } else {
      storage.deleteLibrary(store);
    }
  });
}

// Records how a refresh went: null clears the failure. The record outlives
// a restart, so retries hold off and the account can say what went wrong.
export function recordFailure(store: StoreKey, err: unknown | null) {
  try {
    storage.saveFailure(
      store,
      err === null
        ? null
        : {
            at: clock(),
            message: redact(messageOf(err)),
            needsSignIn: isLoginRejected(err),
          },
    );
  } catch (writeErr) {
    log(
      getStoreHost(),
      `Could not record the state of the ${STORE_NAMES[store]} account: ${messageOf(writeErr)}`,
    );
  }
}

function failedRecently(store: StoreKey) {
  const failure = storage.loadFailure(store);
  return !!failure && clock() - failure.at < RETRY_AFTER_FAILURE_MS;
}

function signedIn(store: StoreKey) {
  try {
    return !!storage.readSessionInfo(store);
  } catch {
    return true; // (there, if damaged)
  }
}

// The cached library, or null when there is none or it can't be read (a
// damaged file is replaced by the next refresh instead of breaking the
// account).
export function cachedLibrary(store: StoreKey): OwnedLibrary | null {
  try {
    return storage.loadLibrary(store);
  } catch (err) {
    log(
      getStoreHost(),
      `The saved ${STORE_NAMES[store]} library is unreadable, it will be fetched again: ${messageOf(err)}`,
    );
    return null;
  }
}

// Whether a library should be fetched again: it's older than `maxAgeMs`,
// was never fetched, or is partial and older than RETRY_AFTER_FAILURE_MS.
export function isStale(
  library: OwnedLibrary | null | undefined,
  maxAgeMs: number,
  now: number = clock(),
) {
  if (!library) {
    return true;
  }
  const maxAge = library.partial
    ? Math.min(maxAgeMs, RETRY_AFTER_FAILURE_MS)
    : maxAgeMs;
  return now - library.fetchedAt > maxAge;
}

// Fetches the owned games with the saved session, then saves the renewed
// session and the library. On error the previous library stays. This is
// the refresh a user asks for: it takes a list much shorter than the last.
export function refreshLibrary(
  store: StoreKey,
  options: RefreshOptions = {},
): Promise<OwnedLibrary> {
  return oneAtATime(store, async () => {
    const library = await refreshAndRecord(
      store,
      "explicitly",
      () => true,
      options,
    );
    if (!library) {
      throw new Error(`The ${STORE_NAMES[store]} library was not fetched`);
    }
    return library;
  });
}

// The library, fetched again first when it's older than `maxAgeMs`. A failed
// fetch falls back to the cache and isn't tried again for
// RETRY_AFTER_FAILURE_MS. Callers in this process or another wait for one
// fetch instead of each making their own. Where the host can't talk to the
// store, or SRM is offline, this is the cache.
export async function refreshIfStale(
  store: StoreKey,
  maxAgeMs: number = LIBRARY_MAX_AGE_MS,
  options: RefreshOptions = {},
): Promise<OwnedLibrary> {
  const noneYet = () =>
    new Error(`The ${STORE_NAMES[store]} library hasn't been fetched yet`);
  const cached = cachedLibrary(store);
  if (
    isOffline() ||
    !hostRefreshes(getStoreHost(), store) ||
    !isStale(cached, maxAgeMs) ||
    (cached && failedRecently(store))
  ) {
    if (cached) {
      return cached;
    }
    throw noneYet();
  }
  return oneAtATime(store, async () => {
    if (failedRecently(store)) {
      const library = cachedLibrary(store);
      if (library) {
        return library;
      }
      throw new Error(
        `Could not fetch the ${STORE_NAMES[store]} library a moment ago; it is tried again later`,
      );
    }
    // Another caller, or another SRM, may have fetched it while this one
    // waited.
    const stillStale = () => isStale(cachedLibrary(store), maxAgeMs);
    try {
      const library = await refreshAndRecord(
        store,
        "automatically",
        stillStale,
        options,
      );
      const result = library || cachedLibrary(store);
      if (result) {
        return result;
      }
      throw noneYet();
    } catch (err) {
      // While the account is signed in, a list from before beats none: a
      // failed refresh must not take the account's games out of Steam.
      const before = signedIn(store) ? cachedLibrary(store) : null;
      if (!before) {
        throw err;
      }
      log(
        getStoreHost(),
        `Could not refresh the ${STORE_NAMES[store]} library, using the one from before: ${messageOf(err)}`,
      );
      return before;
    }
  });
}

// Runs a refresh under the cross-process lock and the deadline, and records
// how it went. A refresh dropped because the account changed is no failure
// of the new login. `stillNeeded` is asked once the lock is held: another
// process may have done the work.
async function refreshAndRecord(
  store: StoreKey,
  asked: Asked,
  stillNeeded: () => boolean,
  options: RefreshOptions,
): Promise<OwnedLibrary | null> {
  const host = getStoreHost();
  needsRefreshingHost(host, store);
  const deadlineMs = options.deadlineMs ?? REFRESH_DEADLINE_MS;
  const release = await storage.lockRefresh(store, deadlineMs);
  if (!release) {
    throw transient(
      `Another SRM is still fetching the ${STORE_NAMES[store]} library`,
    );
  }
  refreshing.add(store);
  changed(store);
  try {
    if (!stillNeeded()) {
      return null;
    }
    try {
      const library = await withDeadline(store, deadlineMs, (signal) =>
        refreshLocked(store, asked, host, signal),
      );
      recordFailure(store, null);
      return library;
    } catch (err) {
      const clean = redacted(err);
      if (!isAccountChanged(clean)) {
        recordFailure(store, clean);
      }
      throw clean;
    }
  } finally {
    release();
    refreshing.delete(store);
    changed(store);
  }
}

// Runs `work` until it ends, the deadline passes, or the refresh is stopped
// from outside (sign-out): the last two abort its requests, and end the
// refresh at once with the abort's reason, also when the store module
// doesn't notice.
async function withDeadline<T>(
  store: StoreKey,
  deadlineMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  running.set(store, controller);
  const timer = setTimeout(
    () =>
      controller.abort(
        transient(
          `Fetching the ${STORE_NAMES[store]} library took longer than ${Math.round(deadlineMs / 60000)} minutes and was stopped`,
        ),
      ),
    deadlineMs,
  );
  const stopped = new Promise<never>((_resolve, reject) =>
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true },
    ),
  );
  try {
    return await Promise.race([work(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    if (running.get(store) === controller) {
      running.delete(store);
    }
  }
}

// What a refresh has to commit.
export interface RefreshRun {
  store: StoreKey;
  // The session on disk as this refresh knows it (after its checkpoints),
  // and its rev.
  startedRev: string;
  startedWith: StoreSession;
  // The session as the store module left it.
  session: StoreSession;
  fetched: { games?: OwnedGame[]; error?: unknown; partial?: boolean };
  asked: Asked;
  // Aborted when the deadline passed or the account was signed out of:
  // nothing but what the store renewed (tokens, cookies) is saved.
  signal?: AbortSignal;
}

async function refreshLocked(
  store: StoreKey,
  asked: Asked,
  host: StoreHost,
  signal: AbortSignal,
): Promise<OwnedLibrary> {
  const client = clientFor(store);
  const loaded = storage.loadSession(store, host);
  if (!loaded) {
    throw new Error(`Not signed in to ${STORE_NAMES[store]}`);
  }
  // (a cookie store's login: in its partition before any request goes out)
  await restorePartition(store, host, loaded.rev);
  const previous = cachedLibrary(store)?.games || [];
  const run: RefreshRun = {
    store,
    startedRev: loaded.rev,
    startedWith: _.cloneDeep(loaded.session),
    session: loaded.session,
    fetched: {},
    asked,
    signal,
  };
  const ctx: ListContext = {
    ...storeContext(store, host, signal),
    previous,
    checkpoint: async (session) => {
      await storage.withAccountLock(store, () => {
        if (storage.readSessionInfo(store)?.rev !== run.startedRev) {
          throw accountChanged(store);
        }
        run.startedRev = storage.saveSession(store, session, host);
        run.startedWith = _.cloneDeep(session);
        partitionSaved(store);
      });
    },
  };
  try {
    const result = await client.listLibrary(run.session, ctx);
    run.fetched = { games: result.games, partial: !!result.partial };
  } catch (err) {
    run.fetched = { error: err };
  }
  return commitRefresh(run, host);
}

// Saves what a refresh produced: what the store renewed (tokens, a cookie
// store's cookies; also when listing the games failed or was stopped) and
// the library.
//
// A list that looks cut short isn't saved, because the games it lacks would
// be taken out of Steam: an empty list never replaces a list with games,
// and a list less than half as long as the last one is only taken when the
// user asked for the refresh.
export async function commitRefresh(
  run: RefreshRun,
  host: StoreHost = getStoreHost(),
): Promise<OwnedLibrary> {
  const { store } = run;
  const name = STORE_NAMES[store];
  return storage.withAccountLock(store, async () => {
    // Signing out (or in again) while the games were fetched wins: saving
    // now would bring back the old login.
    if (storage.readSessionInfo(store)?.rev !== run.startedRev) {
      throw accountChanged(store);
    }
    await saveRenewed(run, host);
    if (run.fetched.error !== undefined) {
      throw run.fetched.error;
    }
    if (run.signal?.aborted) {
      throw transient(`Fetching the ${name} library was stopped`);
    }
    const games = _.sortBy(
      (run.fetched.games || []).filter(
        (g) => g.id !== "" && g.title.trim() !== "",
      ),
      (g) => g.id,
    );
    const unique = games.filter((g, i) => i === 0 || games[i - 1].id !== g.id);
    const before = cachedLibrary(store)?.games.length || 0;
    if (unique.length === 0 && before > 0) {
      throw new Error(
        `${name} listed no games, but it listed ${before} before. The earlier list is kept, because an empty answer is more likely a store problem than an empty account. If the account really has no games, sign out and in again.`,
      );
    }
    if (
      run.asked === "automatically" &&
      before >= SHRINK_GUARD_MIN_GAMES &&
      unique.length * 2 < before
    ) {
      throw new Error(
        `${name} listed ${unique.length} games, down from ${before}. The earlier list is kept in case the store's answer was cut short. Refresh the library from the parser to take the shorter list.`,
      );
    }
    const library: OwnedLibrary = {
      accountName: run.session.accountName ?? null,
      fetchedAt: clock(),
      games: unique,
      partial: !!run.fetched.partial,
    };
    storage.saveLibrary(store, library);
    return library;
  });
}

// Saves what the store renewed during a refresh: the session as the store's
// module left it, and a cookie store's partition cookies, when they changed.
// Saving the cookies alone keeps the session's rev. (Under the account lock,
// once the rev is checked.)
async function saveRenewed(run: RefreshRun, host: StoreHost) {
  const { store } = run;
  let cookies: SavedCookie[] | undefined;
  try {
    cookies = await partitionCookies(store, host);
  } catch (err) {
    // (they stay in the partition, and the next refresh saves them)
    log(
      host,
      `Could not save the ${STORE_NAMES[store]} sign-in cookies: ${messageOf(err)}`,
    );
  }
  if (!_.isEqual(run.session, run.startedWith)) {
    storage.saveSession(store, run.session, host, cookies);
  } else if (cookies) {
    let saved: SavedCookie[] | undefined;
    try {
      saved = storage.loadSessionCookies(store, host)?.cookies;
    } catch {
      // (unreadable: replaced)
    }
    if (!sameCookies(cookies, saved)) {
      storage.saveSessionCookies(store, cookies, host);
    }
  }
  partitionSaved(store);
}

// Signs out. Where the store offers a way, it's told first that SRM's login
// is no longer needed (Epic, Amazon); the others keep it valid until it
// expires. Then the session (with a cookie store's saved cookies) and the
// cached library are removed, also when the store couldn't be told: that
// returns a warning. A cookie store's partition is emptied last, once a
// refresh that was running has stopped: an answer still on its way would
// put renewed sign-in cookies back. (Such a refresh can neither save its
// cookies nor put the saved ones back into the partition: both check, under
// the account lock, that its session is still there.)
export async function signOut(store: StoreKey): Promise<string | null> {
  const host = getStoreHost();
  let warning: string | null = null;
  const client = storeClient(store);
  if (client?.signOut && host.canRefresh) {
    let loaded: ReturnType<typeof storage.loadSession> = null;
    try {
      loaded = storage.loadSession(store, host);
    } catch {
      // (nothing to tell the store with)
    }
    if (loaded) {
      try {
        await client.signOut(loaded.session, storeContext(store, host));
      } catch (err) {
        warning = `Signed out, but ${STORE_NAMES[store]} may still list SRM's login: ${redacted(err).message}`;
      }
    }
  }
  // (first: a refresh still queued then finds no session, and sends nothing)
  await deleteAccount(store);
  if (COOKIE_STORES.includes(store)) {
    running.get(store)?.abort(accountChanged(store));
    // (never rejects: see oneAtATime)
    await queues.get(store);
  }
  if (host.clearStoreData) {
    try {
      await host.clearStoreData(store);
    } catch (err) {
      log(
        host,
        `Could not clear the ${STORE_NAMES[store]} sign-in data: ${messageOf(err)}`,
      );
    }
  }
  partitionHolds.delete(store);
  return warning;
}

// Removes the session and the cached library without telling the store.
export async function deleteAccount(store: StoreKey) {
  try {
    await storage.withAccountLock(store, () => {
      storage.deleteAccount(store);
      partitionHolds.delete(store);
    });
    endPendingLogin(store);
    recordFailure(store, null);
  } finally {
    changed(store);
  }
}

// The state of an account, from disk. Starts no login: when none is in
// progress, the sign-in details come from one that's thrown away.
export function accountStatus(store: StoreKey): AccountStatus {
  const client = storeClient(store);
  let info: storage.SessionInfo | null = null;
  let damaged = false;
  try {
    info = storage.readSessionInfo(store);
  } catch {
    damaged = true;
  }
  const library = cachedLibrary(store);
  const pending = pendingLogins.get(store) || client?.beginLogin();
  const failure = info || damaged ? storage.loadFailure(store) : null;
  return {
    store,
    name: STORE_NAMES[store],
    available: !!client,
    signedIn: !!info || damaged,
    accountName: info?.accountName ?? library?.accountName ?? null,
    gameCount: library ? library.games.length : null,
    fetchedAt: library ? library.fetchedAt : null,
    partial: !!library?.partial,
    manual: pending?.manual || { kind: "unsupported" },
    webviewLogin: !!pending?.doneUrlPrefixes.length,
    lastError: damaged
      ? `The saved ${STORE_NAMES[store]} login can't be read. Sign in again.`
      : (failure?.message ?? null),
    needsSignIn: damaged || !!failure?.needsSignIn,
    refreshing: refreshing.has(store),
  };
}
