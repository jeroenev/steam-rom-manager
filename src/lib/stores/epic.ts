// Epic Games Store: sign in with the Epic Games Launcher's OAuth client and
// list the account's library through Epic's library and catalog services,
// the way Playnite's EpicLibrary plugin and legendary do. Ported from
// BoilR's epic.rs.
//
// Login: the window opens www.epicgames.com/id/login, which sends the user
// on to id/api/redirect?clientId=…&responseType=code once signed in. That
// page is JSON with an `authorizationCode`: the window loads it and hands
// its text over, or the user pastes it. The code is traded at Epic's OAuth
// token service for an access token (about two hours), a refresh token, the
// account id and the display name. Epic ends a refresh token when it's
// used, so a renewed one is saved at once (ListContext.checkpoint).
//
// Library: library-service items, page by page (a cursor), then the
// catalog's bulk lookup per namespace for the entries the last list doesn't
// hold: a game that's already listed is taken over as it is. Entries that
// aren't games (DLC, extras) are never in the list, so they're looked up
// each time. A lookup that fails keeps the game as the last list had it, or
// leaves it out and marks the list partial, so it's fetched again soon.
//
// OwnedGame.id is Epic's appName, the id the launcher's manifests (SRM's
// Epic parser), legendary and Heroic use. extra:
// - `namespace`: the catalog namespace;
// - `catalog_item_id`: the catalog item id;
// - `product_slug`: the game's store page (store.epicgames.com/p/<slug>),
//   when the catalog names one.
// The namespace, the catalog item id and the id make the launcher's link
// (epicInstallLink in targets.ts).

import { STATUS_CODES } from "http";
import { StoreRequestInit } from "./host";
import {
  BROWSER_USER_AGENT,
  HttpStatus,
  cleanTitle,
  domainMatches,
  isLoginRejected,
  isTransient,
  isTransientStatus,
  loginRejected,
  messageOf,
  paginate,
  queryParam,
  readText,
  snippet,
  transient,
  withoutQuery,
  wrapErr,
} from "./http";
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

// The Epic Games Launcher's OAuth client ("launcherAppClient2"), as Playnite
// (EpicAccountClient.cs) and legendary (api/egs.py) use it.
const CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";
const CLIENT_SECRET = "daafbccc737745039dffe53d94fc76cf";
// legendary's launcher user agent, for the account, library and catalog
// services.
export const LAUNCHER_USER_AGENT =
  "UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit";
// The login window's user agent: an ordinary browser's, as the sign-in
// works in a browser. With the launcher's own (which Playnite used), Epic
// finishes the sign-in as the launcher's and stops after two-factor
// authentication with "Invalid client, redirect url is not known to the
// client". The cookie replay sends the same one.
export const LOGIN_USER_AGENT = BROWSER_USER_AGENT;

const LOGIN_URL = "https://www.epicgames.com/id/login";
export const REDIRECT_URL = "https://www.epicgames.com/id/api/redirect";
// (the same page without www)
const REDIRECT_URL_BARE = "https://epicgames.com/id/api/redirect";
// Where Epic's login sends the real launcher (Playnite, Heroic). The code
// is in the URL's `code` parameter, so this page isn't loaded.
const LAUNCHER_CALLBACKS = [
  "http://localhost/launcher/authorized",
  "https://localhost/launcher/authorized",
];
export const OAUTH_TOKEN_URL =
  "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token";
export const SESSION_KILL_URL =
  "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/sessions/kill/";
export const ACCOUNT_URL =
  "https://account-public-service-prod03.ol.epicgames.com/account/api/public/account/";
export const LIBRARY_ITEMS_URL =
  "https://library-service.live.use1a.on.epicgames.com/library/api/public/items";
export const CATALOG_URL =
  "https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/";

// Catalog item ids asked for in one bulk request (ids are 32 characters;
// this keeps URLs short).
export const CATALOG_BATCH_SIZE = 50;
// Catalog requests in flight at once.
export const CATALOG_CONCURRENCY = 8;
// A stop for a library service that keeps handing out cursors.
const MAX_LIBRARY_PAGES = 1000;
// Renew the access token when it expires within this long: longer than a
// refresh may take (REFRESH_DEADLINE_MS), so a token that passed the check
// lasts for the whole fetch.
export const REFRESH_MARGIN_MS = 300 * 1000;
// The catalog attribute that names a game's store page (legendary and
// Playnite read it).
export const PRODUCT_SLUG_ATTRIBUTE = "com.epicgames.app.productSlug";

// What SRM keeps for an Epic account.
export interface EpicSession {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  // When accessToken stops working, in milliseconds since 1970.
  expiresAt: number;
  displayName: string | null;
}

// -------------------------------------------------------------------------
// Login

// The page that hands out an authorization code for the launcher client
// once the user is signed in at epicgames.com. It shows JSON with
// `authorizationCode`.
export function redirectUrl() {
  return `${REDIRECT_URL}?clientId=${CLIENT_ID}&responseType=code`;
}

// Epic's login page, sending the user on to redirectUrl() afterwards
// (legendary's get_auth_url). A user who is already signed in goes straight
// to the code.
export function loginUrl() {
  return `${LOGIN_URL}?redirectUrl=${encodeURIComponent(redirectUrl())}`;
}

