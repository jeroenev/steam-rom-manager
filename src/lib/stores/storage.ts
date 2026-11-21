// Sessions and libraries live in <userData>/stores/<store key>/:
// session.json (the account name, and the session's data and a cookie
// store's cookies, encrypted by the host) and library.json (the owned games;
// not secret, but private, so both are readable by the user only). The
// record of the last failed refresh and the locks sit next to the store
// folders, in .status and .locks, so they outlive a sign-out's removal of
// the folder. Ported from BoilR's storage.rs.
//
// The GUI and the command line may run at once, so every change is made
// under a lock that works across processes: a folder made with mkdir (which
// either makes it or finds it there), given up as stale when its holder
// stops touching it. Never a PID: in a Flatpak, SRM runs in its own PID
// namespace and can't see other processes.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { storesDir } from "../../paths";
import { StoreHost } from "./host";
import { loginRejected, messageOf } from "./http";
import {
  OwnedGame,
  OwnedLibrary,
  STORE_NAMES,
  SavedCookie,
  StoreKey,
  StoreSession,
  isStoreKey,
} from "./types";

// Where everything lives.
const root = storesDir;

export function storesRoot() {
  return root;
}

export function storeFolder(store: StoreKey) {
  return path.join(root, store);
}

export function sessionFile(store: StoreKey) {
  return path.join(storeFolder(store), "session.json");
}

export function libraryFile(store: StoreKey) {
  return path.join(storeFolder(store), "library.json");
}

export function failureFile(store: StoreKey) {
  return path.join(root, ".status", `${store}.json`);
}

function locksFolder() {
  return path.join(root, ".locks");
}

// session.json. `rev` changes on every save of the session: a refresh that
// started with another rev belongs to a login that was signed out of or
// replaced.
interface SessionFile {
  version: 1;
  rev: string;
  accountName: string | null;
  // host.protect(JSON of StoreSession.data)
  data: string;
  // A cookie store's: host.protect(JSON of its partition's SavedCookie[]),
  // and a rev that changes whenever they are saved. Saving the cookies alone
  // keeps `rev`: the store renewed them, the login is the same.
  cookies?: string;
  cookiesRev?: string;
}

// What's known about a saved session without decrypting it.
export interface SessionInfo {
  rev: string;
  accountName: string | null;
  // The rev of the saved cookies; null when none are saved.
  cookiesRev: string | null;
}

export function readSessionInfo(store: StoreKey): SessionInfo | null {
  const file = readJson<SessionFile>(sessionFile(store));
  if (!file || typeof file.rev !== "string") {
    return null;
  }
  return {
    rev: file.rev,
    accountName: file.accountName ?? null,
    cookiesRev: savedCookiesRev(file),
  };
}

function savedCookiesRev(file: SessionFile) {
  return typeof file.cookies === "string" && typeof file.cookiesRev === "string"
    ? file.cookiesRev
    : null;
}

function newRev() {
  return crypto.randomBytes(8).toString("hex");
}

// The saved session, decrypted. A session that can't be read (another
// machine's encryption, a damaged file) needs a new sign-in.
export function loadSession(
  store: StoreKey,
  host: StoreHost,
): { rev: string; session: StoreSession } | null {
  const file = readJson<SessionFile>(sessionFile(store));
  if (!file) {
    return null;
  }
  try {
    const data = JSON.parse(host.unprotect(file.data));
    if (!data || typeof data !== "object") {
      throw new Error("no session data");
    }
    return {
      rev: file.rev,
      session: { accountName: file.accountName ?? null, data },
    };
  } catch (err) {
    throw loginRejected(
      `The saved ${STORE_NAMES[store]} login can't be read (${messageOf(err)}). Sign in again.`,
    );
  }
}

// A session's data as a store module's own shape, checked by `isValid`.
// Data that doesn't fit (from another version, or damaged) needs a new
// sign-in.
export function sessionData<T>(
  store: StoreKey,
  session: StoreSession,
  isValid: (data: any) => boolean,
): T {
  if (!session?.data || !isValid(session.data)) {
    throw loginRejected(
      `The saved ${STORE_NAMES[store]} login can't be read (it is missing what SRM needs). Sign in again.`,
    );
  }
  return session.data as T;
}

// Saves a session; returns its new rev. `cookies` (a cookie store's
// partition) replace the saved cookies; without them, the ones saved before
// are kept.
export function saveSession(
  store: StoreKey,
  session: StoreSession,
  host: StoreHost,
  cookies?: readonly SavedCookie[],
): string {
  const rev = newRev();
  const file: SessionFile = {
    version: 1,
    rev,
    accountName: session.accountName ?? null,
    data: host.protect(JSON.stringify(session.data)),
  };
  if (cookies) {
    Object.assign(file, protectedCookies(cookies, host));
  } else {
    let before: SessionFile | null = null;
    try {
      before = readJson<SessionFile>(sessionFile(store));
    } catch {
      // (a damaged file has no cookies to keep)
    }
    if (before && savedCookiesRev(before) !== null) {
      file.cookies = before.cookies;
      file.cookiesRev = before.cookiesRev;
    }
  }
  writeJson(sessionFile(store), file);
  return rev;
}

