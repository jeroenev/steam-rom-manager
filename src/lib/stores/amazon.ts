// Amazon Games (Prime Gaming): sign in the way the Amazon Games app does and
// list the games the account owns. Ported from BoilR's amazon.rs, which
// follows Playnite's AmazonGamesLibrary (Services/AmazonAccountClient.cs)
// and nile (nile/api/authorization.py, nile/api/library.py).
//
// Login: the window opens Amazon's OpenID sign-in page (amazon.com/ap/signin)
// with a PKCE S256 challenge and a client id of this device's own: a random
// device serial, client id = hex("<serial>#A2UMVHOX7UP4V7"). After sign-in
// Amazon sends the browser to the home page with the code in the query
// (https://www.amazon.com/?…&openid.oa2.authorization_code=…). The code, the
// PKCE verifier and the serial register a device at api.amazon.com/auth/
// register, as the Amazon Games app does, which answers with a bearer access
// token (an hour) and a refresh token. The verifier and the serial are in the
// PendingLogin's state: the sign-in page the user opened in their browser and
// the address they paste back must belong to the same login (refresh.ts keeps
// one per store until it's finished).
//
// Library: the Amazon Games app's entitlements service
// (gaming.amazon.com/api/distribution/entitlements, GetEntitlements), 50 per
// page with a nextToken, with the access token in x-amzn-token and a
// hardwareHash made from the device serial. In-game loot
// (Twitch:FuelEntitlement) is skipped. Sign-out deregisters the device.
//
// OwnedGame.id is the entitlement's product.id (amzn1.adg.product.<uuid>; for
// some games a bare uuid): the Id column of the Amazon Games app's
// GameInstallInfo.sqlite, which SRM's Amazon Games parser and
// installed-ids.ts (amazonInstalled) read, and the id in nile's
// installed.json (Heroic). extra: `entitlement_id`, the entitlement's own id
// (nile's GetGameDownload and the AMAZON_GAMES_FUEL_ENTITLEMENT_ID launch
// variable use it); `sku`, the product SKU; `icon_url`, square product art;
// each when Amazon sends one.

import * as crypto from "crypto";
import {
  HttpStatus,
  cleanTitle,
  isLoginRejected,
  loginRejected,
  messageOf,
  paginate,
  readText,
  snippet,
  statusOf,
  withoutQuery,
  wrapErr,
} from "./http";
import { sessionData } from "./storage";
import {
  ListContext,
  LoginCapture,
  OwnedGame,
  PendingLogin,
  StoreClient,
  StoreContext,
  StoreSession,
  ownedGame,
} from "./types";

export const SIGN_IN_URL = "https://www.amazon.com/ap/signin";
const RETURN_TO = "https://www.amazon.com";
export const REGISTER_URL = "https://api.amazon.com/auth/register";
export const TOKEN_URL = "https://api.amazon.com/auth/token";
export const DEREGISTER_URL = "https://api.amazon.com/auth/deregister";
export const ENTITLEMENTS_URL =
  "https://gaming.amazon.com/api/distribution/entitlements";
export const ENTITLEMENTS_TARGET =
  "com.amazon.animusdistributionservice.entitlement.AnimusEntitlementsService.GetEntitlements";