export function beginLogin(): PendingLogin {
  const startUrl = loginUrl();
  const redirectPages = [REDIRECT_URL, REDIRECT_URL_BARE];
  return {
    store: "epic",
    startUrl,
    doneUrlPrefixes: [...redirectPages, ...LAUNCHER_CALLBACKS],
    // The redirect page is JSON that holds the code. The window loads it and
    // hands its text over, as Playnite and Heroic read it in their webview:
    // asking for the page again from here comes from another network stack,
    // which Epic's bot protection may refuse.
    pageTextUrlPrefixes: redirectPages,
    cookieUrls: ["https://www.epicgames.com"],
    manual: {
      kind: "paste",
      url: startUrl,
    },
    userAgent: LOGIN_USER_AGENT,
    state: {},
  };
}

async function completeLogin(
  _pending: PendingLogin,
  capture: LoginCapture,
  ctx: StoreContext,
): Promise<StoreSession> {
  const code = await codeForLogin(capture, ctx);
  const token = await requestToken(ctx, "authorization_code", { code });
  const epic = sessionFromToken(token, null, ctx.now());
  if (epic.displayName === null) {
    // Only the name shown next to the account: no reason to fail the login.
    try {
      epic.displayName = await fetchDisplayName(ctx, epic);
    } catch {
      // (the token's next renewal may bring it)
    }
  }
  return { accountName: epic.displayName, data: epic };
}

// The code of a login: what the user pasted, else what the window handed
// over, else the redirect page asked for with the window's cookies.
async function codeForLogin(
  capture: LoginCapture,
  ctx: StoreContext,
): Promise<string> {
  const pasted = capture.pasted?.trim() ? capture.pasted : undefined;
  if (pasted !== undefined) {
    return parsePastedCode(pasted);
  }
  return codeInCapture(capture) ?? codeFromCookies(ctx, capture);
}

// The redirect page answers with a null code to a browser that isn't
// signed in.
function noCodeWithoutSignIn() {
  return new Error(
    "Epic gave no login code because this browser is not signed in to epicgames.com. Sign in, open the link again and paste what it shows.",
  );
}

// The redirect page's JSON, or undefined when `text` isn't that.
function redirectJson(
  text: string,
): { authorizationCode?: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const code = (value as any).authorizationCode;
  if (code !== undefined && code !== null && typeof code !== "string") {
    return undefined;
  }
  return { authorizationCode: typeof code === "string" ? code : undefined };
}

function codeOf(json: { authorizationCode?: string }): string {
  const code = json.authorizationCode?.trim();
  if (!code) {
    throw noCodeWithoutSignIn();
  }
  return code;
}

// Reads the authorization code from the redirect page: its JSON, or what a
// JSON viewer makes of it.
export function parseRedirectResponse(body: string): string {
  const json = redirectJson(body.trim());
  if (json) {
    return codeOf(json);
  }
  const code = codeAfterName(body);
  if (code === undefined) {
    throw new Error(
      `Epic did not return a login code. Body starts with: ${snippet(body)}`,
    );
  }
  return code;
}

// The value that follows `authorizationCode` in text that isn't JSON as a
// whole: a part of the JSON ("authorizationCode":"…",), or what a browser's
// JSON viewer copies (Firefox: authorizationCode<TAB>"…"). Undefined when
// the text names no code; throws when it only names a null one (a browser
// that isn't signed in).
export function codeAfterName(text: string): string | undefined {
  let signedOut = false;
  for (const rest of text.split("authorizationCode").slice(1)) {
    const value = rest.split(/[^A-Za-z0-9]/).find((word) => word !== "");
    if (value !== undefined && looksLikeCode(value)) {
      return value;
    }
    if (value === "null") {
      signedOut = true;
    }
  }
  if (signedOut) {
    throw noCodeWithoutSignIn();
  }
  return undefined;
}

