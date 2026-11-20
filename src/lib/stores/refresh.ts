// Signing in, refreshing and signing out of store accounts, with the guards
// that keep a bad answer from emptying a library. Ported from BoilR's
// boilr-stores lib.rs.
//
// Getting the games of an account never waits on a store: the Store Account
// parser reads cachedLibrary(), and the app refreshes libraries that got old
// in the background (refreshIfStale). A failed refresh keeps the last list,
// so a network problem never takes an account's games out of Steam.

import * as _ from "lodash";
import { getStoreHost, StoreHost } from "./host";
import {
  isLoginRejected,
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
  ListContext,
  LoginCapture,
  OwnedGame,
  OwnedLibrary,
  PendingLogin,
  STORE_NAMES,
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
  return {
    http: new StoreHttp(host.fetchFor(store), { signal }),
    now: () => clock(),
    log: (message) => log(host, message),
  };
}

function needsRefreshingHost(host: StoreHost) {
  if (!host.canRefresh) {
    throw new Error(
      "This SRM can't talk to the stores; it uses the games the app last fetched.",
    );
  }
}

// One refresh per store at a time in this process; lockRefresh (storage.ts)
// is the same across processes. Two refreshes of one account at once would
// both use (and rotate) the same refresh token.
const queues = new Map<StoreKey, Promise<unknown>>();
const refreshing = new Set<StoreKey>();

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
    needsRefreshingHost(host);
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
    throw redacted(err);
  } finally {
    changed(store);
  }
}

// Saves a new login. The cached library is kept, to be fetched again on next
// use, only when it's known to be the same account's: another account's
// games must not show under this one, and an account without games could
// never replace them (an empty list never replaces one with games).
export async function saveNewLogin(
  store: StoreKey,
  session: StoreSession,
  host: StoreHost = getStoreHost(),
) {
  await storage.withAccountLock(store, () => {
    storage.saveSession(store, session, host);
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
// stores, this is the cache.
export async function refreshIfStale(
  store: StoreKey,
  maxAgeMs: number = LIBRARY_MAX_AGE_MS,
  options: RefreshOptions = {},
): Promise<OwnedLibrary> {
  const noneYet = () =>
    new Error(`The ${STORE_NAMES[store]} library hasn't been fetched yet`);
  const cached = cachedLibrary(store);
  if (
    !getStoreHost().canRefresh ||
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
  needsRefreshingHost(host);
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

async function withDeadline<T>(
  store: StoreKey,
  deadlineMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        transient(
          `Fetching the ${STORE_NAMES[store]} library took longer than ${Math.round(deadlineMs / 60000)} minutes and was stopped`,
        ),
      );
    }, deadlineMs);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
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
  // Set when the deadline passed: nothing but renewed tokens is saved.
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

// Saves what a refresh produced: the session (tokens may have been renewed
// even when listing the games failed) and the library.
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
  return storage.withAccountLock(store, () => {
    // Signing out (or in again) while the games were fetched wins: saving
    // now would bring back the old login.
    if (storage.readSessionInfo(store)?.rev !== run.startedRev) {
      throw accountChanged(store);
    }
    if (!_.isEqual(run.session, run.startedWith)) {
      storage.saveSession(store, run.session, host);
    }
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

// Signs out. Where the store offers a way, it's told first that SRM's login
// is no longer needed (Epic, Amazon); the others keep it valid until it
// expires. Then the session and the cached library are removed, also when
// the store couldn't be told: that returns a warning.
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
  await deleteAccount(store);
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
  return warning;
}

// Removes the session and the cached library without telling the store.
export async function deleteAccount(store: StoreKey) {
  try {
    await storage.withAccountLock(store, () => storage.deleteAccount(store));
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
