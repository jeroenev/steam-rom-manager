// EA app: sign in on ea.com and list the owned games. Ported from BoilR's
// ea.rs, which follows Jeshibu's EaLibrary for Playnite
// (github.com/Jeshibu/PlayniteExtensions, source/EaLibrary:
// Services/EaWebsite.cs and EaLibraryDataGatherer.cs).
//
// Login: the window opens www.ea.com/login. EA's site sends the browser
// through accounts.ea.com and signin.ea.com and back to
// https://www.ea.com/login_check?code=…; by then accounts.ea.com has set its
// session cookies (sid, remid). The login is those cookies: they stay in
// EA's own browser partition (persist:, see the host), which sends them and
// keeps what EA renews, as a browser would. Nothing secret is in the session
// SRM saves. (BoilR, without a browser's cookie store, kept the cookies a
// browser would send to accounts.ea.com in its session instead, and wrote
// back the ones EA renewed.)
//
// Library: every refresh trades those cookies for a fresh, short-lived
// access token (accounts.ea.com/connect/auth?client_id=ORIGIN_JS_SDK&…
// &prompt=none), lists the owned games with the GraphQL query EA's website
// uses (getPreloadedOwnedGames), then looks up each offer's content id in
// EA's catalog (legacyOffers).
//
// The game list is asked for by the hash of a query EA's website registered
// (a persisted query); SRM does not have the query's text. When EA's website
// moves to another query, the hash stops working and SRM needs an update.
//
// Not listed:
// - games the account only has through a linked Steam or Epic account (see
//   onlyThroughLinkedStore);
// - open trials the account holds nothing else of (see isUnownedTrial).
//
// OwnedGame.id is the offer id (Origin.OFR.50.0002487, OFB-EAST:52735,
// DR:225064100). extra: `content_id`, the catalog content id (1028663; for
// some older games a short name). It is:
// - what the EA app's installer data (__Installer/installerdata.xml) lists
//   as contentIDs for an installed copy. installed-ids.ts reads those, and
//   the Store Account parser matches them with an owned game's offer id and
//   content id;
// - what the EA app's install/launch link takes
//   (origin2://game/launch/?offerIds=<content_id>, targets.ts; EaLibrary's
//   EaControllerHelper.cs).
// Absent when the catalog lookup failed and no earlier list had it: the
// offer id is used instead.