// Takes what a user may paste: the bare code, the redirect page's JSON
// (whole, in part, or as a browser's JSON viewer copies it), a
// …/launcher/authorized?code=… URL, or any text that holds exactly one code.
export function parsePastedCode(pasted: string): string {
  const text = pasted.trim();
  const json = redirectJson(text);
  if (json) {
    return codeOf(json);
  }
  const named = codeAfterName(text);
  if (named !== undefined) {
    return named;
  }
  const inUrl = queryParam(text, "code");
  if (inUrl !== undefined && looksLikeCode(inUrl)) {
    return inUrl;
  }
  const bare = text.replace(/^["']+|["']+$/g, "").trim();
  if (looksLikeCode(bare)) {
    return bare;
  }
  const only = onlyHexCodeIn(text);
  if (only !== undefined) {
    return only;
  }
  throw new Error(
    'That does not look like an Epic login code. Paste the value of "authorizationCode" (32 letters and digits) or all of the text the Epic page shows.',
  );
}

// What is taken as a code where the text says it is one (after
// authorizationCode, in a `code` parameter, pasted on its own). Epic's codes
// are 32 hex characters today; this leaves room for another length.
export function looksLikeCode(text: string) {
  return /^[A-Za-z0-9]{16,128}$/.test(text);
}

// A code as Epic hands them out: 32 hex characters.
function isHexCode(text: string) {
  return /^[0-9A-Fa-f]{32}$/.test(text);
}

// The code in text that says nothing about where it is, when the text holds
// exactly one.
export function onlyHexCodeIn(text: string): string | undefined {
  const codes = new Set(text.split(/[^A-Za-z0-9]/).filter(isHexCode));
  return codes.size === 1 ? [...codes][0] : undefined;
}

// The code a login window handed over itself: in the URL of the launcher's
// localhost callback, or in the text of the redirect page it loaded.
// Undefined when it gave neither; throws when the page holds no code.
export function codeInCapture(capture: LoginCapture): string | undefined {
  const inUrl = capture.finalUrl
    ? queryParam(capture.finalUrl, "code")
    : undefined;
  if (inUrl !== undefined && looksLikeCode(inUrl)) {
    return inUrl;
  }
  if (capture.pageText && capture.pageText.trim() !== "") {
    return parseRedirectResponse(capture.pageText);
  }
  return undefined;
}

// For a login window that couldn't hand over the redirect page's text: asks
// for the page with the window's cookies, under the window's user agent.
async function codeFromCookies(
  ctx: StoreContext,
  capture: LoginCapture,
): Promise<string> {
  if (!capture.finalUrl) {
    throw new Error("The Epic login did not finish. Sign in again.");
  }
  const cookie = cookieHeader(capture.cookies || [], "www.epicgames.com");
  if (cookie === "") {
    throw new Error(
      "The login window returned no Epic cookies. Sign in again.",
    );
  }
  // Always our own URL, so the cookies only ever go to epicgames.com with
  // our client id.
  const request = redirectPageRequest(cookie);
  const response = await ctx.http.send(request.url, request.init);
  return parseRedirectResponse(await readText(response));
}

export function redirectPageRequest(cookie: string): {
  url: string;
  init: StoreRequestInit;
} {
  return {
    url: redirectUrl(),
    init: {
      headers: {
        Cookie: cookie,
        "User-Agent": LOGIN_USER_AGENT,
        Accept: "application/json",
      },
      // The window's cookies must be all that goes: Chromium puts the
      // partition's cookies in place of a Cookie header set by hand whenever
      // it has any for the host (an earlier replay leaves some), and keeps
      // what the answer sets. (BoilR sent this from a fresh client.)
      credentials: "omit",
    },
  };
}

// A Cookie header for the cookies whose domain matches `host`.
export function cookieHeader(
  cookies: readonly StoreCookie[],
  host: string,
): string {
  return cookies
    .filter((cookie) => domainMatches(cookie.domain, host))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

// -------------------------------------------------------------------------
// Tokens

// What a token is asked for with: the code of a sign-in being finished, or
// the saved login.
export type Grant = "authorization_code" | "refresh_token";

// Tokens as Epic's OAuth service sends them.
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  // Seconds; 0 when Epic doesn't say.
  expires_in: number;
  // "" when Epic doesn't say.
  account_id: string;
  displayName: string | null;
}

// Epic's error body, the same for all its services.
export interface EpicError {
  errorCode?: string;
  errorMessage?: string;
  // The OAuth name of the error (invalid_grant), which the token service
  // sends next to its own errorCode.
  error?: string;
  continuationUrl?: string;
}

// The answer as Epic's error body, or undefined when it isn't one.
export function epicError(answer: unknown): EpicError | undefined {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return undefined;
  }
  const error: EpicError = {};
  for (const field of [
    "errorCode",
    "errorMessage",
    "error",
    "continuationUrl",
  ] as const) {
    const value = (answer as any)[field];
    if (typeof value === "string") {
      error[field] = value;
    } else if (value !== undefined && value !== null) {
      return undefined;
    }
  }
  return error;
}

// The token service's answer: the tokens, or an error that says what went
// wrong (tokenError).
export function parseTokenResponse(
  grant: Grant,
  status: number,
  body: string,
): TokenResponse {
  let answer: unknown;
  let isJson = true;
  try {
    answer = JSON.parse(body);
  } catch {
    isJson = false;
  }
  const error = isJson ? epicError(answer) : undefined;
  if (error?.errorCode) {
    throw tokenError(grant, status, error);
  }
  if (status < 200 || status >= 300) {
    throw wrapErr(
      new HttpStatus(status, OAUTH_TOKEN_URL, snippet(body)),
      "Epic sign-in failed",
    );
  }
  const unexpected = (detail: string) =>
    new Error(
      `Unexpected answer from Epic's sign-in service: ${detail}. Body starts with: ${snippet(body)}`,
    );
  if (!isJson) {
    throw unexpected("not JSON");
  }
  const token = readToken(answer);
  if (typeof token === "string") {
    throw unexpected(token);
  }
  return token;
}

// The tokens of an answer, or what's wrong with it.
function readToken(answer: any): TokenResponse | string {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return "not an object";
  }
  for (const field of ["access_token", "refresh_token"]) {
    if (typeof answer[field] !== "string") {
      return `missing field \`${field}\``;
    }
  }
  const expiresIn = answer.expires_in ?? 0;
  if (typeof expiresIn !== "number" || !(expiresIn >= 0)) {
    return "`expires_in` is not a number of seconds";
  }
  const accountId = answer.account_id ?? "";
  const displayName = answer.displayName ?? null;
  if (typeof accountId !== "string" || !optionalString(displayName)) {
    return "`account_id` or `displayName` is not text";
  }
  return {
    access_token: answer.access_token,
    refresh_token: answer.refresh_token,
    expires_in: expiresIn,
    account_id: accountId,
    displayName,
  };
}

