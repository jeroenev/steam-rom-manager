// GOG: sign in with the OAuth flow of the GOG Galaxy client and list the
// owned games. Ported from BoilR's gog.rs.
//
// Login: the window opens auth.gog.com/auth for the Galaxy client; after
// sign-in GOG redirects to embed.gog.com/on_login_success?origin=client&code=…
// The code is traded at auth.gog.com/token for an access token (about an
// hour), a refresh token and the user id. The same client, secret and
// redirect as Heroic's gogdl and Minigalaxy.
//
// Library: embed.gog.com/account/getFilteredProducts?mediaType=1&page=N with
// the Bearer token (what Minigalaxy uses). mediaType=1 leaves out movies;
// DLC isn't listed on its own, except DLC whose base game the account
// doesn't own (isBaseProductMissing), which is skipped.
//
// OwnedGame.id is the GOG product id, as SRM's GOG Galaxy parser reads it.
// extra: `slug`, the store slug (www.gog.com/game/<slug>), when GOG sends
// one.

import {
  cleanTitle,
  domainMatches,
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

// The GOG Galaxy client's OAuth client. Public: shipped in Galaxy and used
// by Heroic's gogdl and Minigalaxy.
const CLIENT_ID = "46899977096215655";
const CLIENT_SECRET =
  "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9";
const REDIRECT_URI = "https://embed.gog.com/on_login_success?origin=client";
// Where GOG sends the browser after sign-in. The login pages themselves are
// on auth.gog.com and login.gog.com, so they never match.
export const DONE_PREFIX = "https://embed.gog.com/on_login_success";
const AUTH_URL = "https://auth.gog.com/auth";
export const TOKEN_URL = "https://auth.gog.com/token";
export const PRODUCTS_URL = "https://embed.gog.com/account/getFilteredProducts";

// Renew the access token when it expires within this long.
const REFRESH_MARGIN_MS = 120 * 1000;
// More pages than this is a server that keeps reporting more pages: an
// error, not the end of the list.
const MAX_PAGES = 500;
// (GOG's page numbers are 32-bit)
const U32_MAX = 4294967295;

// Products GOG files as games that are only goodies (comics, artbooks,
// wallpapers). From Minigalaxy's IGNORE_GAME_IDS.
const NOT_GAMES = [
  "1424856371", // Hotline Miami 2: Wrong Number - Digital Comics
  "1980301910", // The Witcher Goodies Collection
  "2005648906", // Spring Sale Goodies Collection #1
  "1486144755", // Cyberpunk 2077 Goodies Collection
  "1581684020", // A Plague Tale Digital Goodies Pack
  "1185685769", // CDPR Goodie Pack Content
];

// What SRM keeps for a GOG account.
export interface GogSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  // When accessToken stops working, in milliseconds since 1970.
  expiresAt: number;
}

// The answer of auth.gog.com/token (for the code and the refresh grant).
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  user_id: string;
  expires_in: number;
}

// A page of account/getFilteredProducts.
export interface ProductsPage {
  // 0 when GOG doesn't say.
  totalPages: number;
  products: Product[];
}

export interface Product {
  id: string;
  title: string;
  slug?: string;
  isGame?: boolean;
  isMovie?: boolean;
  isBaseProductMissing?: boolean;
}

export function beginLogin(): PendingLogin {
  const startUrl = loginUrl();
  return {
    store: "gog",
    startUrl,
    doneUrlPrefixes: [DONE_PREFIX],
    pageTextUrlPrefixes: [],
    cookieUrls: [],
    manual: {
      kind: "paste",
      url: startUrl,
      instructions:
        "Sign in to GOG in your browser. When the page turns blank and its address starts with embed.gog.com/on_login_success, copy the whole address from the address bar and paste it here.",
      placeholder:
        "https://embed.gog.com/on_login_success?origin=client&code=...",
    },
    state: {},
  };
}