import * as _ from "lodash";
import {
  BROWSER_USER_AGENT,
  HttpStatus,
  cleanTitle,
  domainMatches,
  isLoginRejected,
  isTransientStatus,
  loginRejected,
  messageOf,
  paginate,
  readText,
  snippet,
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

export const LOGIN_URL = "https://www.ea.com/login";
// EA's site redirects here (with ?code=…) once accounts.ea.com accepted the
// sign-in.
export const DONE_PREFIX = "https://www.ea.com/login_check";
// The host whose cookies carry the EA sign-in.
export const ACCOUNTS_HOST = "accounts.ea.com";
// Where a refresh gets its access token. A cookie EA sets here without a
// Path is scoped to /connect, and isn't handed out for the host's root URL:
// the login window is asked for this URL's cookies too.
export const AUTH_URL = "https://accounts.ea.com/connect/auth";
const TOKEN_QUERY =
  "client_id=ORIGIN_JS_SDK&response_type=token&redirect_uri=nucleus:rest&prompt=none";
export const TOKEN_URL = `${AUTH_URL}?${TOKEN_QUERY}`;
// Cookies set for all of ea.com come with these too.
export const COOKIE_URLS: readonly string[] = [
  `https://${ACCOUNTS_HOST}/`,
  AUTH_URL,
];
export const GRAPHQL_URL =
  "https://service-aggregation-layer.juno.ea.com/graphql";
export const OWNED_GAMES_QUERY_HASH =
  "779f1cd1355699752e20c0b3877847f4e3010ef5de131c248e98f8eff84f0718";
export const PAGE_SIZE = 500;
export const FIRST_PAGE = "0";
// More pages than this is a service that keeps reporting more pages: an
// error, not the end of the list.
export const MAX_PAGES = 50;
export const LEGACY_OFFER_BATCH = 100;

// EA's own entitlement record. Most games bought on EA carry it, but so do
// games bought on Steam (EaLibrary's sample answer has ["STEAM",
// "ENTITLEMENT_GRANT"]), so on its own it doesn't say where a game comes
// from.
const GRANT = "ENTITLEMENT_GRANT";

// Every way an account can have a game, as EaLibrary asks for them
// (EaWebsite.GetGamesUrl). The STEAM… and EPIC… ones come from a linked
// Steam or Epic account (isLinkedStore); VAULT is EA Play and XGP_VAULT Xbox
// Game Pass.
export const OWNERSHIP_METHODS: readonly string[] = [
  "UNKNOWN",
  "ASSOCIATION",
  "PURCHASE",
  "REDEMPTION",
  "GIFT_RECEIPT",
  GRANT,
  "DIRECT_ENTITLEMENT",
  "PRE_ORDER_PURCHASE",
  "VAULT",
  "XGP_VAULT",
  "STEAM",
  "STEAM_VAULT",
  "STEAM_SUBSCRIPTION",
  "EPIC",
  "EPIC_VAULT",
  "EPIC_SUBSCRIPTION",
];

// What SRM keeps for an EA account. The login itself is the cookies in EA's
// browser partition, which the host keeps; none of them are in here.
export interface EaSession {
  // When the login window handed the sign-in over, in milliseconds since
  // 1970.
  signedInAt: number;
}

export function beginLogin(): PendingLogin {
  return {
    store: "ea",
    startUrl: LOGIN_URL,
    doneUrlPrefixes: [DONE_PREFIX],
    pageTextUrlPrefixes: [],
    cookieUrls: [...COOKIE_URLS],
    // The sign-in lives in HttpOnly cookies, which a user can't reasonably
    // copy.
    manual: { kind: "unsupported" },
    // The one every request sends (StoreHttp), so EA sees the session used
    // under the user agent it was made with.
    userAgent: BROWSER_USER_AGENT,
    state: {},
  };
}

// The cookies of a sign-in that carry it: the ones a browser would send to
// accounts.ea.com, the only host that is asked for a token.
export function sessionCookies(captured: readonly StoreCookie[]) {
  return keepForHosts(captured, [ACCOUNTS_HOST]);
}

// The cookies a browser would send to any of `hosts`, one per name and
// domain (the last wins). Cookies for other hosts of the same site (its
// shop, its forum, trackers) aren't needed to list games. (BoilR's
// cookie_jar::keep_for_hosts.)
export function keepForHosts(
  cookies: readonly StoreCookie[],
  hosts: readonly string[],
): StoreCookie[] {
  let kept: StoreCookie[] = [];
  for (const cookie of cookies) {
    if (
      cookie.domain.replace(/^\.+/, "") === "" ||
      !hosts.some((host) => domainMatches(cookie.domain, host))
    ) {
      continue;
    }
    kept = kept.filter(
      (c) => !(c.name === cookie.name && c.domain === cookie.domain),
    );
    kept.push(cookie);
  }
  return kept;
}

async function completeLogin(
  _pending: PendingLogin,
  capture: LoginCapture,
  ctx: StoreContext,
): Promise<StoreSession> {
  if (capture.cookies === undefined && capture.pasted !== undefined) {
    throw new Error("EA can only be signed in to with SRM's sign-in window.");
  }
  // (the window signed in in the partition the store's requests go through:
  // its cookies only show that the sign-in happened)
  if (sessionCookies(capture.cookies ?? []).length === 0) {
    throw new Error(
      `The EA sign-in window handed over no cookies for ${ACCOUNTS_HOST}, so the sign-in could not be kept. Try signing in again.`,
    );
  }
  let token: string;
  try {
    token = await accessToken(ctx);
  } catch (err) {
    throw wrapErr(err, "Signing in to EA did not finish");
  }
  const data: EaSession = { signedInAt: ctx.now() };
  return { accountName: await playerName(ctx, token), data };
}

function readSession(session: StoreSession) {
  return sessionData<EaSession>(
    "ea",
    session,
    (data) => typeof data.signedInAt === "number",
  );
}

async function listLibrary(
  session: StoreSession,
  ctx: ListContext,
): Promise<ListResult> {
  readSession(session);
  // (EA renews its cookies in the partition as it hands the token out)
  let token: string;
  try {
    token = await accessToken(ctx);
  } catch (err) {
    throw wrapErr(err, "Could not renew the EA sign-in");
  }
  if (session.accountName === null) {
    session.accountName = await playerName(ctx, token);
  }
  let games: OwnedGame[];
  try {
    games = await paginate(
      "EA's game list",
      FIRST_PAGE,
      MAX_PAGES,
      async (cursor: string) => {
        const page = await graphqlGet(
          ctx,
          token,
          ownedGamesUrl(cursor),
          parseOwnedGamesPage,
        );
        return [page.games, page.next];
      },
    );
  } catch (err) {
    throw wrapErr(err, "Could not load the EA library");
  }

  // Content ids only improve the install link and the matching of installed
  // copies; without them the offer id is used, so a failed lookup never
  // fails the library. Ids the lookup didn't return come from the previous
  // list, so one failed lookup doesn't unmatch installed games until the
  // next refresh. (Like EaLibrary, the catalog lookup is sent without a
  // token.)
  const offerIds = _.uniq(games.map((game) => game.id));
  const { found, failed } = await lookupInBatches(
    offerIds,
    LEGACY_OFFER_BATCH,
    (batch) => legacyContentIds(ctx, batch),
  );
  const withIds = withContentIds(games, found, ctx.previous);
  let partial = false;
  if (failed !== null) {
    ctx.log(
      `Could not look up EA content ids, using the ones from before: ${messageOf(failed)}`,
    );
    partial = withIds.some((game) => !game.extra.content_id);
  }
  return { games: withIds, partial };
}

// Looks ids up `size` at a time. The first batch that fails ends the
// lookup: with the catalog down, every further batch would only wait for
// its own timeout. Returns what was found until then, and the failure
// (null when there was none).
export async function lookupInBatches(
  ids: readonly string[],
  size: number,
  lookup: (batch: string[]) => Promise<Map<string, string>>,
): Promise<{ found: Map<string, string>; failed: unknown }> {
  const found = new Map<string, string>();
  for (const batch of _.chunk(ids, Math.max(size, 1))) {
    try {
      for (const [offerId, contentId] of await lookup(batch)) {
        found.set(offerId, contentId);
      }
    } catch (err) {
      return { found, failed: err ?? new Error("The lookup failed") };
    }
  }
  return { found, failed: null };
}

// The games with the content ids found, or else the ones the previous list
// had.
export function withContentIds(
  games: readonly OwnedGame[],
  contentIds: ReadonlyMap<string, string>,
  previous: readonly OwnedGame[],
): OwnedGame[] {
  return games.map((game) => {
    const contentId =
      contentIds.get(game.id) ||
      previous.find((p) => p.id === game.id && !!p.extra?.content_id)?.extra
        .content_id;
    return contentId
      ? { ...game, extra: { ...game.extra, content_id: contentId } }
      : game;
  });
}

// A fresh access token for the cookies in EA's partition.
async function accessToken(ctx: StoreContext): Promise<string> {
  const response = await ctx.http.request(TOKEN_URL, {
    headers: { Accept: "application/json" },
  });
  return tokenFromAnswer(response.status, await readText(response));
}

// The display name of the signed-in account, if EA hands it out. Never
// fails a login or a refresh: it's only for display.
async function playerName(
  ctx: StoreContext,
  token: string,
): Promise<string | null> {
  try {
    const response = await ctx.http.request(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: PLAYER_NAME_BODY,
    });
    return parsePlayerName(await readText(response));
  } catch {
    return null;
  }
}