function optionalString(value: unknown) {
  return value === null || typeof value === "string";
}

// A refused token request as the error to report. Only a refused refresh
// token is a refused login: a refused code is about the sign-in being
// finished, and anything else says nothing about the saved login.
export function tokenError(
  grant: Grant,
  status: number,
  error: EpicError,
): Error {
  const code = error.errorCode || "";
  const message = error.errorMessage || code;
  if (code.endsWith("corrective_action_required")) {
    const url = error.continuationUrl || "https://www.epicgames.com/account";
    const then =
      grant === "authorization_code"
        ? "sign in again"
        : "refresh the library again";
    return new Error(
      `Epic needs you to confirm something on your account first (${message}). Open ${url} in a browser, then ${then}.`,
    );
  }
  // Epic's own code names what was refused
  // (…oauth.authorization_code_not_found,
  // …auth_token.invalid_refresh_token). Where it doesn't, the OAuth name
  // says the grant that was sent is no longer good.
  const invalidGrant = error.error === "invalid_grant";
  if (
    code.includes("authorization_code") ||
    (invalidGrant && grant === "authorization_code")
  ) {
    return new Error(
      "Epic did not accept the login code: it expired or was already used. Sign in again.",
    );
  }
  if (
    code.includes("refresh_token") ||
    (invalidGrant && grant === "refresh_token")
  ) {
    return loginRejected("Your Epic sign-in has expired. Sign in again.");
  }
  const text = `Epic sign-in failed: ${message} (${code})`;
  return isTransientStatus(status) ? transient(text) : new Error(text);
}

// The request for a token: the launcher client's Basic auth, a form body.
export function tokenRequest(
  grant: Grant,
  params: Record<string, string>,
): { url: string; init: StoreRequestInit } {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
    "base64",
  );
  const form = new URLSearchParams({ grant_type: grant });
  for (const [name, value] of Object.entries(params)) {
    form.append(name, value);
  }
  form.append("token_type", "eg1");
  return {
    url: OAUTH_TOKEN_URL,
    init: {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": LAUNCHER_USER_AGENT,
      },
      body: form.toString(),
    },
  };
}

async function requestToken(
  ctx: StoreContext,
  grant: Grant,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const request = tokenRequest(grant, params);
  let status: number;
  let body: string;
  try {
    // (any status: Epic's error body says more than the status)
    const response = await ctx.http.request(request.url, request.init);
    status = response.status;
    body = await readText(response);
  } catch (err) {
    throw wrapErr(err, "Could not reach Epic's sign-in service");
  }
  return parseTokenResponse(grant, status, body);
}

export function sessionFromToken(
  token: TokenResponse,
  previousName: string | null,
  now: number,
): EpicSession {
  const name = token.displayName;
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    accountId: token.account_id,
    expiresAt: now + token.expires_in * 1000,
    displayName: name !== null && name.trim() !== "" ? name : previousName,
  };
}

export function needsRefresh(epic: EpicSession, now: number) {
  return now + REFRESH_MARGIN_MS >= epic.expiresAt;
}

// The session's data, checked; null when it isn't an Epic session.
function epicData(session: StoreSession): EpicSession | null {
  const data = session?.data;
  const fits =
    !!data &&
    typeof data.accessToken === "string" &&
    typeof data.refreshToken === "string" &&
    typeof data.accountId === "string" &&
    typeof data.expiresAt === "number" &&
    (data.displayName === undefined || optionalString(data.displayName));
  return fits
    ? { ...(data as EpicSession), displayName: data.displayName ?? null }
    : null;
}

// The saved session; data that doesn't fit needs a new sign-in.
export function readSession(session: StoreSession): EpicSession {
  const checked = sessionData<EpicSession>(
    "epic",
    session,
    (data) => epicData({ accountName: null, data }) !== null,
  );
  return { ...checked, displayName: checked.displayName ?? null };
}

// Trades the refresh token for new tokens. Keeps the name and the account
// id the answer doesn't repeat.
async function refreshSession(
  session: StoreSession,
  ctx: StoreContext,
): Promise<StoreSession> {
  const epic = readSession(session);
  const token = await requestToken(ctx, "refresh_token", {
    refresh_token: epic.refreshToken,
  });
  const renewed = sessionFromToken(token, epic.displayName, ctx.now());
  if (renewed.accountId === "") {
    renewed.accountId = epic.accountId;
  }
  return {
    accountName: renewed.displayName ?? session.accountName,
    data: renewed,
  };
}

// Renews the tokens and saves them right away: Epic ends the old refresh
// token when it's used, so the new one must not be lost when SRM closes
// while the games are listed.
async function renew(session: StoreSession, ctx: ListContext) {
  const renewed = await refreshSession(session, ctx);
  session.data = renewed.data;
  session.accountName = renewed.accountName;
  await ctx.checkpoint(session);
}

async function fetchDisplayName(ctx: StoreContext, epic: EpicSession) {
  if (epic.accountId === "") {
    return null;
  }
  const account = await ctx.http.sendJson(
    `${ACCOUNT_URL}${encodeURIComponent(epic.accountId)}`,
    { headers: authorized(epic.accessToken) },
  );
  return parseDisplayName(account);
}

