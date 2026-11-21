// The store accounts' host in the Electron app (see src/lib/stores/host.ts):
// sign-ins are kept encrypted with safeStorage (DPAPI on Windows, the
// keychain on macOS, the keyring on Linux), the cookie stores' too: their
// partitions are in memory only, and their cookies are saved with the
// session (src/lib/stores/refresh.ts). Chromium's own cookie store is left
// as it is, so SRM touches the OS key only for store accounts. Requests go
// through Chromium's network stack (system certificates and proxy), and
// sign-ins happen in SRM's login window (store-login.ts).
import {
  BrowserWindow,
  net,
  safeStorage,
  session,
  shell,
  Session,
} from "electron";
import * as crypto from "crypto";
import * as log from "electron-log";
import {
  COOKIE_STORES,
  STORE_KEYS,
  SavedCookie,
  StoreCookie,
  StoreFetch,
  StoreHost,
  StoreKey,
  StoreRequestInit,
  StoreResponse,
  readSessionInfo,
} from "../lib/stores";
import { isSiteCookie } from "../lib/stores/http";
import { loadSession } from "../lib/stores/storage";
import { openLoginWindow, readCookies } from "./store-login";

export interface ElectronStoreHostOptions {
  // SRM's window: login windows open as its children. Without it (the
  // command line) there are no login windows.
  getWindow?: () => BrowserWindow | null;
  // The app's command line may not have the window's safeStorage key
  // (Windows): it refreshes the stores whose sign-in it can read, and uses
  // the cache for the rest. (A cookie store's partition starts empty there,
  // as after a restart: the saved cookies are put back first.)
  commandLine?: boolean;
}

// Where a store's requests go through: a partition of its own, in memory
// only, away from SRM's own window, so Chromium writes none of it to disk. A
// cookie store's login is the cookies there, saved encrypted with the
// session and put back after a restart (exportCookies, importCookies); a
// token store's partition only holds what the store sets while SRM runs.
export function storePartition(store: StoreKey) {
  return `srm-store-${store}`;
}

// A login window's partition: the cookie store's own (its cookies are the
// login), or a fresh one in memory per sign-in, like a private window, so
// nothing of an earlier sign-in carries over.
function loginPartition(store: StoreKey) {
  return COOKIE_STORES.includes(store)
    ? storePartition(store)
    : `srm-login-${store}-${crypto.randomBytes(6).toString("hex")}`;
}

// (marks what this host encrypted)
const PROTECTED_PREFIX = "safeStorage:";

function encryption() {
  if (!safeStorage.isEncryptionAvailable() && process.platform === "linux") {
    // No keyring: Chromium's built-in key ("basic_text"), which
    // secretsWarning() tells the user about.
    safeStorage.setUsePlainTextEncryption(true);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("This system offers SRM no way to keep sign-ins safe.");
  }
  return safeStorage;
}

export function electronStoreHost(
  options: ElectronStoreHostOptions = {},
): StoreHost {
  const host: StoreHost = {
    canRefresh: true,
    refreshes: options.commandLine
      ? (store) => readableSession(store, host)
      : undefined,
    fetchFor: (store) =>
      requestThrough(session.fromPartition(storePartition(store))),
    protect: (plain) =>
      PROTECTED_PREFIX + encryption().encryptString(plain).toString("base64"),
    unprotect: (text) => {
      if (!text.startsWith(PROTECTED_PREFIX)) {
        throw new Error("it wasn't saved by this SRM");
      }
      return encryption().decryptString(
        Buffer.from(text.slice(PROTECTED_PREFIX.length), "base64"),
      );
    },
    secretsWarning: () =>
      process.platform === "linux" &&
      safeStorage.getSelectedStorageBackend() === "basic_text"
        ? "No keyring (such as GNOME Keyring or KWallet) is available, so store sign-ins are encrypted with a fixed key that is the same in every copy of SRM: anyone who can read your files can decrypt them."
        : undefined,
    openLoginWindow: options.getWindow
      ? (pending) =>
          openLoginWindow(pending, {
            parent: options.getWindow(),
            partition: loginPartition(pending.store),
            temporary: !COOKIE_STORES.includes(pending.store),
          })
      : undefined,
    openExternal: async (url) => {
      // (a store's page; never a file or another program's link)
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`Not a web page: ${url}`);
      }
      await shell.openExternal(url);
    },
    setCookies: async (store, cookies) => {
      const ses = session.fromPartition(storePartition(store));
      for (const cookie of cookies) {
        await ses.cookies.set(pastedCookieDetails(cookie));
      }
    },
    // (values included: never log them)
    cookies: (store, url) =>
      readCookies(session.fromPartition(storePartition(store)), [url]),
    clearStoreData: async (store) => {
      const ses = session.fromPartition(storePartition(store));
      await ses.clearStorageData();
      await ses.clearCache();
    },
    exportCookies: (store, sites) =>
      exportCookies(session.fromPartition(storePartition(store)), sites),
    importCookies: (store, cookies) =>
      importCookies(session.fromPartition(storePartition(store)), cookies),
    log: (message) => log.warn(message),
  };
  return host;
}

// The cookies of `sites` in `ses`, as saved cookies. (Values included: never
// log them.)
export async function exportCookies(
  ses: Pick<Session, "cookies">,
  sites: readonly string[],
): Promise<SavedCookie[]> {
  return (await ses.cookies.get({}))
    .filter((cookie) => isSiteCookie(cookie.domain ?? "", sites))
    .map(savedCookie);
}