export function loginUrl() {
  const query = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    layout: "galaxy",
  });
  return `${AUTH_URL}?${query}`;
}

function tokenUrl(params: Record<string, string>) {
  const query = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    ...params,
  });
  return `${TOKEN_URL}?${query}`;
}

async function requestToken(
  ctx: StoreContext,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const response = await ctx.http.send(tokenUrl(params));
  return parseTokenText(response.url, await readText(response));
}

async function completeLogin(
  _pending: PendingLogin,
  capture: LoginCapture,
  ctx: StoreContext,
): Promise<StoreSession> {
  const code = codeFromCapture(capture);
  let token: TokenResponse;
  try {
    token = await requestToken(ctx, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    });
  } catch (err) {
    throw wrapErr(err, "Could not finish the GOG sign-in");
  }
  const gog = sessionFromToken(token, ctx.now());
  // The name is only for display: no reason to fail the login.
  let accountName: string | null = null;
  try {
    accountName = await fetchUsername(ctx, gog);
  } catch {
    // (fetched again on the next refresh)
  }
  return { accountName, data: gog };
}

function readSession(session: StoreSession) {
  return sessionData<GogSession>(
    "gog",
    session,
    (data) =>
      typeof data.accessToken === "string" &&
      typeof data.refreshToken === "string" &&
      typeof data.userId === "string" &&
      typeof data.expiresAt === "number",
  );
}

async function listLibrary(session: StoreSession, ctx: ListContext) {
  let gog = readSession(session);
  let renewed = false;
  if (needsRefresh(gog, ctx.now())) {
    gog = await renew(session, ctx);
    renewed = true;
  }
  if (session.accountName === null) {
    try {
      session.accountName = await fetchUsername(ctx, gog);
    } catch {
      // (only for display)
    }
  }
  const products = () =>
    fetchProducts(ctx, gog).catch((err) => {
      throw wrapErr(err, "Could not load the GOG library");
    });
  try {
    return { games: await products() };
  } catch (err) {
    // GOG can end a token before it expires: renew it once and try again.
    if (renewed || !isLoginRejected(err)) {
      throw err;
    }
    gog = await renew(session, ctx);
    return { games: await products() };
  }
}

// Renews the tokens and saves them right away: GOG ends the old refresh
// token when it's used, so the new one must not be lost when SRM closes
// while the games are listed.
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
  const gog = readSession(session);
  let token: TokenResponse;
  try {
    token = await requestToken(ctx, {
      grant_type: "refresh_token",
      refresh_token: gog.refreshToken,
    });
  } catch (err) {
    throw refreshFailure(err);
  }
  return { ...session, data: sessionFromToken(token, ctx.now()) };
}

async function fetchProducts(ctx: StoreContext, gog: GogSession) {
  return paginate("GOG", 1, MAX_PAGES, async (page: number) => {
    const url = new URL(PRODUCTS_URL);
    url.searchParams.set("mediaType", "1");
    url.searchParams.set("page", String(page));
    const response = await ctx.http.send(url.toString(), {
      headers: { Authorization: `Bearer ${gog.accessToken}` },
    });
    // (where the request ended up after redirects)
    const products = parseProductsPage(response.url, await readText(response));
    return [gamesFromPage(products), nextPage(products, page)];
  });
}

// Whether a failed token renewal means GOG refused the refresh token: it
// answers one it no longer takes with 400 (invalid_grant) or 401. Anything
// else (no connection, a timeout, a rate limit, 5xx) says nothing about the
// login.
export function refreshWasRefused(status: number | undefined) {
  return status === 400 || status === 401;
}

// A failed renewal as the error to report: a refused login only when GOG
// refused the refresh token.
export function refreshFailure(err: unknown): Error {
  if (refreshWasRefused(statusOf(err))) {
    return loginRejected(
      `GOG no longer accepts the saved login. Sign in again. (${(err as Error).message})`,
    );
  }
  return wrapErr(err, "Could not renew the GOG login");
}