export function parseDisplayName(account: any): string | null {
  const name = account?.displayName;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

// -------------------------------------------------------------------------
// Sign-out

// Ends the session on Epic's side, as legendary does when it logs out. A
// login Epic no longer accepts has no session left to end.
async function signOut(session: StoreSession, ctx: StoreContext) {
  let epic = epicData(session);
  if (!epic) {
    throw new Error("the saved login could not be read");
  }
  if (needsRefresh(epic, ctx.now())) {
    try {
      epic = readSession(await refreshSession(session, ctx));
    } catch (err) {
      if (isLoginRejected(err)) {
        return;
      }
      throw err;
    }
  }
  const token = epic.accessToken;
  let status: number;
  try {
    const response = await ctx.http.request(sessionKillUrl(token), {
      method: "DELETE",
      headers: authorized(token),
    });
    status = response.status;
  } catch (err) {
    throw unreachable(err, token);
  }
  const failure = sessionEndFailure(status);
  if (failure) {
    throw failure;
  }
}

// The access token is part of this URL's path: no error or log may name it.
export function sessionKillUrl(accessToken: string) {
  return `${SESSION_KILL_URL}${encodeURIComponent(accessToken)}`;
}

// A sign-out request that got no answer, as an error of the same kind that
// names neither the URL nor the token.
export function unreachable(err: unknown, accessToken: string): Error {
  const secrets = [accessToken, encodeURIComponent(accessToken)].filter(
    (secret) => secret !== "",
  );
  let detail = messageOf(err);
  for (const secret of secrets) {
    detail = detail.split(secret).join("…");
  }
  const text = `Epic could not be reached: ${detail}`;
  return isTransient(err) ? transient(text) : new Error(text);
}

// How Epic answered the request to end a session: undefined when the
// session is over (Epic ended it, or no longer knew the token), else the
// error.
export function sessionEndFailure(status: number): Error | undefined {
  if ((status >= 200 && status < 300) || status === 401) {
    return undefined;
  }
  const text = `Epic answered ${statusText(status)}`;
  return isTransientStatus(status) ? transient(text) : new Error(text);
}

function statusText(status: number) {
  return STATUS_CODES[status]
    ? `${status} ${STATUS_CODES[status]}`
    : `${status}`;
}

// -------------------------------------------------------------------------
// Library

function authorized(accessToken: string): Record<string, string> {
  return {
    Authorization: `bearer ${accessToken}`,
    "User-Agent": LAUNCHER_USER_AGENT,
  };
}

async function listLibrary(
  session: StoreSession,
  ctx: ListContext,
): Promise<ListResult> {
  if (needsRefresh(readSession(session), ctx.now())) {
    await renew(session, ctx);
  }
  const records = await fetchLibrary(session, ctx);
  const entries = libraryEntries(records);

  const unknown = entriesToLookUp(entries, ctx.previous);
  const lookup = await fetchCatalog(
    ctx,
    readSession(session).accessToken,
    catalogBatches(unknown),
  );
  const listed = listGames(entries, ctx.previous, lookup);
  if (listed.missing > 0) {
    const error = lookup.error ?? new Error("Epic's catalog did not answer");
    if (listed.games.length === 0) {
      throw wrapErr(error, "Could not look up the Epic games");
    }
    // The list is saved without them, marked partial so it's fetched again
    // soon.
    ctx.log(
      `${listed.missing} Epic games could not be looked up and are left out for now: ${messageOf(error)}`,
    );
    return { games: listed.games, partial: true };
  }
  return { games: listed.games };
}

// Every record of the account's library, page by page.
async function fetchLibrary(
  session: StoreSession,
  ctx: ListContext,
): Promise<LibraryRecord[]> {
  // The first page doubles as the token check: a token Epic ended early is
  // renewed once.
  let first: LibraryPage;
  try {
    first = await libraryPage(ctx, readSession(session).accessToken);
  } catch (err) {
    if (!isLoginRejected(err)) {
      throw err;
    }
    await renew(session, ctx);
    first = await libraryPage(ctx, readSession(session).accessToken);
  }
  if (first.next === undefined) {
    return first.records;
  }
  const accessToken = readSession(session).accessToken;
  const rest = await paginate(
    "Epic's library service",
    first.next,
    MAX_LIBRARY_PAGES,
    async (cursor: string) => {
      const page = await libraryPage(ctx, accessToken, cursor);
      return [page.records, page.next];
    },
  );
  return [...first.records, ...rest];
}

// One page of the library.
async function libraryPage(
  ctx: StoreContext,
  accessToken: string,
  cursor?: string,
): Promise<LibraryPage> {
  try {
    const response = await ctx.http.send(libraryUrl(cursor), {
      headers: authorized(accessToken),
    });
    return parseLibraryPage(response.url, await readText(response));
  } catch (err) {
    throw wrapErr(err, "Could not load the Epic library");
  }
}

export function libraryUrl(cursor?: string) {
  // Playnite asks for the Windows platform; legendary sends no platform.
  const query = new URLSearchParams({
    includeMetadata: "true",
    platform: "Windows",
  });
  if (cursor !== undefined) {
    query.set("cursor", cursor);
  }
  return `${LIBRARY_ITEMS_URL}?${query}`;
}

// A page of the library: its records and the cursor of the next page.
export interface LibraryPage {
  records: LibraryRecord[];
  // Undefined on the last page.
  next?: string;
}

export interface LibraryRecord {
  appName?: string;
  catalogItemId?: string;
  namespace?: string;
  sandboxType?: string;
}

const RECORD_FIELDS = [
  "appName",
  "catalogItemId",
  "namespace",
  "sandboxType",
] as const;

// Reads a page of the library. `finalUrl` is where the request ended up.
// The last page has no cursor, or an empty one. An answer that isn't a page
// (fields of the wrong kind) is an error, never an empty page: a list cut
// short would take games out of Steam.
export function parseLibraryPage(finalUrl: string, body: string): LibraryPage {
  const unexpected = (detail: string) =>
    new Error(
      `Unexpected response from ${withoutQuery(finalUrl)}: ${detail}. Body starts with: ${snippet(body)}`,
    );
  let page: any;
  try {
    page = JSON.parse(body);
  } catch (err) {
    throw unexpected(messageOf(err));
  }
  if (!page || typeof page !== "object" || Array.isArray(page)) {
    throw unexpected("not a page of the library");
  }
  const metadata = page.responseMetadata ?? undefined;
  if (
    metadata !== undefined &&
    (typeof metadata !== "object" || Array.isArray(metadata))
  ) {
    throw unexpected("`responseMetadata` is not an object");
  }
  const cursor = metadata?.nextCursor ?? undefined;
  if (cursor !== undefined && typeof cursor !== "string") {
    throw unexpected("`nextCursor` is not text");
  }
  // (missing: no records; null is no list)
  const rawRecords = page.records === undefined ? [] : page.records;
  if (!Array.isArray(rawRecords)) {
    throw unexpected("`records` is not a list");
  }
  const records = rawRecords.map((raw: any) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw unexpected("a record that is not an object");
    }
    const record: LibraryRecord = {};
    for (const field of RECORD_FIELDS) {
      const value = raw[field];
      if (typeof value === "string") {
        record[field] = value;
      } else if (value !== undefined && value !== null) {
        throw unexpected(`a record whose \`${field}\` is not text`);
      }
    }
    return record;
  });
  return { records, next: cursor ? cursor : undefined };
}