// The key id the Amazon Games app sends with GetEntitlements (nile
// api/library.py, Playnite AmazonAccountClient.cs; from
// Amazon.Fuel.Plugin.Entitlement.dll).
const ENTITLEMENTS_KEY_ID = "d5dc8b8b-86c8-4fc4-ae93-18c0def5314d";
// Amazon's device type for the Amazon Games app on Windows.
export const DEVICE_TYPE = "A2UMVHOX7UP4V7";
const MARKETPLACE_ID = "ATVPDKIKX0DER";
const ASSOC_HANDLE = "amzn_sonic_games_launcher";
const APP_NAME = "AGSLauncher for Windows";
const APP_VERSION = "1.0.0";
// The user agents of the Amazon Games app: its sign-in service client, its
// game services client, and its Electron window (the sign-in page).
export const AUTH_USER_AGENT = "AGSLauncher/1.0.0";
export const LAUNCHER_USER_AGENT = "com.amazon.agslauncher.win/3.0.9495.3";
export const LOGIN_WINDOW_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) @amzn/aga-electron-platform/1.0.0 Chrome/78.0.3904.130 Electron/7.1.9 Safari/537.36";
// Amazon sends the browser back to openid.return_to with the OpenID answer
// appended: https://www.amazon.com/?openid.assoc_handle=…&… Any query on the
// home page counts, whichever parameter comes first; authorizationCode finds
// the code wherever it is. The sign-in pages themselves are under /ap/, so
// they never match, and neither does the home page without a query.
export const DONE_PREFIXES: readonly string[] = [
  "https://www.amazon.com/?",
  "https://amazon.com/?",
];
// Where the code is in the address Amazon sends the browser to.
export const CODE_PARAM = "openid.oa2.authorization_code";
// Entitlements of this product line are in-game loot, not games (Playnite
// skips them).
const SKIPPED_PRODUCT_LINE = "Twitch:FuelEntitlement";

// Renew the access token when it expires within this long.
const REFRESH_MARGIN_MS = 120 * 1000;
// More pages than this is a nextToken that never ends: an error, not the
// end of the list.
export const MAX_PAGES = 200;
// The shortest pasted value taken as a bare authorization code. A guess on
// the safe side: the codes in Login with Amazon's documentation are 20
// characters long.
const MIN_CODE_CHARS = 10;
// The exceptions Amazon's services answer a token they don't take with, in
// the `__type` of a JSON error body
// (com.amazon.coral.service#UnrecognizedClientException).
export const AUTH_EXCEPTIONS = [
  "UnrecognizedClientException",
  "ExpiredTokenException",
  "InvalidTokenException",
  "NotAuthorizedException",
  "AccessDeniedException",
];

// What a login carries from beginLogin to completeLogin (PendingLogin.state).
// Secret: the verifier proves the code is SRM's.
export interface LoginState {
  codeVerifier: string;
  deviceSerial: string;
  clientId: string;
}

// What SRM keeps for an Amazon account.
export interface AmazonSession {
  accessToken: string;
  refreshToken: string;
  // When accessToken stops working, in milliseconds since 1970; 0 when
  // Amazon didn't say (it's then renewed on every refresh).
  expiresAt: number;
  // The serial this device was registered with; also the base of the
  // hardwareHash.
  deviceSerial: string;
}

// An entitlement of GetEntitlements, as much of it as is read.
export interface Entitlement {
  id?: string;
  product?: Product;
}

export interface Product {
  id?: string;
  title?: string;
  productLine?: string;
  sku?: string;
  iconUrl?: string;
}

// A page of GetEntitlements.
export interface EntitlementsPage {
  entitlements: Entitlement[];
  // The cursor of the next page; null after the last.
  nextToken: string | null;
}

export function beginLogin(): PendingLogin {
  const state = newLoginState();
  const startUrl = signInUrl(state.clientId, codeChallenge(state.codeVerifier));
  return {
    store: "amazon",
    startUrl,
    doneUrlPrefixes: [...DONE_PREFIXES],
    pageTextUrlPrefixes: [],
    cookieUrls: [],
    manual: {
      kind: "paste",
      // (tied to this login: its challenge goes with the state's verifier)
      url: startUrl,
      instructions:
        "Sign in to Amazon in your browser. When it lands on the Amazon home page, copy the full address from the address bar and paste it here.",
      placeholder:
        "https://www.amazon.com/?openid.assoc_handle=...&openid.oa2.authorization_code=...",
    },
    // Amazon's sign-in page for the Amazon Games app expects the app's own
    // window (BoilR's login window used it).
    userAgent: LOGIN_WINDOW_USER_AGENT,
    state: { ...state },
  };
}