// Replaces a saved session's cookies, keeping the session and its rev (the
// same login); returns the cookies' new rev. Fails when there is no session.
export function saveSessionCookies(
  store: StoreKey,
  cookies: readonly SavedCookie[],
  host: StoreHost,
): string {
  const file = readJson<SessionFile>(sessionFile(store));
  if (!file || typeof file.rev !== "string") {
    throw new Error(`Not signed in to ${STORE_NAMES[store]}`);
  }
  const saved = protectedCookies(cookies, host);
  writeJson(sessionFile(store), { ...file, ...saved });
  return saved.cookiesRev;
}

function protectedCookies(cookies: readonly SavedCookie[], host: StoreHost) {
  return {
    cookies: host.protect(JSON.stringify(cookies)),
    cookiesRev: newRev(),
  };
}

// A session's saved cookies, decrypted, with the session's rev and theirs;
// null when there is no session. None saved is an empty list (cookiesRev
// null). Cookies that can't be read need a new sign-in, as the session does.
export function loadSessionCookies(
  store: StoreKey,
  host: StoreHost,
): { rev: string; cookiesRev: string | null; cookies: SavedCookie[] } | null {
  const file = readJson<SessionFile>(sessionFile(store));
  if (!file || typeof file.rev !== "string") {
    return null;
  }
  const cookiesRev = savedCookiesRev(file);
  if (cookiesRev === null) {
    return { rev: file.rev, cookiesRev, cookies: [] };
  }
  let cookies: unknown;
  try {
    cookies = JSON.parse(host.unprotect(file.cookies!));
    if (!Array.isArray(cookies)) {
      throw new Error("no cookies");
    }
  } catch (err) {
    throw loginRejected(
      `The saved ${STORE_NAMES[store]} login can't be read (${messageOf(err)}). Sign in again.`,
    );
  }
  return { rev: file.rev, cookiesRev, cookies: cookies.filter(isSavedCookie) };
}

const SAME_SITE: readonly SavedCookie["sameSite"][] = [
  "unspecified",
  "no_restriction",
  "lax",
  "strict",
];

function isSavedCookie(cookie: any): cookie is SavedCookie {
  return (
    !!cookie &&
    typeof cookie.name === "string" &&
    typeof cookie.value === "string" &&
    typeof cookie.domain === "string" &&
    typeof cookie.hostOnly === "boolean" &&
    typeof cookie.path === "string" &&
    typeof cookie.secure === "boolean" &&
    typeof cookie.httpOnly === "boolean" &&
    SAME_SITE.includes(cookie.sameSite) &&
    (cookie.expirationDate === undefined ||
      typeof cookie.expirationDate === "number")
  );
}

// The cached library; null when there is none. Throws when it can't be
// read.
export function loadLibrary(store: StoreKey): OwnedLibrary | null {
  const library = readJson<OwnedLibrary>(libraryFile(store));
  if (!library) {
    return null;
  }
  if (!Array.isArray(library.games) || typeof library.fetchedAt !== "number") {
    throw new Error(`${libraryFile(store)} is not a library`);
  }
  return {
    accountName: library.accountName ?? null,
    fetchedAt: library.fetchedAt,
    games: library.games.filter(isOwnedGame).map((game) => ({
      store: game.store,
      id: game.id,
      title: game.title,
      extra: game.extra && typeof game.extra === "object" ? game.extra : {},
    })),
    partial: !!library.partial,
  };
}

function isOwnedGame(game: any): game is OwnedGame {
  return (
    !!game &&
    isStoreKey(game.store) &&
    typeof game.id === "string" &&
    typeof game.title === "string"
  );
}

export function saveLibrary(store: StoreKey, library: OwnedLibrary) {
  writeJson(libraryFile(store), library);
}

// Removes the cached library and keeps the session.
export function deleteLibrary(store: StoreKey) {
  fs.rmSync(libraryFile(store), { force: true });
}

// The last failed refresh, while none has worked since.
export interface Failure {
  // Milliseconds since 1970.
  at: number;
  message: string;
  // The store refused the saved login; nothing else asks for a new sign-in.
  needsSignIn: boolean;
}

// An unreadable record counts as none.
export function loadFailure(store: StoreKey): Failure | null {
  try {
    const failure = readJson<Failure>(failureFile(store));
    return failure && typeof failure.at === "number" ? failure : null;
  } catch {
    return null;
  }
}

// Records a failed refresh, or with null that the last one worked.
export function saveFailure(store: StoreKey, failure: Failure | null) {
  if (failure) {
    writeJson(failureFile(store), failure);
  } else {
    fs.rmSync(failureFile(store), { force: true });
  }
}

// Signs out on disk: removes the session and the cached library.
export function deleteAccount(store: StoreKey) {
  fs.rmSync(storeFolder(store), { recursive: true, force: true });
}