export const PLAYER_NAME_BODY = JSON.stringify({
  query: "query { me { player { displayName } } }",
});

// GETs a GraphQL URL and reads the answer with `parse`; see graphqlAnswer.
async function graphqlGet<T>(
  ctx: StoreContext,
  token: string,
  url: string,
  parse: (body: string) => T,
): Promise<T> {
  const response = await ctx.http.request(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return graphqlAnswer(response.status, await readText(response), parse);
}

async function legacyContentIds(
  ctx: StoreContext,
  offerIds: string[],
): Promise<Map<string, string>> {
  const response = await ctx.http.send(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: legacyOffersBody(offerIds),
  });
  return parseLegacyOffers(await readText(response));
}

// The same query EaLibrary sends (getLegacyCatalogDefs), cut down to the
// fields SRM uses. (The keys in the order BoilR sends them.)
export function legacyOffersBody(offerIds: readonly string[]) {
  return JSON.stringify({
    operationName: "getLegacyCatalogDefs",
    query:
      "query getLegacyCatalogDefs($offerIds: [String!]!, $locale: Locale) { legacyOffers(offerIds: $offerIds, locale: $locale) { offerId: id contentId } }",
    variables: { locale: "DEFAULT", offerIds },
  });
}

// The URL of one page of the owned games: the variables and persisted-query
// hash EaLibrary uses (EaWebsite.GetGamesUrl). The keys are in the order
// BoilR sends them (sorted: its JSON objects are sorted maps).
export function ownedGamesUrl(cursor: string): string {
  const variables = {
    addFieldsToPreloadGames: true,
    entitlementEnabled: true,
    isMac: false,
    limit: PAGE_SIZE,
    locale: "en",
    next: cursor,
    ownershipMethods: OWNERSHIP_METHODS,
    platforms: ["PC"],
    storefronts: ["EA", "STEAM", "EPIC"],
    type: ["DIGITAL_FULL_GAME", "PACKAGED_FULL_GAME"],
  };
  const extensions = {
    persistedQuery: { sha256Hash: OWNED_GAMES_QUERY_HASH, version: 1 },
  };
  const url = new URL(GRAPHQL_URL);
  url.searchParams.append("operationName", "getPreloadedOwnedGames");
  url.searchParams.append("variables", JSON.stringify(variables));
  url.searchParams.append("extensions", JSON.stringify(extensions));
  return url.toString();
}