async function completeLogin(
  pending: PendingLogin,
  capture: LoginCapture,
  ctx: StoreContext,
): Promise<StoreSession> {
  const state = loginState(pending);
  const code = authorizationCode(capture);
  let answer: any;
  try {
    answer = await ctx.http.sendJson(REGISTER_URL, {
      method: "POST",
      headers: {
        "User-Agent": AUTH_USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(registerRequest(code, state)),
    });
  } catch (err) {
    throw wrapErr(err, "Could not finish the Amazon sign-in");
  }
  const { session, accountName } = sessionFromRegistration(
    answer,
    state,
    ctx.now(),
  );
  return { accountName, data: session };
}

// The state beginLogin put in the PendingLogin.
export function loginState(pending: PendingLogin): LoginState {
  const state = pending?.state;
  if (
    !state ||
    typeof state.codeVerifier !== "string" ||
    state.codeVerifier === "" ||
    typeof state.deviceSerial !== "string" ||
    state.deviceSerial === "" ||
    typeof state.clientId !== "string" ||
    state.clientId === ""
  ) {
    throw new Error(
      "The Amazon sign-in lost its state. Start the sign-in again.",
    );
  }
  return {
    codeVerifier: state.codeVerifier,
    deviceSerial: state.deviceSerial,
    clientId: state.clientId,
  };
}

function readSession(session: StoreSession): AmazonSession {
  const data = sessionData<AmazonSession>(
    "amazon",
    session,
    (data) =>
      typeof data.accessToken === "string" &&
      typeof data.refreshToken === "string" &&
      typeof data.deviceSerial === "string" &&
      (data.expiresAt === undefined || typeof data.expiresAt === "number"),
  );
  // (only what SRM reads: whatever else a session holds is dropped on the
  // next save)
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt ?? 0,
    deviceSerial: data.deviceSerial,
  };
}

async function listLibrary(session: StoreSession, ctx: ListContext) {
  let amazon = readSession(session);
  let renewed = false;
  if (needsRefresh(amazon, ctx.now())) {
    amazon = await renew(session, ctx);
    renewed = true;
  }
  const entitlements = () =>
    fetchEntitlements(ctx, amazon).catch((err) => {
      throw wrapErr(err, "Could not load the Amazon library");
    });
  try {
    return { games: await entitlements() };
  } catch (err) {
    // Amazon can end a token before it expires: renew it once and try again.
    if (renewed || !isLoginRejected(err)) {
      throw err;
    }
    amazon = await renew(session, ctx);
    return { games: await entitlements() };
  }
}

// Renews the access token and saves the session right away, so the renewal
// isn't lost when SRM closes while the games are listed.
async function renew(session: StoreSession, ctx: ListContext) {
  const renewed = readSession(await refreshSession(session, ctx));
  session.data = renewed;
  await ctx.checkpoint(session);
  return renewed;
}