// Replaces the cookies of `ses` with saved ones, but those that have
// expired. A cookie Chromium doesn't take is left out: the store's answer
// then says whether the sign-in still works without it.
export async function importCookies(
  ses: Pick<Session, "cookies" | "clearStorageData">,
  cookies: readonly SavedCookie[],
  nowMs: number = Date.now(),
) {
  await ses.clearStorageData({ storages: ["cookies"] });
  let refused = 0;
  for (const cookie of cookies) {
    if (isExpired(cookie, nowMs)) {
      continue;
    }
    try {
      await ses.cookies.set(cookieDetails(cookie));
    } catch {
      refused++;
    }
  }
  if (refused > 0) {
    log.warn(
      `Store accounts: ${refused} saved cookie(s) could not be restored`,
    );
  }
}

export function isExpired(cookie: SavedCookie, nowMs: number) {
  return (
    cookie.expirationDate !== undefined && cookie.expirationDate * 1000 <= nowMs
  );
}

// A cookie of a partition as it's saved: a session cookie without an
// expiry.
export function savedCookie(cookie: Electron.Cookie): SavedCookie {
  const saved: SavedCookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    hostOnly: !!cookie.hostOnly,
    path: cookie.path || "/",
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    sameSite: cookie.sameSite ?? "unspecified",
  };
  if (!cookie.session && typeof cookie.expirationDate === "number") {
    saved.expirationDate = cookie.expirationDate;
  }
  return saved;
}

// What puts a saved cookie back as the site set it: a host-only cookie
// without a domain (for that host only), a domain cookie with its domain
// (for every host under it); a session cookie without an expiry. (Over
// HTTPS: a secure cookie can't be set for an http:// URL.)
export function cookieDetails(cookie: SavedCookie): Electron.CookiesSetDetails {
  const host = cookie.domain.replace(/^\.+/, "");
  const path = cookie.path.startsWith("/") ? cookie.path : "/";
  const details: Electron.CookiesSetDetails = {
    url: `https://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  };
  if (!cookie.hostOnly) {
    details.domain = cookie.domain;
  }
  if (cookie.expirationDate !== undefined) {
    details.expirationDate = cookie.expirationDate;
  }
  return details;
}

// Whether this host can read the store's saved sign-in (the command line may
// not: on Windows its safeStorage key can differ from the window's). When it
// can't, the library is left to the app instead of being reported as a
// sign-in to redo.
function readableSession(store: StoreKey, host: StoreHost) {
  try {
    return !!loadSession(store, host);
  } catch {
    return false;
  }
}

// A pasted cookie for the partition: for the whole site (a domain cookie,
// unless its domain is a host: a __Host- cookie has no domain), over HTTPS
// only, and out of reach of the pages' scripts, as the site sets its session
// cookie (SRM's own requests still send it). A Cookie header has no expiry:
// a session cookie, saved with the sign-in like the partition's others, and
// kept until the store stops taking it (Humble's session status then asks
// for a new sign-in).
export function pastedCookieDetails(
  cookie: StoreCookie,
): Electron.CookiesSetDetails {
  return cookieDetails({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: !cookie.domain.startsWith("."),
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
}

// A fetch through `ses`, with what the stores need and net.fetch doesn't
// give: the URL a request ended up at after redirects (GOG answers a dead
// token with a redirect to its sign-in page; net.fetch's response.url is
// empty). Cookies are the partition's: sent, and kept when set, unless the
// request says "omit".
export function requestThrough(ses: Session): StoreFetch {
  return (url: string, init: StoreRequestInit = {}) =>
    new Promise<StoreResponse>((resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) {
        reject(aborted(signal));
        return;
      }
      let finalUrl = url;
      const request = net.request({
        method: init.method || "GET",
        url,
        session: ses,
        credentials: init.credentials ?? "include",
        redirect: "follow",
      });
      const onAbort = () => {
        request.abort();
        reject(aborted(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => signal?.removeEventListener("abort", onAbort);
      for (const [name, value] of Object.entries(init.headers || {})) {
        request.setHeader(name, value);
      }
      request.on("redirect", (_status, _method, redirectUrl) => {
        finalUrl = redirectUrl;
        request.followRedirect();
      });
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        const body = new Promise<string>((bodyDone, bodyFailed) => {
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            done();
            bodyDone(Buffer.concat(chunks).toString("utf8"));
          });
          response.on("aborted", () => {
            done();
            bodyFailed(
              signal?.aborted
                ? aborted(signal)
                : new Error("The answer was cut off"),
            );
          });
          response.on("error", (err: Error) => {
            done();
            bodyFailed(err);
          });
        });
        // (read through text(); a body nobody reads mustn't be an
        // unhandled rejection)
        body.catch(() => undefined);
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          headers[name.toLowerCase()] = Array.isArray(value)
            ? value.join(", ")
            : String(value);
        }
        resolve({
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          url: finalUrl,
          headers: { get: (name) => headers[name.toLowerCase()] ?? null },
          text: () => body,
        });
      });
      request.on("error", (err) => {
        done();
        reject(err);
      });
      if (init.body !== undefined) {
        request.write(init.body);
      }
      request.end();
    });
}

function aborted(signal: AbortSignal | undefined) {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new Error("The request was stopped");
}

// Says in the log, once at start-up, when sign-ins aren't safe at rest. Only
// when there is a sign-in: SRM asks nothing of the OS's secret storage (a
// keyring may ask the user to unlock it) for someone who uses no store
// account.
export function logSecretsWarning(host: StoreHost) {
  try {
    if (!STORE_KEYS.some(hasSession)) {
      return;
    }
    const warning = host.secretsWarning?.();
    if (warning) {
      log.warn(`Store accounts: ${warning}`);
    }
  } catch {
    // (only a warning)
  }
}

function hasSession(store: StoreKey) {
  try {
    return !!readSessionInfo(store);
  } catch {
    return true; // (there, if damaged)
  }
}