// ---- Reading answers (pure) ----

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failedWith(status: number, url: string, body: string) {
  return new HttpStatus(status, url, snippet(body));
}

const isSuccess = (status: number) => status >= 200 && status < 300;

// The access token in EA's answer to the token request, or why there is
// none. Only EA saying that a login is required counts as a refused login
// (and a bare 401, by its status): an outage or a rate limit is transient,
// and anything else is reported as it is.
export function tokenFromAnswer(status: number, body: string): string {
  let answer: JsonObject = {};
  try {
    const parsed = JSON.parse(body);
    answer = isObject(parsed) ? parsed : {};
  } catch {
    // (no JSON: the status says what happened)
  }
  const success = isSuccess(status);
  const token = answer.access_token;
  if (success && typeof token === "string" && token !== "") {
    return token;
  }
  if (isTransientStatus(status)) {
    throw failedWith(status, AUTH_URL, body);
  }
  const errors = [answer.error, answer.error_code].filter(
    (error): error is string => typeof error === "string",
  );
  if (errors.includes("login_required")) {
    throw loginRejected(
      'EA no longer accepts the saved sign-in (it answered "login_required"). Sign in again.',
    );
  }
  if (errors.length > 0) {
    throw new Error(
      `EA did not hand out an access token: it answered "${snippet(errors[0])}" (HTTP ${status})`,
    );
  }
  if (!success) {
    throw failedWith(status, AUTH_URL, body);
  }
  throw new Error(
    `Unexpected answer from EA's sign-in service, without an access token: ${snippet(body)}`,
  );
}

// Whether a body is a GraphQL answer: an object with `data` or a list of
// `errors`.
export function isGraphql(body: string): boolean {
  try {
    const answer = JSON.parse(body);
    return (
      isObject(answer) && ("data" in answer || Array.isArray(answer.errors))
    );
  } catch {
    return false;
  }
}

// Reads an answer of EA's GraphQL service with `parse`.
//
// A failure status is always an error. When its body is a GraphQL answer,
// EA's own error in it is reported, because it says more than the status:
// EA answers a rejected token with 401 and an UNAUTHENTICATED error, and a
// persisted query it no longer knows with an error too. That holds unless
// the status says "sign in again" (401) or "not now" (429, 5xx) and EA's
// error doesn't: then the status is reported, so the failure keeps its
// kind.
export function graphqlAnswer<T>(
  status: number,
  body: string,
  parse: (body: string) => T,
): T {
  if (isSuccess(status)) {
    return parse(body);
  }
  if (isGraphql(body)) {
    try {
      parse(body);
    } catch (err) {
      const statusSaysMore = status === 401 || isTransientStatus(status);
      if (isLoginRejected(err) || !statusSaysMore) {
        throw err;
      }
    }
  }
  throw failedWith(status, GRAPHQL_URL, body);
}

// An answer that doesn't have the shape SRM reads: a field of another kind
// than EA sends.
class UnexpectedShape extends Error {}

type Kind = "string" | "boolean" | "object" | "array";

