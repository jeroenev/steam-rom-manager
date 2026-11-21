// Humble Bundle: the DRM-free games in the account's library (bundles,
// store purchases, Humble Choice games), installed or not. Ported from
// BoilR's humble.rs, which follows Playnite's HumbleLibrary, and moved to the
// site Humble Bundle launched in November 2026, where neither BoilR's nor
// Playnite's way works any more.
//
// What changed (looked at on 2026-11-21 with GET requests only; the sign-in
// BoilR had saved no longer counts, so no signed-in answer has been seen):
// - The site is a Next.js app. api/v1/user/order, api/v1/orders,
//   api/v1/order/<key> and /login answer 404, the old App Engine host's API
//   403, and the library page has no user-home-json-data in it.
// - Sign-in moved to Ory, on auth.humblebundle.com. The site's own session
//   status (api/auth/session-status) calls the _simpleauth_sess cookie that
//   BoilR last listed the library with, on 2026-11-11, "anonymous".
// - The library page lists the purchases with a server action
//   (filterUserLibrary), page by page. The action's id is in the page's
//   scripts and changes with releases of the site, so SRM looks it up there,
//   and keeps it until the site no longer takes it. The shape of its answer
//   is the one the page's code reads and its own mock data has: items with
//   their keys and downloads (entitlements). A bundle shows as a group
//   (itemType entitlement-group) without entitlements; its games are taken
//   to be items of their own, as the page's Purchased tab lists every
//   product.
//
// Login: the window opens Ory's sign-in for browsers, with return_to set to
// the library page; heading there ends the sign-in. The login is the cookies
// Ory sets in Humble's browser partition, which sends them and keeps what
// Humble renews, as a browser would. The partition is in memory: refresh.ts
// saves its humblebundle.com cookies with the session, encrypted, and puts
// them back after a restart. Nothing secret is in this module's own session
// data. Without the window, the user pastes the Cookie header of a
// signed-in request from their own browser, which goes into the partition
// (StoreContext.setCookies).
//
// Library: the session status first (signed out asks to sign in again), then
// every page of filterUserLibrary, asked for as the library page asks (newest
// first, nothing hidden), in larger pages.
//
// Listing rules, from BoilR (Playnite's defaults):
// - a download entitlement counts as a game when it has a Windows or a Linux
//   download: SRM's targets run those (Linux runs Windows games through
//   Proton). Mac-only games, Android apps, books and soundtracks are not
//   listed;
// - one whose library item also holds a third-party key (Steam, Epic, ...)
//   named for it is skipped, as it shows up in that store's library
//   (Playnite's IgnoreThirdPartyStoreGames). Products that are only keys
//   have no download and are skipped anyway;
// - Humble's Vault (formerly Trove) isn't listed: it isn't in the purchases.
//
// OwnedGame.id is the download entitlement's id, which the site calls the
// subproduct id (the old API's machine_name, where an answer has one). A
// title the account has in several purchases is listed once, and keeps the
// id it was first listed with (listedCopy). extra:
// - `url`: the item's page in the library, where the user downloads it.

import {
  BROWSER_USER_AGENT,
  HttpStatus,
  cleanTitle,
  domainMatches,
  loginRejected,
  messageOf,
  paginate,
  readText,
  snippet,
  statusOf,
  withoutQuery,
  wrapErr,
} from "./http";
import { StoreResponse } from "./host";
import {
  FlightServerError,
  flightField,
  parseFlightRows,
} from "./humble-flight";
import { sessionData } from "./storage";
import {
  ListContext,
  ListResult,
  LoginCapture,
  OwnedGame,
  PendingLogin,
  StoreClient,
  StoreContext,
  StoreCookie,
  StoreSession,
  ownedGame,
} from "./types";