// null when the file isn't there.
function readJson<T>(file: string): T | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  return JSON.parse(text);
}

// Writes to a temporary file and renames it over the target, so a crash
// never leaves half a file and two writers never mix their bytes (the last
// rename wins). Readable by the user only.
function writeJson(file: string, value: unknown) {
  makeFolder(path.dirname(file));
  const tmp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(value, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameOver(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function makeFolder(dir: string) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// (Windows refuses a rename over a file another program, e.g. a virus
// scanner, has open for a moment.)
function renameOver(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err: any) {
      if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(err?.code)) {
        throw err;
      }
      sleepSync(25);
    }
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A lock is given up as stale when its holder hasn't touched it for this
// long (it crashed); holders touch it every LOCK_TOUCH_MS.
export const LOCK_STALE_MS = 30 * 1000;
const LOCK_TOUCH_MS = 5 * 1000;

// How long withAccountLock waits for another process's file work: past
// LOCK_STALE_MS, so a lock a holder left behind is taken over rather than
// reported as busy. (The work itself takes milliseconds.)
export const ACCOUNT_LOCK_WAIT_MS = LOCK_STALE_MS + 5 * 1000;

// What Windows answers, for a moment, to a mkdir of a lock folder that was
// just removed (it's still delete-pending), or when a scanner has it open.
const TRANSIENT_LOCK_ERRORS = ["EPERM", "EACCES", "EBUSY"];
// How often in a row such an answer is taken as "try again" (about a
// second) before it's the folder's real error.
const TRANSIENT_LOCK_TRIES = 20;

export type ReleaseLock = () => void;

// Takes the lock named `name`, waiting up to `waitMs`; null when another
// holder (in this process or another) still has it then.
export async function acquireLock(
  name: string,
  waitMs: number,
): Promise<ReleaseLock | null> {
  const dir = path.join(locksFolder(), `${name}.lock`);
  const ownerFile = path.join(dir, "owner");
  makeFolder(locksFolder());
  const started = Date.now();
  let transientFails = 0;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") {
        if (
          TRANSIENT_LOCK_ERRORS.includes(err?.code) &&
          ++transientFails <= TRANSIENT_LOCK_TRIES
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        throw err;
      }
    }
    if (isStale(dir)) {
      removeStale(dir);
      continue;
    }
    if (Date.now() - started >= waitMs) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Which holder this is: one whose lock was taken over (it was stuck for
  // longer than LOCK_STALE_MS) must not remove its successor's.
  const owner = crypto.randomBytes(8).toString("hex");
  fs.writeFileSync(ownerFile, owner);
  const stillOurs = () => {
    try {
      return fs.readFileSync(ownerFile, "utf8") === owner;
    } catch {
      return false;
    }
  };
  const touch = setInterval(() => {
    if (stillOurs()) {
      const now = new Date();
      fs.utimes(dir, now, now, () => undefined);
    }
  }, LOCK_TOUCH_MS);
  touch.unref?.();
  let released = false;
  // Never throws: it runs in `finally` blocks, after the work is done.
  return () => {
    if (!released) {
      released = true;
      clearInterval(touch);
      if (stillOurs()) {
        try {
          // (Node retries what Windows answers while a scanner has the
          // owner file open)
          fs.rmSync(dir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 50,
          });
        } catch {
          // (left behind: it goes stale after LOCK_STALE_MS, since touching
          // stopped)
        }
      }
    }
  };
}

function isStale(dir: string) {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false; // (just released: try again)
  }
}

// Moves a stale lock aside first, so of two processes that both found it
// stale only one removes it. The other one may then move the lock the
// first just took: it puts that back.
function removeStale(dir: string) {
  const aside = `${dir}.${crypto.randomBytes(4).toString("hex")}.stale`;
  try {
    fs.renameSync(dir, aside);
  } catch {
    return; // (someone else did)
  }
  if (!isStale(aside)) {
    try {
      fs.renameSync(aside, dir);
      return;
    } catch {
      // (taken again meanwhile: the one moved aside is lost either way)
    }
  }
  fs.rmSync(aside, { recursive: true, force: true });
}

// Runs `work` (file work only, never a network request, so a wait for it is
// short) under the store's account lock.
export async function withAccountLock<T>(
  store: StoreKey,
  work: () => T | Promise<T>,
): Promise<T> {
  const release = await acquireLock(store, ACCOUNT_LOCK_WAIT_MS);
  if (!release) {
    throw new Error(
      `Another SRM has been using the saved ${STORE_NAMES[store]} account for a while; try again in a moment`,
    );
  }
  try {
    return await work();
  } finally {
    release();
  }
}

// The lock that lets one process at a time refresh a store's library,
// network requests included: two refreshes at once would both use, and
// rotate, the same refresh token. null when another refresh still holds it
// after `waitMs`.
export function lockRefresh(store: StoreKey, waitMs: number) {
  return acquireLock(`${store}.refresh`, waitMs);
}
