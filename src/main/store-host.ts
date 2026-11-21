// The store accounts' host in the Electron app (see src/lib/stores/host.ts):
// token stores' sign-ins are kept encrypted with safeStorage (DPAPI on
// Windows, the keychain on macOS, the keyring on Linux), cookie stores'
// with Chromium's cookie encryption, which uses the same key (only in a
// packaged SRM: the build turns on Electron's EnableCookieEncryption fuse).
// Requests go through Chromium's network stack (system certificates and
// proxy), and sign-ins happen in SRM's login window (store-login.ts).
import {
  app,
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
  StoreCookie,
  StoreFetch,
  StoreHost,
  StoreKey,
  StoreRequestInit,
  StoreResponse,
} from "../lib/stores";
import { loadSession } from "../lib/stores/storage";
import { openLoginWindow, readCookies } from "./store-login";

export interface ElectronStoreHostOptions {
  // SRM's window: login windows open as its children. Without it (the
  // command line) there are no login windows.
  getWindow?: () => BrowserWindow | null;
  // The app's command line keeps its Chromium data apart from the window's
  // (app.ts), so it has none of the cookie stores' partitions, and maybe
  // (Windows) not the window's safeStorage key: it refreshes only the token
  // stores whose sign-in it can read, and uses the cache for the rest.
  commandLine?: boolean;
}

// Where a store's requests go through. A cookie store's login is the
// cookies of its own partition, kept on disk (persist:) as a browser keeps
// them, encrypted in a packaged SRM (see the top of this file); a token
// store's partition only holds, in memory, what the store sets while SRM
// runs, away from SRM's own window.
export function storePartition(store: StoreKey) {
  return COOKIE_STORES.includes(store)
    ? `persist:srm-store-${store}`
    : `srm-store-${store}`;
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
      ? (store) =>
          !COOKIE_STORES.includes(store) && readableSession(store, host)
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
        ? "No keyring (such as GNOME Keyring or KWallet) is available, so store sign-ins (tokens and the EA app's, Battle.net's and Humble Bundle's cookies) are saved with Chromium's built-in key, which anyone who can read your files can undo."
        : undefined,
    openLoginWindow: options.getWindow
      ? (pending) =>
          openLoginWindow(pending, {
            parent: options.getWindow(),
            partition: loginPartition(pending.store),
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
      // (on disk now, not at Chromium's next write: SRM may be closed first)
      await ses.cookies.flushStore();
    },
    // (values included: never log them)
    cookies: (store, url) =>
      readCookies(session.fromPartition(storePartition(store)), [url]),
    clearStoreData: async (store) => {
      const ses = session.fromPartition(storePartition(store));
      await ses.clearStorageData();
      await ses.clearCache();
    },
    log: (message) => log.warn(message),
  };
  return host;
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

// How long a pasted cookie is kept. A Cookie header has no expiry, and a
// cookie set without one would be gone once SRM closes; the store says when
// the sign-in stops counting (Humble's session status then asks for a new
// one). (Chromium caps a cookie's life at 400 days.)
export const PASTED_COOKIE_LIFETIME_S = 365 * 24 * 60 * 60;

// A pasted cookie for the partition: for the whole site, over HTTPS only (a
// __Host- cookie needs both, and no domain); kept across restarts, as a
// browser keeps a sign-in; and out of reach of the pages' scripts, as the
// site sets its session cookie (SRM's own requests still send it).
export function pastedCookieDetails(
  cookie: StoreCookie,
  nowMs: number = Date.now(),
): Electron.CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "");
  return {
    url: `https://${host}/`,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain.startsWith(".") ? cookie.domain : undefined,
    path: "/",
    secure: true,
    httpOnly: true,
    expirationDate: Math.floor(nowMs / 1000) + PASTED_COOKIE_LIFETIME_S,
  };
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

// Says in the log, once at start-up, when sign-ins aren't safe at rest.
export function logSecretsWarning(host: StoreHost) {
  try {
    const warning = host.secretsWarning?.();
    if (warning) {
      log.warn(`Store accounts: ${warning}`);
    }
    if (!app.isPackaged) {
      // (the development Electron has no fuses flipped)
      log.warn(
        "Store accounts: this SRM isn't packaged, so the EA app's, Battle.net's and Humble Bundle's sign-in cookies are kept unencrypted.",
      );
    }
  } catch {
    // (only a warning)
  }
}