const SITE = "https://www.humblebundle.com";
const SITE_HOST = "www.humblebundle.com";
// Ory's host: the sign-in pages.
const AUTH_HOST = "auth.humblebundle.com";
export const LIBRARY_URL = `${SITE}/home/library`;
// What the site's pages ask every minute: {"status":"anonymous"} when
// signed out.
export const SESSION_STATUS_URL = `${SITE}/api/auth/session-status`;
// Ory's sign-in for browsers, which sends the browser to return_to once the
// user is signed in (at once when they already are). The library page sends
// a signed-out visitor to exactly this address (/home/purchases to the
// same, with itself as return_to).
export const LOGIN_URL = `https://${AUTH_HOST}/self-service/login/browser?return_to=${encodeURIComponent(LIBRARY_URL)}`;
// Only the library page ends the login: the sign-in pages are on AUTH_HOST.
export const DONE_PREFIX = LIBRARY_URL;
const COOKIE_URLS = [`${SITE}/`, `https://${AUTH_HOST}/`];
// Where a pasted cookie goes: every humblebundle.com host, as a session
// cookie that Ory sets on its host must, to reach the site.
const COOKIE_DOMAIN = ".humblebundle.com";

// The server action that lists the library, as the page's scripts name it.
export const LIBRARY_ACTION = "filterUserLibrary";
// Items per page. The library page asks for 5; when Humble refuses this
// many, SRM asks as the page does.
export const PAGE_SIZE = 50;
export const SITE_PAGE_SIZE = 5;
// More pages than this is a site that keeps reporting more: an error, not
// the end of the library.
const MAX_PAGES = 2000;
// The boundary of the action's form. Only SRM's own fields go in, and none
// of them can hold it.
export const FORM_BOUNDARY = "----srm-humble-library-form";

// Download platforms that make a download entitlement a game SRM can
// launch: Windows, and Linux (natively, or the Windows download through
// Proton). Not `mac`.
const GAME_PLATFORMS = ["windows", "linux"];

// Error codes of a failed action that mean the site doesn't take the
// sign-in (the site's own: UNAUTHORIZED, SESSION_EXPIRED, ...).
const SIGNED_OUT_CODES = [
  "UNAUTHORIZED",
  "UNAUTHENTICATED",
  "NOT_AUTHENTICATED",
  "SESSION_EXPIRED",
  "FAILED_TO_GET_SESSION",
  "INVALID_TOKEN",
  "AUTH_FAILED",
  "LOGIN_REQUIRED",
];

// What SRM keeps for a Humble account. The login itself is the cookies in
// Humble's browser partition, which are saved beside this (refresh.ts);
// none of them are in here.
export interface HumbleSession {
  // When the sign-in finished, in milliseconds since 1970.
  signedInAt: number;
  // The id of the library action, as last found in the library page's
  // scripts (public, not a secret).
  libraryActionId?: string;
}

// One page of the library, as filterUserLibrary answers it.
export interface LibraryPage {
  items: LibraryItem[];
  // 0 when Humble doesn't say.
  totalPages: number;
  totalDocs: number;
}

// One item of the library: a product the account got with a purchase, with
// what came with it.
export interface LibraryItem {
  id: string;
  // Where the item's page is: /home/library/<pageId>.
  pageId: string;
  title: string;
  // Third-party keys (Steam, Epic, ...).
  keys: Entitlement[];
  // DRM-free downloads.
  downloads: Entitlement[];
}

export interface Entitlement {
  id: string;
  title: string;
  // The platforms of its downloads (windows, mac, linux, android, ebook,
  // audio, ...).
  platforms: string[];
}

// A copy of a title: the id of the download entitlement, and the page of
// the item it came with.
export interface TitleCopy {
  id: string;
  pageId: string;
}

// The site refused to list the library, for a reason other than the
// sign-in.
export class ActionRefused extends Error {
  name = "ActionRefused";
  constructor(readonly code: string) {
    super(
      `Humble Bundle refused to list the library${code ? ` (${code})` : ""}`,
    );
  }
}