// A library record worth looking up in the catalog.
export interface LibraryEntry {
  appName: string;
  namespace: string;
  catalogItemId: string;
}

// Drops what Playnite and legendary skip before the catalog lookup: Unreal
// Engine marketplace assets (namespace ue), private sandboxes (unreleased
// builds), records without an app name, and legendary's broken app name
// "1". Keeps the first record per app name.
export function libraryEntries(records: LibraryRecord[]): LibraryEntry[] {
  const seen = new Set<string>();
  const entries: LibraryEntry[] = [];
  for (const record of records) {
    const { appName, namespace, catalogItemId, sandboxType } = record;
    if (
      !appName ||
      appName === "1" ||
      !namespace ||
      equalsIgnoringAsciiCase(namespace, "ue") ||
      !catalogItemId ||
      (sandboxType !== undefined &&
        equalsIgnoringAsciiCase(sandboxType, "PRIVATE")) ||
      seen.has(appName)
    ) {
      continue;
    }
    seen.add(appName);
    entries.push({ appName, namespace, catalogItemId });
  }
  return entries;
}

// The last list's game for a library entry: the same app under the same
// catalog item.
function knownGame(
  entry: LibraryEntry,
  previous: readonly OwnedGame[],
): OwnedGame | undefined {
  return previous.find(
    (game) =>
      game.id === entry.appName &&
      game.extra.namespace === entry.namespace &&
      game.extra.catalog_item_id === entry.catalogItemId,
  );
}

// The entries the catalog is asked about: those the last list has no game
// for. Most namespaces hold one game, so a lookup costs about one request
// per entry; a game that's already listed is taken over instead. What's
// left is new games, and the entries that are no games (DLC, extras), which
// no list remembers.
export function entriesToLookUp(
  entries: readonly LibraryEntry[],
  previous: readonly OwnedGame[],
): LibraryEntry[] {
  return entries.filter((entry) => !knownGame(entry, previous));
}

// A catalog request: a namespace and the item ids asked for in it.
export interface Batch {
  namespace: string;
  ids: string[];
}

// Catalog lookups grouped per namespace (the bulk endpoint is per
// namespace), at most CATALOG_BATCH_SIZE ids each.
export function catalogBatches(entries: readonly LibraryEntry[]): Batch[] {
  const perNamespace = new Map<string, Set<string>>();
  for (const entry of entries) {
    let ids = perNamespace.get(entry.namespace);
    if (!ids) {
      ids = new Set();
      perNamespace.set(entry.namespace, ids);
    }
    ids.add(entry.catalogItemId);
  }
  const batches: Batch[] = [];
  for (const namespace of [...perNamespace.keys()].sort()) {
    const ids = [...perNamespace.get(namespace)].sort();
    for (let i = 0; i < ids.length; i += CATALOG_BATCH_SIZE) {
      batches.push({ namespace, ids: ids.slice(i, i + CATALOG_BATCH_SIZE) });
    }
  }
  return batches;
}

// A catalog item's key: its namespace and id.
export function catalogKey(namespace: string, id: string) {
  return JSON.stringify([namespace, id]);
}

// What a catalog request came back with.
export type CatalogOutcome =
  | { items: Map<string, CatalogItem> }
  | { error: unknown };