async function refreshSession(
  session: StoreSession,
  ctx: StoreContext,
): Promise<StoreSession> {
  const amazon = readSession(session);
  if (amazon.refreshToken === "") {
    throw loginRejected(
      "The saved Amazon login has no refresh token. Sign in again.",
    );
  }
  let answer: any;
  try {
    answer = await ctx.http.sendJson(TOKEN_URL, {
      method: "POST",
      headers: {
        "User-Agent": AUTH_USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(refreshRequest(amazon.refreshToken)),
    });
  } catch (err) {
    throw refreshFailure(err);
  }
  return { ...session, data: applyRefresh(amazon, answer, ctx.now()) };
}

async function fetchEntitlements(
  ctx: StoreContext,
  amazon: AmazonSession,
): Promise<OwnedGame[]> {
  const hash = hardwareHash(amazon.deviceSerial);
  // The cursor is the nextToken of the page before; the first page has none.
  const entitlements = await paginate<string | null, Entitlement>(
    "Amazon",
    null,
    MAX_PAGES,
    async (nextToken) => {
      const response = await ctx.http.request(ENTITLEMENTS_URL, {
        method: "POST",
        headers: {
          "User-Agent": LAUNCHER_USER_AGENT,
          "X-Amz-Target": ENTITLEMENTS_TARGET,
          "x-amzn-token": amazon.accessToken,
          "Content-Encoding": "amz-1.0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(entitlementsRequest(hash, nextToken)),
      });
      if (!response.ok) {
        // A failed one is looked at as a whole, status and body: Amazon
        // answers a token it doesn't take with 400 or 403 as well as 401.
        // (the whole body: an error message's snippet may be cut off)
        let body = "";
        try {
          body = await response.text();
        } catch {
          // (the status says what it can)
        }
        throw entitlementsFailure(
          response.status,
          withoutQuery(response.url),
          body,
        );
      }
      const page = entitlementsPage(
        parseEntitlementsText(response.url, await readText(response)),
      );
      return [page.entitlements, page.nextToken];
    },
  );
  return ownedGames(entitlements);
}

// Removes SRM from the account's registered devices, as nile does when it
// logs out.
async function signOut(session: StoreSession, ctx: StoreContext) {
  let amazon = readSession(session);
  if (needsRefresh(amazon, ctx.now())) {
    amazon = readSession(await refreshSession(session, ctx));
  }
  await ctx.http.send(DEREGISTER_URL, {
    method: "POST",
    headers: {
      "User-Agent": AUTH_USER_AGENT,
      Authorization: `Bearer ${amazon.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(deregisterRequest()),
  });
}

// ---- which answers mean "the login was refused" ----

// Whether a failed token renewal means Amazon refused the refresh token. The
// token service answers one it no longer takes the OAuth way, with 400
// (invalid_grant) or 401. Anything else (no connection, a timeout, a rate
// limit, 5xx) says nothing about the login.
export function refreshWasRefused(status: number | undefined) {
  return status === 400 || status === 401;
}

// A failed renewal as the error to report: a refused login only when Amazon
// refused the refresh token.
export function refreshFailure(err: unknown): Error {
  if (refreshWasRefused(statusOf(err))) {
    return loginRejected(
      `Amazon no longer accepts the saved login. Sign in again. (${messageOf(err)})`,
    );
  }
  return wrapErr(err, "Could not refresh the Amazon login");
}

// Whether an error's `__type` or message names one of the AUTH_EXCEPTIONS.
export function namesAuthException(
  errorType: string | undefined,
  message: string | undefined,
): boolean {
  return [errorType, message].some(
    (text) =>
      typeof text === "string" &&
      AUTH_EXCEPTIONS.some((name) =>
        text.toLowerCase().includes(name.toLowerCase()),
      ),
  );
}

// Whether a failed answer of Amazon's game services means the access token
// was refused. 401 always does. Amazon's services also answer a bad or
// expired token with 400 or 403, and then a JSON body names an auth
// exception. A 400 or 403 without one (a bot block, a captive portal, a web
// page) says nothing about the login, and neither does any other status.
export function loginWasRefused(status: number, body: string): boolean {
  if (status === 401) {
    return true;
  }
  if (status !== 400 && status !== 403) {
    return false;
  }
  let error: any;
  try {
    error = JSON.parse(body);
  } catch {
    return false;
  }
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }
  const text = (name: string) =>
    typeof error[name] === "string" ? (error[name] as string) : undefined;
  return namesAuthException(text("__type"), text("message") ?? text("Message"));
}

// The error for a failed GetEntitlements answer: a refused login when Amazon
// refused the token (so the token is renewed once and the request tried
// again), else the status error as it is (429 and 5xx are transient).
export function entitlementsFailure(
  status: number,
  url: string,
  body: string,
): Error {
  const failure = new HttpStatus(status, url, snippet(body));
  // (401 is a refused login as it is)
  if (status !== 401 && loginWasRefused(status, body)) {
    return loginRejected(
      `Amazon did not accept the saved login. Sign in again. (${failure.message})`,
      failure,
    );
  }
  return failure;
}

// ---- login pieces ----

// A new login's state. `random` gives n random bytes (tests set it).
export function newLoginState(
  random: (size: number) => Buffer = crypto.randomBytes,
): LoginState {
  const deviceSerial = random(16).toString("hex").toUpperCase();
  return {
    codeVerifier: codeVerifierFromBytes(random(32)),
    deviceSerial,
    clientId: clientId(deviceSerial),
  };
}

// The PKCE verifier: 32 random bytes, base64url without padding (43
// characters), as nile makes it.
export function codeVerifierFromBytes(bytes: Buffer): string {
  return bytes.toString("base64url");
}

// The PKCE S256 challenge: base64url (no padding) of the verifier's SHA-256.
export function codeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// The OAuth client id of a device: hex of "<serial>#<device type>" (nile's
// generate_client_id).
export function clientId(deviceSerial: string): string {
  return Buffer.from(`${deviceSerial}#${DEVICE_TYPE}`).toString("hex");
}

// The hardwareHash of GetEntitlements: upper-case hex SHA-256 of the device
// serial (nile).
export function hardwareHash(deviceSerial: string): string {
  return crypto
    .createHash("sha256")
    .update(deviceSerial)
    .digest("hex")
    .toUpperCase();
}

export function signInUrl(clientId: string, challenge: string): string {
  const query = new URLSearchParams([
    ["openid.ns", "http://specs.openid.net/auth/2.0"],
    ["openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select"],
    ["openid.identity", "http://specs.openid.net/auth/2.0/identifier_select"],
    ["openid.mode", "checkid_setup"],
    ["openid.oa2.scope", "device_auth_access"],
    ["openid.ns.oa2", "http://www.amazon.com/ap/ext/oauth/2"],
    ["openid.oa2.response_type", "code"],
    ["openid.oa2.code_challenge_method", "S256"],
    ["openid.oa2.client_id", `device:${clientId}`],
    ["language", "en_US"],
    ["marketPlaceId", MARKETPLACE_ID],
    ["openid.return_to", RETURN_TO],
    ["openid.pape.max_auth_age", "0"],
    ["openid.assoc_handle", ASSOC_HANDLE],
    ["pageId", ASSOC_HANDLE],
    ["openid.oa2.code_challenge", challenge],
  ]);
  return `${SIGN_IN_URL}?${query}`;
}

// The authorization code from the window's redirect or from what the user
// pasted: the address Amazon sent the browser to, with or without its
// https://, the query of that address, or the bare code.
export function authorizationCode(capture: LoginCapture): string {
  const raw = (capture.finalUrl ?? capture.pasted ?? "").trim();
  if (raw === "") {
    throw new Error(
      "Nothing to finish the Amazon sign-in with. Sign in, then paste the full address from the browser's address bar.",
    );
  }
  const questionMark = raw.indexOf("?");
  const query =
    questionMark >= 0
      ? raw.slice(questionMark + 1)
      : raw.includes("=")
        ? raw
        : undefined;
  if (query === undefined) {
    if (looksLikeCode(raw)) {
      return raw;
    }
    throw new Error(
      "That does not look like the address Amazon sent you to. Sign in, then paste the full address from the browser's address bar.",
    );
  }
  const params = new URLSearchParams(query.split("#")[0]);
  const param = (name: string) => params.get(name) || undefined;
  const code = param(CODE_PARAM);
  if (code) {
    return code;
  }
  if (param("openid.mode") === "cancel") {
    throw new Error("The Amazon sign-in was cancelled.");
  }
  throw new Error(
    `That address has no Amazon sign-in code (${CODE_PARAM}). Sign in again and copy the full address the browser lands on after signing in.`,
  );
}

// Whether a pasted value without a query can be a code on its own: long
// enough, and made of the characters a code has. An address without its
// query (www.amazon.com/) has dots or slashes and isn't one.
export function looksLikeCode(value: string): boolean {
  return value.length >= MIN_CODE_CHARS && /^[A-Za-z0-9_-]+$/.test(value);
}

// The body of auth/register, as the Amazon Games app sends it.
export function registerRequest(code: string, state: LoginState) {
  return {
    auth_data: {
      authorization_code: code,
      client_domain: "DeviceLegacy",
      client_id: state.clientId,
      code_algorithm: "SHA-256",
      code_verifier: state.codeVerifier,
      use_global_authentication: false,
    },
    registration_data: {
      app_name: APP_NAME,
      app_version: APP_VERSION,
      device_model: "Windows",
      device_name: null as string | null,
      device_serial: state.deviceSerial,
      device_type: DEVICE_TYPE,
      domain: "Device",
      os_version: "10.0.19044.0",
    },
    requested_extensions: ["customer_info", "device_info"],
    requested_token_type: ["bearer", "mac_dms"],
    user_context_map: {},
  };
}

// The device registration as the session to save and the account name.
export function sessionFromRegistration(
  answer: any,
  state: LoginState,
  now: number,
): { session: AmazonSession; accountName: string | null } {
  const body = answer?.response;
  if (!body || typeof body !== "object") {
    throw new Error("Amazon's device registration returned no response.");
  }
  const success = objectOr(body.success);
  if (!success) {
    const error = objectOr(body.error);
    if (error) {
      throw new Error(
        `Amazon refused to register SRM: ${stringOr(error.message) ?? "no reason given"} (${stringOr(error.code) ?? "no code"}). Sign in again.`,
      );
    }
    throw new Error(
      "Amazon's device registration returned neither tokens nor an error.",
    );
  }
  const bearer = objectOr(objectOr(success.tokens)?.bearer);
  const accessToken = stringOr(bearer?.access_token);
  const refreshToken = stringOr(bearer?.refresh_token);
  if (!accessToken || !refreshToken) {
    // (nothing of the answer in the message: it holds tokens)
    throw new Error("Amazon's device registration returned no tokens.");
  }
  const extensions = objectOr(success.extensions);
  const customer = objectOr(extensions?.customer_info);
  const device = objectOr(extensions?.device_info);
  const accountName =
    [customer?.name, customer?.given_name].find(
      (name): name is string => typeof name === "string" && name.trim() !== "",
    ) ?? null;
  return {
    session: {
      accessToken,
      refreshToken,
      expiresAt: expiresAt(bearer.expires_in, now),
      deviceSerial:
        stringOr(device?.device_serial_number) || state.deviceSerial,
    },
    accountName,
  };
}

// The body of auth/token to renew the access token.
export function refreshRequest(refreshToken: string) {
  return {
    source_token: refreshToken,
    source_token_type: "refresh_token",
    requested_token_type: "access_token",
    app_name: APP_NAME,
    app_version: APP_VERSION,
  };
}

// The session with the renewed access token from auth/token's answer. The
// refresh token stays: Amazon doesn't rotate it.
export function applyRefresh(
  amazon: AmazonSession,
  answer: any,
  now: number,
): AmazonSession {
  const token = stringOr(answer?.access_token);
  if (token) {
    return {
      ...amazon,
      accessToken: token,
      expiresAt: expiresAt(answer.expires_in, now),
    };
  }
  const reason = stringOr(answer?.error_description) || stringOr(answer?.error);
  if (reason) {
    // Amazon said why it gives no token: it refused the refresh token.
    throw loginRejected(
      `Amazon did not refresh the login (${reason}). Sign in again.`,
    );
  }
  // An answer that's neither a token nor a refusal says nothing about the
  // login.
  throw new Error(
    "Unexpected answer from Amazon when refreshing the login: no access token in it.",
  );
}

// The body of auth/deregister.
export function deregisterRequest() {
  return {
    request_metadata: { app_name: APP_NAME, app_version: APP_VERSION },
  };
}

// When a token that lasts `expiresIn` seconds from `now` ends, or 0 when
// Amazon didn't say. Amazon sends it as a number in some answers and as text
// in others.
export function expiresAt(expiresIn: unknown, now: number): number {
  let seconds: number | undefined;
  if (
    typeof expiresIn === "number" &&
    Number.isSafeInteger(expiresIn) &&
    expiresIn >= 0
  ) {
    seconds = expiresIn;
  } else if (typeof expiresIn === "string" && /^\d+$/.test(expiresIn.trim())) {
    seconds = Number(expiresIn.trim());
  }
  return seconds === undefined ? 0 : now + seconds * 1000;
}

export function needsRefresh(amazon: AmazonSession, now: number) {
  return (
    amazon.accessToken === "" || amazon.expiresAt <= now + REFRESH_MARGIN_MS
  );
}

// ---- library pieces ----

// The body of GetEntitlements, as the Amazon Games app sends it.
export function entitlementsRequest(hash: string, nextToken: string | null) {
  return {
    Operation: "GetEntitlements",
    clientId: "Sonic",
    syncPoint: null as number | null,
    nextToken,
    maxResults: 50,
    productIdFilter: null as string | null,
    keyId: ENTITLEMENTS_KEY_ID,
    hardwareHash: hash,
  };
}

// A GetEntitlements answer with a success status, as JSON.
export function parseEntitlementsText(finalUrl: string, text: string): any {
  let answer: any;
  try {
    answer = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Unexpected response from ${withoutQuery(finalUrl)}: ${messageOf(err)}. Body starts with: ${snippet(text)}`,
    );
  }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    throw new Error(
      `Unexpected response from ${withoutQuery(finalUrl)}: not an object. Body starts with: ${snippet(text)}`,
    );
  }
  return answer;
}

// Reads a page of GetEntitlements. An answer without the list is an error:
// a refused login when it names an auth exception, else one that says
// nothing about the login. It's never read as an empty page, nor is a
// nextToken that isn't text read as the last page: either would save a list
// cut short.
export function entitlementsPage(answer: any): EntitlementsPage {
  const unexpected = (detail: string) =>
    new Error(
      `Unexpected answer from Amazon instead of the list of games: ${detail}. Body starts with: ${snippet(JSON.stringify(answer) ?? "")}`,
    );
  const list = answer?.entitlements;
  if (list === undefined || list === null) {
    const errorType = stringOr(answer?.__type);
    const message = stringOr(answer?.message) ?? stringOr(answer?.Message);
    const reason = `${errorType ? `${errorType}: ` : ""}${message ?? "no reason given"}`;
    if (namesAuthException(errorType, message)) {
      throw loginRejected(
        `Amazon did not accept the saved login (${reason}). Sign in again.`,
      );
    }
    throw new Error(`Amazon did not send the list of games: ${reason}`);
  }
  if (!Array.isArray(list)) {
    throw unexpected("`entitlements` is not a list");
  }
  const next = answer.nextToken;
  if (next !== undefined && next !== null && typeof next !== "string") {
    throw unexpected("`nextToken` is not text");
  }
  return {
    entitlements: list.map(readEntitlement),
    nextToken: next ? next : null,
  };
}

function readEntitlement(entitlement: any): Entitlement {
  const product = objectOr(entitlement?.product);
  return {
    id: stringOr(entitlement?.id),
    product: product
      ? {
          id: stringOr(product.id),
          title: stringOr(product.title),
          productLine: stringOr(product.productLine),
          sku: stringOr(product.sku),
          iconUrl: stringOr(objectOr(product.productDetail)?.iconUrl),
        }
      : undefined,
  };
}

// Games from entitlements: skips in-game loot and entries without a product
// id or title, and keeps the first entitlement of each product.
export function ownedGames(entitlements: Entitlement[]): OwnedGame[] {
  const seen = new Set<string>();
  const games: OwnedGame[] = [];
  for (const entitlement of entitlements) {
    const product = entitlement.product;
    if (!product || product.productLine === SKIPPED_PRODUCT_LINE) {
      continue;
    }
    const id = product.id;
    if (!id || id.trim() === "") {
      continue;
    }
    const title = product.title ? cleanTitle(product.title) : "";
    if (title === "" || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const extra: Record<string, string> = {};
    if (entitlement.id) {
      extra.entitlement_id = entitlement.id;
    }
    if (product.sku) {
      extra.sku = product.sku;
    }
    if (product.iconUrl) {
      extra.icon_url = product.iconUrl;
    }
    games.push(ownedGame("amazon", id, title, extra));
  }
  return games;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectOr(value: unknown): { [key: string]: any } | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { [key: string]: any })
    : undefined;
}

export const amazonClient: StoreClient = {
  key: "amazon",
  beginLogin,
  completeLogin,
  refreshSession,
  listLibrary,
  signOut,
};