export function beginLogin(): PendingLogin {
  return {
    store: "humble",
    startUrl: LOGIN_URL,
    doneUrlPrefixes: [DONE_PREFIX],
    pageTextUrlPrefixes: [],
    cookieUrls: [...COOKIE_URLS],
    siteDomains: ["humblebundle.com"],
    manual: {
      kind: "paste",
      url: LOGIN_URL,
      instructions:
        "Sign in to humblebundle.com in your browser and open your library. Then open the developer tools (F12), go to Network, reload the page, select the request for library, and copy the value of its Cookie request header. Paste it here. It is your login, so do not share it.",
      placeholder: "Cookie header of www.humblebundle.com",
    },
    // The one every request sends (StoreHttp): Cloudflare, in front of the
    // site, ties what it hands the window to its user agent.
    userAgent: BROWSER_USER_AGENT,
    state: {},
  };
}

async function completeLogin(
  _pending: PendingLogin,
  capture: LoginCapture,
  ctx: StoreContext,
): Promise<StoreSession> {
  if (capture.cookies === undefined && capture.pasted !== undefined) {
    const cookies = parsePastedCookies(capture.pasted);
    // (a host without Humble's browser partition: only the window signs in)
    if (!ctx.setCookies) {
      throw new Error(
        "This SRM can't take a pasted Humble Bundle sign-in. Sign in with SRM's sign-in window instead.",
      );
    }
    await ctx.setCookies(cookies);
  } else if (!(capture.cookies ?? []).some(isHumbleCookie)) {
    // (only checked: the partition the window signed in in sends them)
    throw new Error(
      "The Humble Bundle sign-in window handed over no humblebundle.com cookies, so the sign-in did not finish. Try signing in again.",
    );
  }
  try {
    await requireSignedIn(ctx);
  } catch (err) {
    throw wrapErr(err, "Signing in to Humble Bundle did not finish");
  }
  const data: HumbleSession = { signedInAt: ctx.now() };
  return { accountName: null, data };
}

function readSession(session: StoreSession) {
  return sessionData<HumbleSession>(
    "humble",
    session,
    (data) =>
      typeof data.signedInAt === "number" &&
      (data.libraryActionId === undefined ||
        typeof data.libraryActionId === "string"),
  );
}

async function listLibrary(
  session: StoreSession,
  ctx: ListContext,
): Promise<ListResult> {
  let humble = readSession(session);
  // A newly found action id is kept also when a later page fails.
  const remember = (actionId: string) => {
    if (humble.libraryActionId !== actionId) {
      humble = { ...humble, libraryActionId: actionId };
      session.data = humble;
    }
  };
  try {
    await requireSignedIn(ctx);
    const items = await fetchLibrary(ctx, humble.libraryActionId, remember);
    return { games: ownedGames(items, ctx.previous) };
  } catch (err) {
    throw wrapErr(err, "Could not list the Humble Bundle library");
  }
}