// A field as BoilR reads an optional one: missing and null are none; a
// value of another kind means the answer isn't one SRM can read.
function field(
  obj: JsonObject,
  name: string,
  kind: "string",
): string | undefined;
function field(
  obj: JsonObject,
  name: string,
  kind: "boolean",
): boolean | undefined;
function field(
  obj: JsonObject,
  name: string,
  kind: "object",
): JsonObject | undefined;
function field(
  obj: JsonObject,
  name: string,
  kind: "array",
): unknown[] | undefined;
function field(obj: JsonObject, name: string, kind: Kind): unknown {
  const value = obj[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  const fits =
    kind === "array"
      ? Array.isArray(value)
      : kind === "object"
        ? isObject(value)
        : typeof value === kind;
  if (!fits) {
    const article = kind === "array" || kind === "object" ? "an" : "a";
    throw new UnexpectedShape(`\`${name}\` is not ${article} ${kind}`);
  }
  return value;
}

interface GraphQlError {
  message?: string;
  code?: string;
}

interface GraphQlAnswer {
  // Undefined when the answer has none (or null).
  data: unknown;
  errors: GraphQlError[];
}

// The answer of EA's GraphQL service, read by `read`; an answer that isn't
// GraphQL, or whose fields aren't of the kinds SRM reads, is an unexpected
// answer from `service`.
function readGraphql<T>(
  service: string,
  body: string,
  read: (answer: GraphQlAnswer) => T,
): T {
  const unexpected = (detail: string) =>
    new Error(
      `Unexpected answer from ${service}: ${detail}. Body starts with: ${snippet(body)}`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw unexpected(messageOf(err));
  }
  try {
    if (!isObject(parsed)) {
      throw new UnexpectedShape("not a GraphQL answer");
    }
    const errors = (field(parsed, "errors", "array") ?? []).map(
      (error): GraphQlError => {
        if (!isObject(error)) {
          throw new UnexpectedShape("an error is not an object");
        }
        const extensions = field(error, "extensions", "object");
        return {
          message: field(error, "message", "string"),
          code: extensions ? field(extensions, "code", "string") : undefined,
        };
      },
    );
    return read({ data: parsed.data ?? undefined, errors });
  } catch (err) {
    if (err instanceof UnexpectedShape) {
      throw unexpected(err.message);
    }
    throw err;
  }
}

// Apollo's answer to the hash of a persisted query it doesn't know (any
// more).
function isUnknownPersistedQuery(error: GraphQlError) {
  return (
    ["PERSISTED_QUERY_NOT_FOUND", "PERSISTED_QUERY_NOT_SUPPORTED"].includes(
      error.code ?? "",
    ) ||
    ["PersistedQueryNotFound", "PersistedQueryNotSupported"].includes(
      error.message ?? "",
    )
  );
}

// What `pick` finds in the data, or a readable error built from `errors`.
// Partial data (data plus errors on some fields) is kept, unless EA says the
// sign-in isn't valid.
function intoData<T>(
  answer: GraphQlAnswer,
  what: string,
  pick: (data: JsonObject) => T | undefined,
): T {
  if (answer.errors.some((error) => error.code === "UNAUTHENTICATED")) {
    throw loginRejected(
      `EA no longer accepts the saved sign-in (it answered "not authenticated" while listing ${what}). Sign in again.`,
    );
  }
  if (answer.errors.some(isUnknownPersistedQuery)) {
    throw new Error(
      `EA changed how its website lists ${what}, and SRM needs an update to read them. (EA no longer knows the request SRM sends.)`,
    );
  }
  const data = answer.data;
  if (data !== undefined && !isObject(data)) {
    throw new UnexpectedShape("`data` is not an object");
  }
  const found = isObject(data) ? pick(data) : undefined;
  if (found !== undefined) {
    return found;
  }
  const messages = answer.errors
    .map((error) => error.message)
    .filter((message): message is string => !!message);
  throw new Error(
    `EA could not list ${what}: ${messages.length ? snippet(messages.join("; ")) : "no data in the answer"}`,
  );
}

// A page of the owned games.
export interface OwnedGamesPage {
  games: OwnedGame[];
  // The cursor of the next page; null after the last.
  next: string | null;
}

export function parseOwnedGamesPage(body: string): OwnedGamesPage {
  return readGraphql("EA's library service", body, (answer) => {
    const page = intoData(answer, "your games", (data) => {
      const me = field(data, "me", "object");
      return me ? field(me, "ownedGameProducts", "object") : undefined;
    });
    const games: OwnedGame[] = [];
    for (const item of field(page, "items", "array") ?? []) {
      if (!isObject(item)) {
        throw new UnexpectedShape("a game in the list is not an object");
      }
      const game = toOwnedGame(item);
      if (game) {
        games.push(game);
      }
    }
    // (an empty cursor ends the list like a missing one)
    const next = field(page, "next", "string");
    return { games, next: next ? next : null };
  });
}

function toOwnedGame(item: JsonObject): OwnedGame | undefined {
  const offerId =
    field(item, "originOfferId", "string") || field(item, "id", "string");
  const product = field(item, "product", "object");
  if (!offerId || !product) {
    return undefined;
  }
  const user = field(product, "gameProductUser", "object");
  // (the account's trial of this product, with its remaining time, when it
  // started one; whatever its shape)
  const trialStarted =
    user !== undefined &&
    user.gameProductUserTrial !== undefined &&
    user.gameProductUserTrial !== null;
  const methods = (
    (user && field(user, "ownershipMethods", "array")) ||
    []
  ).map((method) => {
    if (typeof method !== "string") {
      throw new UnexpectedShape("an ownership method is not a string");
    }
    return method;
  });
  // (the product is itself an open trial, not the game)
  const trialProduct = field(product, "isUngatedTrial", "boolean") === true;
  if (
    onlyThroughLinkedStore(methods) ||
    isUnownedTrial(trialProduct, trialStarted, methods)
  ) {
    return undefined;
  }
  const baseItem = field(product, "baseItem", "object");
  const title =
    cleanTitleOf(field(product, "name", "string")) ||
    cleanTitleOf(baseItem ? field(baseItem, "title", "string") : undefined);
  return title ? ownedGame("ea", offerId, title) : undefined;
}

function cleanTitleOf(title: string | undefined) {
  return title === undefined ? "" : cleanTitle(title);
}

// An ownership method that comes from a linked Steam or Epic account: a
// purchase there (STEAM, EPIC) or an EA Play subscription taken out there
// (STEAM_VAULT, STEAM_SUBSCRIPTION, EPIC_VAULT, EPIC_SUBSCRIPTION).
export function isLinkedStore(method: string) {
  return method.startsWith("STEAM") || method.startsWith("EPIC");
}

// Whether nothing but a linked Steam or Epic account gives the EA account
// this game. Such a game belongs to that store (Steam has it already, the
// Epic account adds it), and the EA app can't install it, so it isn't
// listed.
//
// Anything EA itself gives wins: a purchase or a code redeemed on EA, EA
// Play, Game Pass, and methods SRM doesn't know. The exception is
// ENTITLEMENT_GRANT, which comes with Steam purchases too and so proves
// nothing next to a linked store.
export function onlyThroughLinkedStore(methods: readonly string[]) {
  return (
    methods.some(isLinkedStore) &&
    methods.every((method) => isLinkedStore(method) || method === GRANT)
  );
}

// Whether an entry is a trial of a game the account doesn't have.
//
// EA's answer carries several trial fields, and most of them say nothing
// about ownership: in EaLibrary's sample answer a bought game (A Way Out,
// with its free Friend's Pass) has both trialDetails and a
// gameProductUserTrial. So an entry is only skipped when everything agrees:
// EA marks the product itself as an open trial (isUngatedTrial), the
// account started that trial, and nothing but the grant a free trial is
// claimed with gives the account the product. In every other case the game
// is kept.
export function isUnownedTrial(
  trialProduct: boolean,
  trialStarted: boolean,
  methods: readonly string[],
) {
  return (
    trialProduct && trialStarted && methods.every((method) => method === GRANT)
  );
}

// Offer id to content id.
export function parseLegacyOffers(body: string): Map<string, string> {
  return readGraphql("EA's catalog", body, (answer) => {
    const offers = intoData(
      answer,
      "game details",
      (data) => field(data, "legacyOffers", "array") ?? [],
    );
    const ids = new Map<string, string>();
    for (const offer of offers) {
      if (offer === null) {
        continue;
      }
      if (!isObject(offer)) {
        throw new UnexpectedShape("an offer is not an object");
      }
      const offerId = field(offer, "offerId", "string");
      const contentId = field(offer, "contentId", "string");
      if (offerId && contentId) {
        ids.set(offerId, contentId);
      }
    }
    return ids;
  });
}

// The account's display name in EA's answer, or null.
export function parsePlayerName(body: string): string | null {
  try {
    const name = JSON.parse(body)?.data?.me?.player?.displayName;
    return typeof name === "string" && name.trim() !== "" ? name : null;
  } catch {
    return null;
  }
}

export const eaClient: StoreClient = {
  key: "ea",
  beginLogin,
  completeLogin,
  listLibrary,
};