// What a catalog lookup found, and which items it couldn't look up because
// a request failed (as opposed to items the service doesn't know).
export class CatalogLookup {
  // By catalogKey.
  found = new Map<string, CatalogItem>();
  failed = new Set<string>();
  // The first request error, reported when something couldn't be looked up.
  error: unknown = undefined;

  // Takes in the outcome of one request. The ids of a failed request count
  // as failed, unless asking for them one by one may still work
  // (worthAskingOneByOne).
  record(batch: Batch, outcome: CatalogOutcome) {
    if ("items" in outcome) {
      for (const [id, item] of outcome.items) {
        this.found.set(catalogKey(batch.namespace, id), item);
      }
    } else if (worthAskingOneByOne(batch.ids.length, outcome.error)) {
      this.error ??= outcome.error;
    } else {
      this.fail(batch, outcome.error);
    }
  }

  fail(batch: Batch, err: unknown) {
    for (const id of batch.ids) {
      this.failed.add(catalogKey(batch.namespace, id));
    }
    this.error ??= err;
  }
}

// Whether the ids of a failed request are worth asking for one at a time:
// only when there were several and the service refused the request itself
// (one bad id, a URL it doesn't take). An outage or a refused token would
// fail the same way again.
export function worthAskingOneByOne(ids: number, err: unknown) {
  return ids > 1 && !isTransient(err) && !isLoginRejected(err);
}

// The requests to make one id at a time after the batched ones: the ids of
// a batch of several that it neither answered nor failed for good. So the
// lookup works whether or not the service honours several `id` parameters
// in one request, and one bad id doesn't hide the other games of its
// namespace. A request for a single id is never repeated.
export function singleLookups(
  batches: readonly Batch[],
  first: CatalogLookup,
): Batch[] {
  const singles: Batch[] = [];
  for (const { namespace, ids } of batches) {
    if (ids.length <= 1) {
      continue;
    }
    for (const id of ids) {
      const key = catalogKey(namespace, id);
      if (!first.found.has(key) && !first.failed.has(key)) {
        singles.push({ namespace, ids: [id] });
      }
    }
  }
  return singles;
}

// Looks up catalog items, CATALOG_CONCURRENCY requests at a time, in
// batches first and then one by one where that may help (singleLookups).
async function fetchCatalog(
  ctx: StoreContext,
  accessToken: string,
  batches: Batch[],
): Promise<CatalogLookup> {
  const lookup = await runCatalogRequests(ctx, accessToken, batches);
  const singles = singleLookups(batches, lookup);
  if (singles.length > 0) {
    const second = await runCatalogRequests(ctx, accessToken, singles);
    for (const [key, item] of second.found) {
      lookup.found.set(key, item);
    }
    for (const key of second.failed) {
      lookup.failed.add(key);
    }
    lookup.error ??= second.error;
  }
  return lookup;
}

async function runCatalogRequests(
  ctx: StoreContext,
  accessToken: string,
  batches: readonly Batch[],
): Promise<CatalogLookup> {
  const lookup = new CatalogLookup();
  await runLimited(batches, CATALOG_CONCURRENCY, async (batch) => {
    let outcome: CatalogOutcome;
    try {
      outcome = { items: await fetchCatalogBatch(ctx, accessToken, batch) };
    } catch (error) {
      outcome = { error };
    }
    lookup.record(batch, outcome);
  });
  return lookup;
}

// Runs `work` for every item, at most `limit` at once.
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
}

export function catalogUrl(batch: Batch) {
  const query = new URLSearchParams();
  for (const id of batch.ids) {
    query.append("id", id);
  }
  query.set("includeDLCDetails", "false");
  query.set("includeMainGameDetails", "true");
  query.set("country", "US");
  query.set("locale", "en-US");
  return `${CATALOG_URL}${encodeURIComponent(batch.namespace)}/bulk/items?${query}`;
}

async function fetchCatalogBatch(
  ctx: StoreContext,
  accessToken: string,
  batch: Batch,
): Promise<Map<string, CatalogItem>> {
  const response = await ctx.http.send(catalogUrl(batch), {
    headers: authorized(accessToken),
  });
  return parseCatalogText(response.url, await readText(response));
}

// A bulk answer: an object of catalog items by id.
export function parseCatalogText(
  finalUrl: string,
  body: string,
): Map<string, CatalogItem> {
  const unexpected = (detail: string) =>
    new Error(
      `Unexpected response from ${withoutQuery(finalUrl)}: ${detail}. Body starts with: ${snippet(body)}`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw unexpected(messageOf(err));
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw unexpected("not an object of catalog items");
  }
  return parseCatalog(raw as Record<string, unknown>);
}

// A catalog item, as much of it as is read.
export interface CatalogItem {
  title?: string;
  // The paths of its categories.
  categories?: string[];
  // Set for DLC: the game it belongs to.
  mainGameItem?: unknown;
  // The values of its custom attributes, by name.
  customAttributes?: Record<string, string | undefined>;
}