// Fails with a refused login when Humble's session status says the
// partition's sign-in is signed out. An answer that isn't a session status
// (the endpoint gone) is left to the library to tell.
async function requireSignedIn(ctx: StoreContext) {
  let response: StoreResponse;
  try {
    response = await ctx.http.send(SESSION_STATUS_URL, {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (statusOf(err) === 404) {
      return;
    }
    throw err;
  }
  if (sessionStatus(response.url, await readText(response)) === "anonymous") {
    throw notSignedIn();
  }
}

// The answer of the session status: "anonymous" when signed out (or sent to
// the sign-in), "signed-in" for any other status, "unknown" for an answer
// that isn't a session status.
export function sessionStatus(
  finalUrl: string,
  body: string,
): "anonymous" | "signed-in" | "unknown" {
  if (isSignInPage(finalUrl)) {
    return "anonymous";
  }
  let answer: any;
  try {
    answer = JSON.parse(body);
  } catch {
    return "unknown";
  }
  const status = answer?.status;
  if (typeof status !== "string" || status === "") {
    return "unknown";
  }
  return status === "anonymous" ? "anonymous" : "signed-in";
}

function notSignedIn() {
  return loginRejected(
    "Humble Bundle did not accept the saved login. Sign in again.",
  );
}

// Every item of the library. `actionId` is the library action's id from the
// last time, if any; `remember` gets the one Humble took.
async function fetchLibrary(
  ctx: StoreContext,
  actionId: string | undefined,
  remember: (actionId: string) => void,
): Promise<LibraryItem[]> {
  const action = new LibraryAction(ctx, actionId, remember);
  let pageSize = PAGE_SIZE;
  let first: LibraryPage;
  try {
    first = await action.page(1, pageSize);
  } catch (err) {
    // Humble may refuse pages as large as SRM's: then as its own page asks.
    if (!(err instanceof ActionRefused)) {
      throw err;
    }
    pageSize = SITE_PAGE_SIZE;
    first = await action.page(1, pageSize);
  }
  let totalDocs = 0;
  const items = await paginate(
    "Humble Bundle's library",
    1,
    MAX_PAGES,
    async (page: number) => {
      const answer = page === 1 ? first : await action.page(page, pageSize);
      totalDocs = answer.totalDocs;
      return [answer.items, nextPage(answer, page)];
    },
  );
  return completeItems(items, totalDocs);
}

// The library action, with its id: the one from the last time, or else the
// one in the library page's scripts. An id the site no longer knows (a new
// release of the site) is looked up again, once.
class LibraryAction {
  private lookedUp = false;

  constructor(
    private ctx: StoreContext,
    private id: string | undefined,
    private remember: (actionId: string) => void,
  ) {}

  async page(page: number, pageSize: number): Promise<LibraryPage> {
    for (;;) {
      if (this.id === undefined) {
        this.id = await findLibraryAction(this.ctx);
        this.lookedUp = true;
      }
      const answer = await requestLibraryPage(
        this.ctx,
        this.id,
        page,
        pageSize,
      );
      if (answer !== "unknown action") {
        this.remember(this.id);
        return answer;
      }
      if (this.lookedUp) {
        throw new Error(
          `Humble Bundle does not take the ${LIBRARY_ACTION} action of its own library page. SRM needs an update.`,
        );
      }
      this.id = undefined;
    }
  }
}

// One page of the library: the library action, called as the library page
// calls it (a POST to the page, with the action's id). The Origin is the
// one the page's own request has: Next.js turns down an action whose Origin
// isn't the site's (Electron's requests have none of their own).
async function requestLibraryPage(
  ctx: StoreContext,
  actionId: string,
  page: number,
  pageSize: number,
): Promise<LibraryPage | "unknown action"> {
  const response = await ctx.http.request(LIBRARY_URL, {
    method: "POST",
    headers: {
      Accept: "text/x-component",
      Origin: SITE,
      "Next-Action": actionId,
      "Content-Type": `multipart/form-data; boundary=${FORM_BOUNDARY}`,
    },
    body: libraryActionBody(page, pageSize),
  });
  return readLibraryAnswer(response);
}

// The answer to the library action: a page, "unknown action" when the site
// doesn't know the action's id (Next.js's x-nextjs-action-not-found), or an
// error (a bounce to the sign-in is a refused login).
export async function readLibraryAnswer(
  response: StoreResponse,
): Promise<LibraryPage | "unknown action"> {
  if (isSignInPage(response.url)) {
    throw notSignedIn();
  }
  if (response.headers.get("x-nextjs-action-not-found") === "1") {
    return "unknown action";
  }
  // (an action that redirects answers with this header, not a Location)
  const redirect = response.headers.get("x-action-redirect");
  if (redirect) {
    let target: string;
    try {
      target = new URL(redirect.split(";")[0], LIBRARY_URL).toString();
    } catch {
      target = redirect;
    }
    if (isSignInPage(target)) {
      throw notSignedIn();
    }
    throw new Error(
      `Humble Bundle sent the library request on to ${withoutQuery(target)} instead of answering it`,
    );
  }
  const body = await readText(response);
  if (!response.ok) {
    if (response.status === 404 && /server action not found/i.test(body)) {
      return "unknown action";
    }
    throw new HttpStatus(
      response.status,
      withoutQuery(response.url),
      snippet(body),
    );
  }
  return parseLibraryAnswer(response.url, body);
}

// Reads the library action's answer (React Flight, see humble-flight.ts):
// row 0 holds the action's result in `a`, which is
// {success, results, pagination: {page, totalPages, totalDocs}}, or
// {success: false, error: <code>}. Only `a` is read (see flightField).
// `finalUrl` is where the request ended up after redirects.
export function parseLibraryAnswer(
  finalUrl: string,
  body: string,
): LibraryPage {
  if (body.trimStart().startsWith("<")) {
    if (isSignInPage(finalUrl)) {
      throw notSignedIn();
    }
    throw new Error(
      `Unexpected answer from Humble Bundle: a web page from ${withoutQuery(finalUrl)} instead of the library. Body starts with: ${snippet(body)}`,
    );
  }
  const unexpected = (detail: string) =>
    new Error(
      `Unexpected answer from Humble Bundle instead of the library: ${detail}. Body starts with: ${snippet(body)}`,
    );
  let result: any;
  try {
    result = flightField(parseFlightRows(body), 0, "a");
  } catch (err) {
    if (err instanceof FlightServerError) {
      throw new Error(
        `Humble Bundle could not list the library: ${err.message}`,
      );
    }
    throw unexpected(messageOf(err));
  }
  if (!result || typeof result !== "object") {
    throw unexpected("no result of the library action in it");
  }
  if (result.success === false) {
    const code = typeof result.error === "string" ? result.error : "";
    if (SIGNED_OUT_CODES.includes(code.toUpperCase())) {
      throw notSignedIn();
    }
    throw new ActionRefused(code);
  }
  // (results is required: an answer without it isn't a page of the library,
  // and must not be read as an empty one)
  if (!Array.isArray(result.results)) {
    throw unexpected("missing field `results`");
  }
  const pagination = result.pagination ?? {};
  return {
    items: result.results.map(parseItem),
    totalPages: count(pagination.totalPages),
    totalDocs: count(pagination.totalDocs),
  };
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

// An item of the answer. Like BoilR's (serde defaults), a missing or null
// field reads as empty, and so does a null item: it lists nothing, but
// still counts as one of the library's entries (completeItems).
function parseItem(raw: any): LibraryItem {
  if (!raw || typeof raw !== "object") {
    return { id: "", pageId: "", title: "", keys: [], downloads: [] };
  }
  const id = text(raw.id);
  return {
    id,
    pageId: text(raw.productEntitlementId) || id,
    title: text(raw.title),
    keys: list(raw.entitlements?.keys).map(parseEntitlement),
    downloads: list(raw.entitlements?.downloads).map(parseEntitlement),
  };
}

function parseEntitlement(raw: any): Entitlement {
  return {
    // (the old API's machine_name, under either spelling, where the answer
    // has one: the id BoilR listed the game with)
    id: text(raw?.machineName) || text(raw?.machine_name) || text(raw?.id),
    title: text(raw?.title),
    platforms: list(raw?.downloads)
      .map((download: any) => text(download?.platform))
      .filter((platform: string) => platform !== ""),
  };
}

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : "";
}

function list(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

// The page to ask for after page `current`, or null after the last one. An
// empty page always ends the list; while Humble doesn't say how many pages
// there are, the next is asked for until an empty one comes.
export function nextPage(page: LibraryPage, current: number): number | null {
  if (page.items.length === 0) {
    return null;
  }
  return page.totalPages === 0 || current < page.totalPages
    ? current + 1
    : null;
}

// The items of all pages, without repeats (an item that moved on to the next
// page while the pages were fetched). Pages that held fewer entries than the
// library said it has are a list cut short, not a library: the games it
// lacks would leave Steam.
export function completeItems(
  items: readonly LibraryItem[],
  totalDocs: number,
): LibraryItem[] {
  if (items.length < totalDocs) {
    throw new Error(
      `Humble Bundle listed ${items.length} of the ${totalDocs} items in the library, so the list is incomplete and was not saved`,
    );
  }
  const seen = new Set<string>();
  const unique: LibraryItem[] = [];
  for (const item of items) {
    if (item.id !== "") {
      if (seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
    }
    unique.push(item);
  }
  return unique;
}

// The form the library page sends the action, in the encoding of React's
// encodeReply: the form's fields under "1_", and in "0" the action's
// arguments, the list's state before (empty, as on the page's first call)
// and a reference to the form. The fields are the page's own, with nothing
// filtered or hidden: newest first, revealed keys and expired items
// included.
export function libraryActionBody(page: number, pageSize: number): string {
  const form: [string, string][] = [
    ["requestId", String(page)],
    ["query", ""],
    ["sort", "mostRecent"],
    ["cursor", String(pageSize * page)],
    ["page", String(page)],
    ["limit", String(pageSize)],
    ["hideRevealed", "false"],
    ["hideExpired", "false"],
    ["dateExpires", ""],
  ];
  const emptyList = {
    results: [] as unknown[],
    pagination: { page: 1, totalPages: 1, totalDocs: 0 },
    success: true,
  };
  const fields = [
    ...form.map(([name, value]) => [`1_${name}`, value]),
    ["0", JSON.stringify([emptyList, "$K1"])],
  ];
  return (
    fields
      .map(
        ([name, value]) =>
          `--${FORM_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join("") + `--${FORM_BOUNDARY}--\r\n`
  );
}

// Looks the library action up: the library page, then its scripts from the
// last (the page's own come after the ones every page shares) until one
// names the action.
async function findLibraryAction(ctx: StoreContext): Promise<string> {
  const response = await ctx.http.send(LIBRARY_URL, {
    headers: { Accept: "text/html" },
  });
  if (isSignInPage(response.url)) {
    throw notSignedIn();
  }
  const html = await readText(response);
  const redirect = pageRedirect(html, response.url);
  if (redirect !== undefined && isSignInPage(redirect)) {
    throw notSignedIn();
  }
  const scripts = pageScripts(html, response.url);
  for (const script of [...scripts].reverse()) {
    const id = actionIdIn(
      await readText(await ctx.http.send(script)),
      LIBRARY_ACTION,
    );
    if (id) {
      return id;
    }
  }
  throw new Error(
    `Humble Bundle's library page no longer lists the games the way SRM knows: none of its ${scripts.length} scripts has the ${LIBRARY_ACTION} action. SRM needs an update.`,
  );
}

// The site's scripts a page loads (<script src> and <link rel=preload
// as=script>), in the page's order, as full URLs. Only the site's own
// Next.js scripts: nothing else can hold its actions.
export function pageScripts(html: string, pageUrl: string): string[] {
  const scripts: string[] = [];
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const isScript = /^<script/i.test(tag);
    if (
      !isScript &&
      !(
        /^preload$/i.test(attribute(tag, "rel") ?? "") &&
        /^script$/i.test(attribute(tag, "as") ?? "")
      )
    ) {
      continue;
    }
    const src = attribute(tag, isScript ? "src" : "href");
    if (!src) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(src.replace(/&amp;/g, "&"), pageUrl);
    } catch {
      continue;
    }
    if (
      url.origin === SITE &&
      url.pathname.startsWith("/_next/static/") &&
      url.pathname.endsWith(".js") &&
      !scripts.includes(url.toString())
    ) {
      scripts.push(url.toString());
    }
  }
  return scripts;
}

// Where a page sends the browser on with a meta refresh. That is how a
// Next.js page redirects once it has started to answer (status 200): the
// library page sends a signed-out visitor to the sign-in that way.
export function pageRedirect(
  html: string,
  pageUrl: string,
): string | undefined {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/^refresh$/i.test(attribute(tag, "http-equiv") ?? "")) {
      continue;
    }
    const target = (attribute(tag, "content") ?? "").match(/url\s*=\s*(.+)$/i);
    if (!target) {
      continue;
    }
    try {
      return new URL(
        target[1]
          .trim()
          .replace(/^['"]|['"]$/g, "")
          .replace(/&amp;/g, "&"),
        pageUrl,
      ).toString();
    } catch {
      continue;
    }
  }
  return undefined;
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(
    new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"),
  );
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

// The id of the server action `name` in a script of the site: Next.js
// writes each action a page uses as
// createServerReference)("<id>",…callServer,void 0,…findSourceMapURL,"<name>").
export function actionIdIn(script: string, name: string): string | undefined {
  const references =
    /createServerReference\)?\(\s*["']([0-9a-f]{8,})["']((?:\s*,\s*[^,()"']+){1,4})\s*,\s*["']([\w$]+)["']\s*\)/g;
  for (const match of script.matchAll(references)) {
    if (match[3] === name) {
      return match[1];
    }
  }
  return undefined;
}

// Whether a request ended on Humble's sign-in, where the site sends a
// browser it doesn't take the sign-in of: any page of Ory's host (SRM never
// asks for one), or a /login page of the site (BoilR's check). Only the
// path counts: the query of any page can name /login (?goto=/login).
export function isSignInPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === AUTH_HOST) {
    return true;
  }
  if (!domainMatches("humblebundle.com", host)) {
    return false;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return path === "/login" || path.startsWith("/login/");
}

function isHumbleCookie(cookie: StoreCookie) {
  return (
    domainMatches(cookie.domain, SITE_HOST) ||
    domainMatches(cookie.domain, AUTH_HOST)
  );
}

// Attributes of a Set-Cookie line, which a paste may carry along: not
// cookies.
const COOKIE_ATTRIBUTES = [
  "path",
  "domain",
  "expires",
  "max-age",
  "samesite",
  "secure",
  "httponly",
  "partitioned",
  "priority",
];
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// The cookies of a pasted Cookie header ("name=value; name2=value2"), with
// or without "Cookie:" in front, or of the Cookie line in a paste of a
// request's headers; as cookies for every humblebundle.com host (a
// __Host- cookie for the site's host only, as it must be). Which of them
// is the sign-in Humble knows, not SRM, so all of them go in.
export function parsePastedCookies(pasted: string): StoreCookie[] {
  const headerLine = pasted.match(/^\s*cookie\s*:(.*)$/im);
  const header = headerLine ? headerLine[1] : pasted;
  const cookies = new Map<string, StoreCookie>();
  for (const part of header.split(/;|\r?\n/)) {
    const pair = part.trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (
      !COOKIE_NAME.test(name) ||
      COOKIE_ATTRIBUTES.includes(name.toLowerCase()) ||
      !isUsableCookieValue(value)
    ) {
      continue;
    }
    cookies.delete(name);
    cookies.set(name, {
      name,
      value,
      domain: name.startsWith("__Host-") ? SITE_HOST : COOKIE_DOMAIN,
    });
  }
  if (cookies.size === 0) {
    throw new Error(
      "That is not a Cookie header from humblebundle.com. Paste the whole value of the Cookie request header (name=value; name=value; ...).",
    );
  }
  return [...cookies.values()];
}

function isUsableCookieValue(value: string) {
  const unquoted = value.replace(/^"|"$/g, "");
  return unquoted !== "" && !/[\s\x00-\x1f\x7f]/.test(value);
}

// The games in the library items, following Playnite's GetLibraryGames
// with its default settings (BoilR's owned_games). A title in several
// items is listed once, under the id of one of its copies (listedCopy).
// `previous` is the last list of this account.
export function ownedGames(
  items: readonly LibraryItem[],
  previous: readonly OwnedGame[],
): OwnedGame[] {
  // Per title, every copy the account can download.
  const byTitle = new Map<string, TitleCopy[]>();
  for (const item of items) {
    if (item.pageId === "") {
      continue;
    }
    // Like Playnite's, only the keys of the same item hide a DRM-free game.
    const keyNames = item.keys
      .map((key) => key.title)
      .filter((title) => title !== "");
    for (const download of item.downloads) {
      const title = download.title || item.title;
      if (download.id === "" || title === "") {
        continue;
      }
      if (
        !runsHere(download) ||
        keyNames.some((keyName) => isKeyFor(keyName, title))
      ) {
        continue;
      }
      const copies = byTitle.get(title) ?? [];
      copies.push({ id: download.id, pageId: item.pageId });
      byTitle.set(title, copies);
    }
  }
  return [...byTitle.keys()].sort(compareText).flatMap((title) => {
    const copy = listedCopy(byTitle.get(title) ?? [], previous);
    return copy
      ? [
          ownedGame("humble", copy.id, cleanTitle(title), {
            url: itemPage(copy.pageId),
          }),
        ]
      : [];
  });
}

// The item's page in the library, where its downloads are.
export function itemPage(pageId: string) {
  return `${SITE}/home/library/${encodeURIComponent(pageId)}`;
}

// Whether a download entitlement has a download for a platform SRM's
// targets run (GAME_PLATFORMS).
export function runsHere(download: Entitlement) {
  return download.platforms.some((platform) =>
    GAME_PLATFORMS.includes(platform),
  );
}

// The copy a title is listed with; its id is the game's id. That is the id
// the previous list used, as long as the account still has that copy: the
// id is what ties the game to its Steam shortcut, so a purchase made later
// must not change it, whatever its id. A title that is new to the list takes
// the smallest id, which doesn't depend on the order the items arrive in.
export function listedCopy(
  copies: readonly TitleCopy[],
  previous: readonly OwnedGame[],
): TitleCopy | undefined {
  const sorted = [...copies].sort(
    (a, b) => compareText(a.id, b.id) || compareText(a.pageId, b.pageId),
  );
  return (
    sorted.find((copy) => previous.some((game) => game.id === copy.id)) ??
    sorted[0]
  );
}

function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Words that may follow a game's name in the name of its third-party key.
const KEY_NAME_WORDS = [
  "key",
  "keys",
  "steam",
  "epic",
  "games",
  "store",
  "gog",
  "origin",
  "ea",
  "app",
  "uplay",
  "ubisoft",
  "connect",
  "battle",
  "net",
  "rockstar",
  "launcher",
  "microsoft",
  "xbox",
  "pc",
  "drm",
  "free",
];

// Whether a third-party key's name is for the game `title`: the same name,
// or the name followed only by a store or "key" ("FEZ Steam Key", "FEZ
// (Steam)", "FEZ - Epic Games Key"), the patterns of Playnite's
// HumbleLibrary. A key for another game whose name merely starts with the
// title ("FEZ II Steam Key", "Limbonauts") does not count.
export function isKeyFor(keyName: string, title: string): boolean {
  const normalize = (name: string) => cleanTitle(name).toLowerCase();
  const key = normalize(keyName);
  const game = normalize(title);
  if (game === "" || !key.startsWith(game)) {
    return false;
  }
  const rest = key.slice(game.length);
  if (/^[\p{Alphabetic}\p{N}]/u.test(rest)) {
    return false;
  }
  return rest
    .split(/[^\p{Alphabetic}\p{N}]+/u)
    .filter((word) => word !== "")
    .every((word) => KEY_NAME_WORDS.includes(word));
}

export const humbleClient: StoreClient = {
  key: "humble",
  beginLogin,
  completeLogin,
  listLibrary,
};
