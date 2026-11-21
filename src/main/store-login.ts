// SRM's window for signing in to a store: the store's own sign-in page, in a
// window of its own with no access to SRM (no preload, so no window.srm;
// sandboxed; its own browser partition). The sign-in is done when the page
// heads for one of the store's done URLs (PendingLogin.doneUrlPrefixes):
// that navigation is stopped and its URL (with the code in it) handed over,
// or, for a store whose done page holds the login (Epic's JSON), the page
// is loaded and its text handed over. Closing the window cancels.
// Ported from BoilR's login window (apps/boilr-tauri/src/accounts.rs).
import {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Session,
  WebContents,
  session,
} from "electron";
import {
  LoginCancelled,
  LoginCapture,
  PendingLogin,
  STORE_NAMES,
  StoreCookie,
  StoreKey,
} from "../lib/stores";
import { domainMatches } from "../lib/stores/http";

export interface LoginWindowOptions {
  // SRM's window, which the login window belongs to.
  parent?: BrowserWindow | null;
  partition: string;
}

// How long a loaded done page gets to be read before the sign-in goes on
// without its text.
const PAGE_TEXT_WAIT_MS = 10 * 1000;

// The login windows open now, one per store: asking again shows it.
const open = new Map<
  StoreKey,
  { window: BrowserWindow; result: Promise<LoginCapture> }
>();

export function openLoginWindow(
  pending: PendingLogin,
  options: LoginWindowOptions,
): Promise<LoginCapture> {
  const current = open.get(pending.store);
  if (current && !current.window.isDestroyed()) {
    current.window.show();
    current.window.focus();
    return current.result;
  }
  let window!: BrowserWindow;
  const result = new Promise<LoginCapture>((resolve, reject) => {
    window = runLogin(pending, options, resolve, reject);
  });
  open.set(pending.store, { window, result });
  const forget = () => {
    if (open.get(pending.store)?.result === result) {
      open.delete(pending.store);
    }
  };
  result.then(forget, forget);
  return result;
}

// The user agent of a browser: the session's own without the tokens that
// give SRM away (some sign-in pages refuse embedded browsers; Epic's stops
// after two-factor authentication with a launcher's).
export function browserUserAgent(userAgent: string) {
  return userAgent
    .replace(/\s+(Electron|steam-rom-manager)\/\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function startsWithAny(url: string, prefixes: readonly string[]) {
  return prefixes.some((prefix) => url.startsWith(prefix));
}

const isWebPage = (url: string) => /^https?:\/\//i.test(url);

// The rules of a login partition, set once per session.
const prepared = new WeakSet<Session>();

function prepare(ses: Session) {
  if (prepared.has(ses)) {
    return;
  }
  prepared.add(ses);
  // A sign-in page needs no camera, notifications or downloads.
  ses.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
}

function runLogin(
  pending: PendingLogin,
  { parent, partition }: LoginWindowOptions,
  resolve: (capture: LoginCapture) => void,
  reject: (err: Error) => void,
): BrowserWindow {
  const ses = session.fromPartition(partition);
  const temporary = !partition.startsWith("persist:");
  prepare(ses);
  ses.setUserAgent(pending.userAgent || browserUserAgent(ses.getUserAgent()));

  const webPreferences: Electron.WebPreferences = {
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
  };
  const window = new BrowserWindow({
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    width: 520,
    height: 760,
    title: `Sign in to ${STORE_NAMES[pending.store]}`,
    autoHideMenuBar: true,
    webPreferences,
  });
  window.removeMenu();
  // (the title says it's SRM's sign-in, whatever the page calls itself)
  window.on("page-title-updated", (event) => event.preventDefault());

  // The login window and the pop-ups it opened (Google or Apple sign-in).
  const ours = new Set<number>();
  // The origins those loaded pages and frames from.
  const visited = new Set<string>();
  let settled = false;
  // The done page being loaded for its text.
  let readingPage: string | undefined;
  let pageTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanUp = () => {
    clearTimeout(pageTimer);
    // (one listener per session: a cookie store's partition outlives this)
    ses.webRequest.onBeforeRequest(null);
  };
  // A cookie store's partition outlives the window: what other sites (a
  // single sign-on with Google, Steam or Apple) left there goes. Never the
  // store's own sites, so the store's requests through the partition aren't
  // disturbed.
  const sites = pending.siteDomains ?? [];
  const forgetOtherSites = () => {
    if (!temporary && sites.length) {
      dropOtherSitesData(ses, sites, visited).catch(() => undefined);
    }
  };
  const finish = async (finalUrl: string, pageText?: string) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanUp();
    let cookies: StoreCookie[] = [];
    try {
      cookies = await readCookies(ses, pending.cookieUrls);
    } catch {
      // (the store module says what it misses)
    }
    resolve({ finalUrl, pageText, cookies });
    if (!window.isDestroyed()) {
      window.destroy();
    }
    if (temporary) {
      ses.clearStorageData().catch(() => undefined);
    }
    forgetOtherSites();
  };

  // What to do with a navigation to `url`: hand a done URL over without
  // loading it ("stop"), load a done page to read it ("load"), or let it be.
  const reached = (url: string): "stop" | "load" | "go" => {
    if (settled || !startsWithAny(url, pending.doneUrlPrefixes)) {
      return "go";
    }
    if (startsWithAny(url, pending.pageTextUrlPrefixes)) {
      if (readingPage === undefined) {
        readingPage = url;
        // A page that can't be read mustn't leave the sign-in hanging: the
        // store module then does what it can with the URL.
        pageTimer = setTimeout(() => finish(url), PAGE_TEXT_WAIT_MS);
      }
      return "load";
    }
    void finish(url);
    return "stop";
  };

  // Server redirects to the done URL are caught here, before the request
  // goes out; will-redirect and will-navigate below are the fallbacks.
  ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
    const inOurs =
      details.webContentsId !== undefined && ours.has(details.webContentsId);
    if (
      inOurs &&
      (details.resourceType === "mainFrame" ||
        details.resourceType === "subFrame")
    ) {
      try {
        visited.add(new URL(details.url).origin);
      } catch {
        // (not a URL with an origin)
      }
    }
    const fromUs = inOurs && details.resourceType === "mainFrame";
    callback({ cancel: fromUs && reached(details.url) === "stop" });
  });

  const guard = (contents: WebContents) => {
    ours.add(contents.id);
    const onNavigation = (
      event: Electron.Event<{ url: string; isMainFrame: boolean }>,
    ) => {
      // Only web pages: no files, no launchers' links.
      if (!isWebPage(event.url)) {
        event.preventDefault();
        return;
      }
      if (event.isMainFrame && reached(event.url) === "stop") {
        event.preventDefault();
      }
    };
    contents.on("will-navigate", onNavigation);
    contents.on("will-redirect", onNavigation);
    // Pop-ups (single sign-on with Google or Apple) open as windows of the
    // same partition, as unprivileged as this one.
    contents.setWindowOpenHandler(({ url }) =>
      isWebPage(url)
        ? { action: "allow", overrideBrowserWindowOptions: popup() }
        : { action: "deny" },
    );
    contents.on("did-create-window", (child) => {
      child.removeMenu();
      guard(child.webContents);
    });
  };
  const popup = (): BrowserWindowConstructorOptions => ({
    parent: window,
    width: 500,
    height: 700,
    autoHideMenuBar: true,
    webPreferences,
  });
  guard(window.webContents);

  window.webContents.on("did-finish-load", async () => {
    const url = window.webContents.getURL();
    if (
      settled ||
      readingPage === undefined ||
      !startsWithAny(url, pending.pageTextUrlPrefixes)
    ) {
      return;
    }
    const page = readingPage;
    try {
      const text = await window.webContents.executeJavaScript(
        "document.body ? document.body.innerText : ''",
      );
      await finish(page, typeof text === "string" ? text : undefined);
    } catch {
      await finish(page);
    }
  });

  window.on("closed", () => {
    if (!settled) {
      settled = true;
      cleanUp();
      reject(new LoginCancelled("Sign-in window closed"));
      // (a sign-in with Google or Steam may have finished in a pop-up
      // first)
      forgetOtherSites();
    }
  });

  window.loadURL(pending.startUrl).catch(() => {
    // (the window shows Chromium's error page; closing it cancels)
  });
  return window;
}