// Keeps the items that have the catalog's shape; one odd item must not hide
// the others.
export function parseCatalog(
  raw: Record<string, unknown>,
): Map<string, CatalogItem> {
  const items = new Map<string, CatalogItem>();
  for (const [id, value] of Object.entries(raw)) {
    const item = parseCatalogItem(value);
    if (item) {
      items.set(id, item);
    }
  }
  return items;
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// An item of the catalog, or undefined when it doesn't have the shape of
// one.
export function parseCatalogItem(value: unknown): CatalogItem | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const item: CatalogItem = {};
  const title = value.title ?? undefined;
  if (title !== undefined) {
    if (typeof title !== "string") {
      return undefined;
    }
    item.title = title;
  }
  const categories = value.categories ?? undefined;
  if (categories !== undefined) {
    if (!Array.isArray(categories)) {
      return undefined;
    }
    const paths: string[] = [];
    for (const category of categories) {
      if (!isObject(category)) {
        return undefined;
      }
      const path = category.path === undefined ? "" : category.path;
      if (typeof path !== "string") {
        return undefined;
      }
      paths.push(path);
    }
    item.categories = paths;
  }
  if (value.mainGameItem !== undefined && value.mainGameItem !== null) {
    item.mainGameItem = value.mainGameItem;
  }
  const attributes = value.customAttributes ?? undefined;
  if (attributes !== undefined) {
    if (!isObject(attributes)) {
      return undefined;
    }
    const values: Record<string, string | undefined> = {};
    for (const [name, attribute] of Object.entries(attributes)) {
      if (!isObject(attribute)) {
        return undefined;
      }
      const attributeValue = attribute.value ?? undefined;
      if (attributeValue !== undefined && typeof attributeValue !== "string") {
        return undefined;
      }
      values[name] = attributeValue;
    }
    item.customAttributes = values;
  }
  return item;
}

function equalsIgnoringAsciiCase(a: string, b: string) {
  const lower = (text: string) =>
    text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return lower(a) === lower(b);
}

export function hasCategory(item: CatalogItem, path: string) {
  return (item.categories || []).some((c) => equalsIgnoringAsciiCase(c, path));
}

// A custom attribute's value, trimmed; undefined when it's empty.
function attribute(item: CatalogItem, name: string) {
  const value = item.customAttributes?.[name]?.trim();
  return value ? value : undefined;
}

// The last part of the game's store page, store.epicgames.com/p/<slug>. The
// attribute is written for the store's older addresses and can end in
// /home. A value that isn't a plain slug after that isn't used: it ends up
// in a link.
export function productSlug(item: CatalogItem): string | undefined {
  const value = attribute(item, PRODUCT_SLUG_ATTRIBUTE)?.replace(/\/+$/, "");
  if (value === undefined) {
    return undefined;
  }
  const slug = (
    value.endsWith("/home") ? value.slice(0, -"/home".length) : value
  ).replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9_-]+$/.test(slug) ? slug : undefined;
}

// Categories of items that aren't games: digital extras (soundtracks, art
// books) and engine plugins (Playnite), and mods (legendary).
const NOT_GAMES = ["digitalextras", "plugins", "plugins/engine", "mods"];

// A library entry as a game, skipping what Playnite's GetLibraryGames
// skips: items that aren't applications, DLC that can't be launched on its
// own, and items that aren't games.
export function ownedGameFrom(
  entry: LibraryEntry,
  item: CatalogItem,
): OwnedGame | undefined {
  if (!hasCategory(item, "applications")) {
    return undefined;
  }
  if (
    item.mainGameItem !== undefined &&
    !hasCategory(item, "addons/launchable")
  ) {
    return undefined;
  }
  if (NOT_GAMES.some((category) => hasCategory(item, category))) {
    return undefined;
  }
  if (item.title === undefined) {
    return undefined;
  }
  const title = cleanTitle(item.title);
  if (title === "") {
    return undefined;
  }
  const extra: Record<string, string> = {
    namespace: entry.namespace,
    catalog_item_id: entry.catalogItemId,
  };
  const slug = productSlug(item);
  if (slug !== undefined) {
    extra.product_slug = slug;
  }
  return ownedGame("epic", entry.appName, title, extra);
}

// The games of a library, and how many of its entries are left out because
// they couldn't be looked up.
export interface Listed {
  games: OwnedGame[];
  missing: number;
}

// Puts the list together, entry by entry: a game the last list holds is
// taken over as it is; one the catalog was asked about is listed when the
// catalog says it's a game; one whose lookup failed stays as the last list
// had it under the same app name, so a passing service error never takes it
// out of Steam, and counts as missing when the last list doesn't know it.
export function listGames(
  entries: readonly LibraryEntry[],
  previous: readonly OwnedGame[],
  lookup: CatalogLookup,
): Listed {
  const listed: Listed = { games: [], missing: 0 };
  for (const entry of entries) {
    const known = knownGame(entry, previous);
    if (known) {
      listed.games.push(known);
      continue;
    }
    const key = catalogKey(entry.namespace, entry.catalogItemId);
    const item = lookup.found.get(key);
    if (item) {
      const game = ownedGameFrom(entry, item);
      if (game) {
        listed.games.push(game);
      }
    } else if (lookup.failed.has(key)) {
      const before = previous.find((game) => game.id === entry.appName);
      if (before) {
        listed.games.push(before);
      } else {
        listed.missing += 1;
      }
    }
  }
  return listed;
}

export const epicClient: StoreClient = {
  key: "epic",
  beginLogin,
  completeLogin,
  refreshSession,
  listLibrary,
  signOut,
};