async function fetchUsername(ctx: StoreContext, gog: GogSession) {
  const user = await ctx.http.sendJson(
    `https://users.gog.com/users/${encodeURIComponent(gog.userId)}`,
    { headers: { Authorization: `Bearer ${gog.accessToken}` } },
  );
  return parseUsername(user);
}

export function parseUsername(user: any): string | null {
  const name = user?.username;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

// The token answer as text. GOG's user ids are past 2^53, where a number
// loses digits: a numeric user_id keeps the exact digits it was sent with.
export function parseTokenText(url: string, text: string): TokenResponse {
  let answer: any;
  try {
    answer = JSON.parse(text, ((
      key: string,
      value: unknown,
      context?: { source?: string },
    ) =>
      key === "user_id" && typeof value === "number" && context?.source
        ? context.source
        : value) as (key: string, value: any) => any);
  } catch (err) {
    throw new Error(
      `Unexpected response from ${withoutQuery(url)}: ${messageOf(err)}. Body starts with: ${snippet(text)}`,
    );
  }
  return parseToken(answer);
}

// The token answer, checked: an answer without tokens isn't a sign-in.
export function parseToken(answer: any): TokenResponse {
  const userId = idText(answer?.user_id);
  if (
    typeof answer?.access_token !== "string" ||
    typeof answer?.refresh_token !== "string" ||
    userId === undefined ||
    typeof answer?.expires_in !== "number"
  ) {
    throw new Error(
      `Unexpected response from ${TOKEN_URL}: no tokens in it. Body starts with: ${snippet(JSON.stringify(answer))}`,
    );
  }
  return {
    access_token: answer.access_token,
    refresh_token: answer.refresh_token,
    user_id: userId,
    expires_in: answer.expires_in,
  };
}

export function sessionFromToken(
  token: TokenResponse,
  now: number,
): GogSession {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    userId: token.user_id,
    expiresAt: now + token.expires_in * 1000,
  };
}

export function needsRefresh(gog: GogSession, now: number) {
  return now + REFRESH_MARGIN_MS >= gog.expiresAt;
}

// The code from the window's redirect or from what the user pasted: the
// whole redirect URL, its query, or the bare code.
export function codeFromCapture(capture: LoginCapture): string {
  const input = (capture.finalUrl ?? capture.pasted ?? "").trim();
  if (input === "") {
    throw new Error(
      "Nothing to finish the GOG sign-in with. Paste the address of the page GOG shows after you sign in.",
    );
  }
  const questionMark = input.indexOf("?");
  const query =
    questionMark >= 0
      ? input.slice(questionMark + 1)
      : input.includes("=")
        ? input
        : undefined;
  if (query === undefined) {
    if (/[\s/:]/.test(input)) {
      throw new Error(
        `That does not look like the GOG sign-in address. Paste the whole address that starts with ${DONE_PREFIX}.`,
      );
    }
    return input;
  }
  const params = new URLSearchParams(query.split("#")[0]);
  const param = (name: string) => params.get(name) || undefined;
  const code = param("code");
  if (code) {
    return code;
  }
  const error = param("error");
  if (error) {
    throw new Error(
      `GOG did not complete the sign-in: ${param("error_description") ?? error}`,
    );
  }
  throw new Error(
    `The GOG sign-in address has no code in it. Paste the whole address that starts with ${DONE_PREFIX}.`,
  );
}