// Whether a cookie for `cookieDomain` belongs to one of `sites` (registrable
// domains such as "ea.com": the site and every host under it).
export function isSiteCookie(cookieDomain: string, sites: readonly string[]) {
  const host = cookieDomain.replace(/^\.+/, "");
  return host !== "" && sites.some((site) => domainMatches(site, host));
}

// The storage kinds a page keeps besides cookies.
const PAGE_STORAGES: Electron.ClearStorageDataOptions["storages"] = [
  "localstorage",
  "indexdb",
  "serviceworkers",
  "cachestorage",
  "filesystem",
];

// Removes from `ses` every cookie that isn't one of `sites`', and what the
// `visited` origins outside them stored in the pages' storage. (Names and
// values are never logged.)
export async function dropOtherSitesData(
  ses: Pick<Session, "cookies" | "clearStorageData">,
  sites: readonly string[],
  visited: Iterable<string>,
) {
  for (const cookie of await ses.cookies.get({})) {
    const domain = cookie.domain ?? "";
    if (isSiteCookie(domain, sites)) {
      continue;
    }
    const host = domain.replace(/^\.+/, "");
    if (host === "") {
      continue;
    }
    try {
      await ses.cookies.remove(
        `http${cookie.secure ? "s" : ""}://${host}${cookie.path ?? "/"}`,
        cookie.name,
      );
    } catch {
      // (the next one)
    }
  }
  for (const origin of visited) {
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      continue;
    }
    if (isSiteCookie(hostname, sites)) {
      continue;
    }
    try {
      await ses.clearStorageData({ origin, storages: PAGE_STORAGES });
    } catch {
      // (the next one)
    }
  }
  await ses.cookies.flushStore();
}

// The cookies `ses` sends to `urls`, values included (secret: never log
// them), one per name and domain.
export async function readCookies(
  ses: Session,
  urls: readonly string[],
): Promise<StoreCookie[]> {
  const cookies = new Map<string, StoreCookie>();
  for (const url of urls) {
    const host = new URL(url).hostname;
    for (const cookie of await ses.cookies.get({ url })) {
      const domain = cookie.domain || host;
      cookies.set(`${domain}\n${cookie.name}`, {
        name: cookie.name,
        value: cookie.value,
        domain,
      });
    }
  }
  return [...cookies.values()];
}