// Reads a page of the library. `finalUrl` is where the request ended up
// after redirects.
//
// Without a valid token GOG sends its sign-in page instead of the library;
// only that is a refused login. Any other answer that isn't a page of the
// library (a captive portal, a maintenance page, JSON without products) is
// an error that says nothing about the login.
export function parseProductsPage(
  finalUrl: string,
  body: string,
): ProductsPage {
  if (body.trimStart().startsWith("<")) {
    if (isSignInPage(finalUrl, body)) {
      throw loginRejected(
        "GOG did not accept the saved login (it sent its sign-in page instead of the library). Sign in again.",
      );
    }
    throw new Error(
      `Unexpected answer from GOG: a web page from ${withoutQuery(finalUrl)} instead of the library. Body starts with: ${snippet(body)}`,
    );
  }
  const unexpected = (detail: string) =>
    new Error(
      `Unexpected answer from GOG instead of the library: ${detail}. Body starts with: ${snippet(body)}`,
    );
  let page: any;
  try {
    page = JSON.parse(body);
  } catch (err) {
    throw unexpected((err as Error).message);
  }
  // (products is required: an answer without it isn't a page of the
  // library, and must not be read as an empty one)
  if (!page || typeof page !== "object" || !Array.isArray(page.products)) {
    throw unexpected("missing field `products`");
  }
  const products: Product[] = page.products.map((p: any) => {
    const id = idText(p?.id);
    if (id === undefined) {
      throw unexpected("a product without an id");
    }
    return {
      id,
      title: typeof p.title === "string" ? p.title : "",
      slug: typeof p.slug === "string" ? p.slug : undefined,
      isGame: typeof p.isGame === "boolean" ? p.isGame : undefined,
      isMovie: typeof p.isMovie === "boolean" ? p.isMovie : undefined,
      isBaseProductMissing:
        typeof p.isBaseProductMissing === "boolean"
          ? p.isBaseProductMissing
          : undefined,
    };
  });
  return {
    totalPages: typeof page.totalPages === "number" ? page.totalPages : 0,
    products,
  };
}

// Whether a web page that came instead of the library is GOG's sign-in
// page: GOG served it (HTTPS on a gog.com host: a captive portal or a
// proxy's error page isn't) and it's a login page (GOG's login host, a login
// path, the store with #openlogin, or a page that only refreshes there).
export function isSignInPage(finalUrl: string, body: string): boolean {
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !domainMatches("gog.com", host)) {
    return false;
  }
  const opensLogin = (text: string) => text.toLowerCase().includes("openlogin");
  const lowerBody = body.toLowerCase();
  return (
    host === "login.gog.com" ||
    host === "auth.gog.com" ||
    url.pathname
      .split("/")
      .some((segment) =>
        ["login", "signin", "sign-in", "sign_in"].includes(
          segment.toLowerCase(),
        ),
      ) ||
    opensLogin(url.hash) ||
    (lowerBody.includes("http-equiv") &&
      lowerBody.includes("refresh") &&
      opensLogin(lowerBody))
  );
}

export function gamesFromPage(page: ProductsPage): OwnedGame[] {
  return page.products.filter(isOwnedGame).map((p) => {
    const slug = p.slug?.trim();
    return ownedGame("gog", p.id, cleanTitle(p.title), slug ? { slug } : {});
  });
}

export function isOwnedGame(product: Product) {
  return (
    product.id !== "" &&
    cleanTitle(product.title) !== "" &&
    product.isMovie !== true &&
    product.isGame !== false &&
    product.isBaseProductMissing !== true &&
    !NOT_GAMES.includes(product.id)
  );
}

// The page to ask for after page `current`, or null after the last one. An
// empty page always ends the list. While GOG doesn't say how many pages
// there are (totalPages missing or 0) but the page has products, the next
// is asked for until an empty one comes: stopping there could save a list
// cut short.
export function nextPage(page: ProductsPage, current: number): number | null {
  if (page.products.length === 0) {
    return null;
  }
  return page.totalPages === 0 || current < page.totalPages
    ? Math.min(current + 1, U32_MAX)
    : null;
}

// GOG sends ids as numbers in some answers and as text in others. A number
// past 2^53 has already lost digits, so it's no id (parseTokenText keeps a
// user id's).
function idText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

export const gogClient: StoreClient = {
  key: "gog",
  beginLogin,
  completeLogin,
  refreshSession,
  listLibrary,
};
