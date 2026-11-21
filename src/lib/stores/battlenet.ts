// Battle.net: every game the account has a Blizzard game account for,
// installed or not, and the classic CD-key games. Ported from BoilR's
// battlenet.rs, which follows Playnite's BattleNetLibrary.
//
// Login: the window, in the store's own browser partition, starts the
// account site's OAuth sign-in (account.battle.net/oauth2/authorization/
// account-settings). Once the user is signed in, oauth.battle.net sends the
// browser on to account.battle.net/callback/oauth2/code/account-settings,
// where the window stops. By then Battle.net's long-lived sign-in cookies
// (on .battle.net) are in the partition, which keeps them, and takes
// Battle.net's renewals, as a browser does. Those cookies are the login: SRM
// keeps none of them itself. The account site's own session lasts about 30
// minutes, so the sign-in and every refresh replay that OAuth sign-in
// through the partition (redirects followed, as Playnite does) before they
// call the account API.
//
// Library: account.battle.net/api/games-and-subs lists game accounts by
// Blizzard title id, which the product table (PRODUCTS) maps to launcher
// product codes; a game the table lacks is listed under the name the account
// site gives it. api/classic-games lists the CD-key classics (Warcraft III,
// Diablo II), api/details the BattleTag (the account's name). The API calls
// carry the account site's XSRF-TOKEN cookie as the X-XSRF-TOKEN header, as
// its own page sends them.
//
// Not supported: the China region (battlenet.com.cn), which has its own
// account site.
//
// OwnedGame.id is:
// - for a game in the table, its launcher product code (Pro, WoW, WTCG),
//   the code Battle.net.exe --exec="launch <code>" takes. SRM's Battle.net
//   parser knows installed games by the same code (BNET_GAMES launchId), and
//   a game it knows gets the parser's name for it, so both name it alike;
// - for a classic game, W3C, W3CX, D2 or D2X. These are not launcher codes
//   (the launcher doesn't know the classics): they are the ids Playnite
//   gives them;
// - for a game the table lacks, the code its title id spells (codeOfTitle),
//   which is the launcher code for most games, or title-<title id> when it
//   spells none.
// extra: `internal_id`, the launcher's internal id (prometheus), taken by
// Battle.net.exe --game=<internal_id> (the game's page, with its Install
// button). Absent for classic games, which are installed from Blizzard's
// site with a CD key, and for games the table lacks: their shortcut opens
// the download page.

import { BNET_GAMES } from "../helpers/launchers/battle-net";
import {
  BROWSER_USER_AGENT,
  HttpStatus,
  cleanTitle,
  domainMatches,
  isLoginRejected,
  isTransientStatus,
  loginRejected,
  messageOf,
  readText,
  snippet,
  statusError,
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

// Starts the account site's OAuth sign-in. Also replayed on every refresh.
export const SIGN_IN_URL =
  "https://account.battle.net/oauth2/authorization/account-settings";
// Where oauth.battle.net sends the browser once the user is signed in.
export const DONE_PREFIX = "https://account.battle.net/callback/oauth2/code/";
const ACCOUNT_HOST = "account.battle.net";
// The account site, whose XSRF-TOKEN cookie the API calls carry.
export const ACCOUNT_URL = `https://${ACCOUNT_HOST}/`;
// The hosts a sign-in passes through: the account site SRM calls, the OAuth
// service it redirects to, and the regional login hosts that service sends
// the browser to. The login window hands over their cookies, which show the
// sign-in happened.
export const SESSION_HOSTS: readonly string[] = [
  "battle.net",
  ACCOUNT_HOST,
  "oauth.battle.net",
  "us.account.battle.net",
  "eu.account.battle.net",
  "kr.account.battle.net",
  "tw.account.battle.net",
];
export const API_STATUS_URL = "https://account.battle.net/api/";
export const GAMES_URL = "https://account.battle.net/api/games-and-subs";
export const CLASSIC_GAMES_URL = "https://account.battle.net/api/classic-games";
export const DETAILS_URL = "https://account.battle.net/api/details";
const XSRF_COOKIE = "XSRF-TOKEN";

// A game the Battle.net account API can return. Ported from Playnite's
// BattleNetGames.cs.
export interface Product {
  // The launcher product code (--exec="launch <code>"); for a classic game,
  // Playnite's id.
  code: string;
  // The launcher's internal id (--game=<internal_id>). None for classic
  // games.
  internalId?: string;
  name: string;
  // The Blizzard title id in api/games-and-subs. None for classic games.
  titleId?: number;
}

const launcher = (
  code: string,
  internalId: string,
  name: string,
  titleId: number,
): Product => ({ code, internalId, name, titleId });

const classic = (code: string, name: string): Product => ({ code, name });

// Where a title id repeats, the account entry's name chooses
// (productForTitle).
export const PRODUCTS: readonly Product[] = [
  launcher("WoW", "wow", "World of Warcraft", 5730135),
  launcher("D3", "diablo3", "Diablo III", 17459),
  launcher("S2", "s2", "StarCraft II", 21298),
  launcher("S1", "s1", "StarCraft", 21297),
  launcher("WTCG", "hs_beta", "Hearthstone", 1465140039),
  launcher("Hero", "heroes", "Heroes of the Storm", 1214607983),
  launcher("Pro", "prometheus", "Overwatch 2", 5272175),
  classic("D2", "Diablo II"),
  classic("D2X", "Diablo II: Lord of Destruction"),
  launcher("VIPR", "viper", "Call of Duty: Black Ops 4", 1447645266),
  launcher("ODIN", "odin", "Call of Duty: Modern Warfare", 1329875278),
  classic("W3C", "Warcraft III: Reign of Chaos"),
  classic("W3CX", "Warcraft III: The Frozen Throne"),
  launcher("W3", "w3", "Warcraft III: Reforged", 22323),
  launcher(
    "LAZR",
    "lazarus",
    "Call of Duty: Modern Warfare 2 Campaign Remastered",
    1279351378,
  ),
  launcher("ZEUS", "zeus", "Call of Duty: Black Ops Cold War", 1514493267),
  launcher("WLBY", "wlby", "Crash Bandicoot 4", 1464615513),
  launcher("OSI", "osi", "Diablo II: Resurrected", 5198665),
  launcher("RTRO", "rtro", "Blizzard Arcade Collection", 1381257807),
  launcher("FORE", "fore", "Call of Duty: Vanguard", 1179603525),
  launcher("ANBS", "anbs", "Diablo Immortal", 1095647827),
  // Modern Warfare III (PNTA, below) has the same title id: both live in the
  // Call of Duty launcher entry.
  launcher("AUKS", "auks", "Call of Duty: Modern Warfare II", 1096108883),
  launcher("Fen", "Fen", "Diablo IV", 4613486),
  launcher("D1", "D1", "Diablo", 1146246220),
  launcher("W1R", "w1r", "Warcraft: Remastered", 5714258),
  launcher("W2R", "w2r", "Warcraft II: Remastered", 5714514),
  launcher("W1", "w1", "Warcraft: Orcs & Humans", 1463898673),
  launcher("W2", "w2", "Warcraft II: Battle.net Edition", 1462911566),
  launcher("GRY", "gryphon", "Warcraft Rumble", 4674137),
  launcher("ARIS", "aris", "Doom: The Dark Ages", 1095911763),
  launcher("SCOR", "scorpio", "Sea of Thieves", 1396920146),
  launcher("ARK", "arkansas", "The Outer Worlds 2", 4280907),
  launcher("LBRA", "libra", "Tony Hawk's Pro Skater 3 + 4", 1279414849),
  launcher("PNTA", "pinta", "Call of Duty: Modern Warfare III", 1096108883),
  launcher("AQUA", "aqua", "Avowed", 1095849281),
];

// A CD-key game from before the launcher, which neither installs nor starts
// it.
export function isClassic(p: Product) {
  return p.titleId === undefined;
}

// The product with this code (case-insensitive).
export function product(code: string): Product | undefined {
  const lower = code.toLowerCase();
  return PRODUCTS.find((p) => p.code.toLowerCase() === lower);
}

// What SRM's Battle.net parser calls the game with this launcher code, if
// it knows it (BNET_GAMES).
export function srmName(code: string): string | undefined {
  const lower = code.toLowerCase();
  return Object.values(BNET_GAMES).find(
    (game) => game.launchId.toLowerCase() === lower,
  )?.name;
}

// The code a title id spells: read as bytes, most significant first, a
// title id is ASCII text (5272175 is "Pro", 1096108883 is "AUKS"). For most
// games that text is the launcher product code. Undefined when the bytes
// aren't letters and digits.
export function codeOfTitle(titleId: number): string | undefined {
  if (!Number.isSafeInteger(titleId) || titleId <= 0) {
    return undefined;
  }
  const bytes: number[] = [];
  for (let rest = titleId; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  const alphanumeric = (byte: number) =>
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a);
  return bytes.every(alphanumeric) ? String.fromCharCode(...bytes) : undefined;
}

// A name's words, lower case, without trademark signs and punctuation.
function words(name: string): string[] {
  return cleanTitle(name)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

// The product of a game account. Modern Warfare II and III share a title id,
// which alone can't tell them apart: of the products with this title id, the
// one whose every word is in the name the account site gives the entry is
// taken, and the first one in the table when the name doesn't help (as
// Playnite always does).
export function productForTitle(
  titleId: number,
  localizedName?: string,
): Product | undefined {
  const sharing = PRODUCTS.filter((p) => p.titleId === titleId);
  if (sharing.length === 0) {
    // The table may know the game by the code this title id spells.
    const code = codeOfTitle(titleId);
    const known = code === undefined ? undefined : product(code);
    return known && !isClassic(known) ? known : undefined;
  }
  const named = localizedName === undefined ? [] : words(localizedName);
  return (
    sharing.find((p) => {
      const name = words(p.name);
      return name.length > 0 && name.every((word) => named.includes(word));
    }) ?? sharing[0]
  );
}

// What SRM keeps for a Battle.net account: nothing secret. The login is the
// cookies of the store's browser partition.
export interface BattleNetSession {
  // When the user signed in, in milliseconds since 1970.
  signedInAt: number;
}

export function beginLogin(): PendingLogin {
  return {
    store: "battlenet",
    startUrl: SIGN_IN_URL,
    doneUrlPrefixes: [DONE_PREFIX],
    pageTextUrlPrefixes: [],
    cookieUrls: SESSION_HOSTS.map((host) => `https://${host}/`),
    // The sign-in lives in HttpOnly cookies, which a user can't reasonably
    // copy.
    manual: { kind: "unsupported" },
    // The sign-in is replayed under the user agent of the store's requests
    // (StoreHttp's): the window signs in under the same.
    userAgent: BROWSER_USER_AGENT,
    state: {},
  };
}

// The cookies of a sign-in that matter: the ones a browser sends to a host
// the sign-in passes through. Blizzard's other hosts (its shop, its forums)
// aren't called.
export function sessionCookies(
  captured: readonly StoreCookie[],
): StoreCookie[] {
  return captured.filter(
    (cookie) =>
      cookie.name !== "" &&
      cookie.domain.replace(/^\.+/, "") !== "" &&
      SESSION_HOSTS.some((host) => domainMatches(cookie.domain, host)),
  );
}

async function completeLogin(
  _pending: PendingLogin,
  capture: LoginCapture,
  ctx: StoreContext,
): Promise<StoreSession> {
  if (capture.cookies === undefined && capture.pasted !== undefined) {
    throw new Error(
      "Battle.net can only be signed in to with SRM's sign-in window.",
    );
  }
  // (only checked: the partition sends them)
  if (sessionCookies(capture.cookies ?? []).length === 0) {
    throw new Error(
      "The Battle.net sign-in window handed over no battle.net cookies, so the sign-in did not finish. Try signing in again.",
    );
  }
  try {
    await signInAccountSite(ctx);
  } catch (err) {
    if (isLoginRejected(err)) {
      throw loginRejected(
        "Battle.net's account site sees no signed-in user after the sign-in window, so the sign-in did not finish. Try signing in again.",
        err,
      );
    }
    throw wrapErr(err, "Signing in to Battle.net did not finish");
  }
  const session: BattleNetSession = { signedInAt: ctx.now() };
  return { accountName: await battleTag(ctx), data: session };
}

function readSession(session: StoreSession) {
  return sessionData<BattleNetSession>(
    "battlenet",
    session,
    (data) => typeof data.signedInAt === "number",
  );
}

async function listLibrary(
  session: StoreSession,
  ctx: ListContext,
): Promise<ListResult> {
  readSession(session);
  await signInAccountSite(ctx);
  const tag = await battleTag(ctx);
  if (tag !== null) {
    session.accountName = tag;
  }
  let accounts: GameAccount[];
  try {
    accounts = parseGamesAndSubs(await apiGet(ctx, GAMES_URL));
  } catch (err) {
    throw wrapErr(err, "Could not list the Battle.net games");
  }
  // The classic CD-key games are a small extra: when only their list fails,
  // the ones from the last list are kept instead of failing the library.
  let classicGames: ClassicGame[] | undefined;
  try {
    classicGames = parseClassicGames(await apiGet(ctx, CLASSIC_GAMES_URL));
  } catch (err) {
    if (isLoginRejected(err)) {
      throw wrapErr(err, "Could not list the Battle.net classic games");
    }
    ctx.log(
      `Could not list the Battle.net classic games, keeping the ones from before: ${messageOf(err)}`,
    );
  }
  const owned = ownedGames(accounts, classicGames ?? [], ctx.log);
  return classicGames
    ? { games: owned }
    : { games: withPreviousClassicGames(owned, ctx.previous), partial: true };
}

// The classic games of the last list, added to a list made without the
// classic games, as this version lists them.
export function withPreviousClassicGames(
  owned: readonly OwnedGame[],
  previous: readonly OwnedGame[],
): OwnedGame[] {
  const games = [...owned];
  for (const game of previous) {
    const classicProduct = product(game.id);
    if (!classicProduct || !isClassic(classicProduct)) {
      continue;
    }
    if (!games.some((g) => g.id === classicProduct.code)) {
      games.push(toOwnedGame(classicProduct));
    }
  }
  return games;
}

// Replays the account site's OAuth sign-in through the partition, which
// gives the account site a fresh session, then checks that the account API
// sees a signed-in user.
async function signInAccountSite(ctx: StoreContext) {
  // Ends on the account site when the sign-in is still good, on the login
  // page when not; both answer 200, so the status check below decides.
  const replay = await ctx.http.request(SIGN_IN_URL);
  const replayFailed = replay.ok ? undefined : await statusError(replay);
  const response = await ctx.http.request(API_STATUS_URL, {
    headers: { Accept: "application/json" },
  });
  const body = await readText(response);
  afterReplay(replayFailed, () => checkSignedIn(response.status, body));
}

// The account's BattleTag, if the account site hands it out. Never fails a
// sign-in or a refresh.
async function battleTag(ctx: StoreContext): Promise<string | null> {
  try {
    return parseBattleTag(await apiGet(ctx, DETAILS_URL));
  } catch {
    return null;
  }
}

// A GET on the account API, with the headers its own web page sends.
async function apiGet(ctx: StoreContext, url: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const xsrf = await xsrfToken(ctx);
  if (xsrf !== undefined) {
    headers["X-XSRF-TOKEN"] = xsrf;
  }
  return ctx.http.sendJson(url, { headers });
}

// The account site's XSRF-TOKEN cookie, from the partition (StoreContext's
// cookies); undefined when the host can't read the partition's cookies or
// it has none. Without it the account API is called without the
// X-XSRF-TOKEN header, as BoilR does when it has no XSRF-TOKEN cookie.
export async function xsrfToken(
  ctx: StoreContext,
): Promise<string | undefined> {
  if (!ctx.cookies) {
    return undefined;
  }
  try {
    return xsrfFrom(await ctx.cookies(ACCOUNT_URL));
  } catch {
    return undefined; // (the header is a courtesy)
  }
}

// The XSRF-TOKEN cookie among the cookies the partition sends to the
// account site.
export function xsrfFrom(
  cookies: readonly StoreCookie[] | undefined,
): string | undefined {
  return (cookies ?? []).find(
    (c) =>
      c.name === XSRF_COOKIE &&
      typeof c.value === "string" &&
      c.value !== "" &&
      (c.domain === "" || domainMatches(c.domain, ACCOUNT_HOST)),
  )?.value;
}

// ---- Reading answers ----

// Whether the account API's status answer says there is a signed-in user.
// Undefined when it doesn't say: no JSON, or JSON about something else (an
// error object).
export function parseApiStatus(body: string): boolean | undefined {
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    return undefined;
  }
  return isObject(answer) && typeof answer.authenticated === "boolean"
    ? answer.authenticated
    : undefined;
}

// What the account API's status answer means for the sign-in. Without one
// the API answers 401 and `authenticated: false`. An outage, a rate limit
// or a bot block says nothing about the sign-in, so none of them asks the
// user to sign in again.
export function checkSignedIn(status: number, body: string) {
  const success = status >= 200 && status < 300;
  const authenticated = parseApiStatus(body);
  if (authenticated === true) {
    return;
  }
  if ((authenticated === false && success) || status === 401) {
    throw signInRefused();
  }
  if (isTransientStatus(status)) {
    throw new HttpStatus(status, API_STATUS_URL, snippet(body));
  }
  throw new Error(
    `Unexpected answer from the Battle.net account site (HTTP ${status}): ${snippet(body)}`,
  );
}

export function signInRefused() {
  return loginRejected(
    "Battle.net no longer accepts the saved sign-in. Sign in again.",
  );
}

// The outcome of a sign-in check, given how the replay before it went. When
// the replay itself failed (an outage, a bot block), the account site has no
// session whatever the sign-in is worth: a refusal then says nothing, and the
// replay's failure is reported.
export function afterReplay(
  replayFailed: Error | undefined,
  check: () => void,
) {
  try {
    check();
  } catch (err) {
    if (replayFailed && isLoginRejected(err)) {
      throw wrapErr(
        replayFailed,
        "The Battle.net sign-in could not be renewed",
      );
    }
    throw err;
  }
}

// The account's BattleTag (Player#1234) from api/details.
export function parseBattleTag(answer: unknown): string | null {
  const tag = isObject(answer) ? answer.battleTag : undefined;
  return typeof tag === "string" && tag.trim() !== "" ? tag : null;
}

// A game account in api/games-and-subs.
export interface GameAccount {
  titleId?: number;
  // The game's name in the account site's language, with trademark signs.
  localizedGameName?: string;
}

// The game accounts of api/games-and-subs. The list must be there (null
// counts as empty): an answer without it is something else than the game
// list, and must not be read as an account without games.
export function parseGamesAndSubs(answer: unknown): GameAccount[] {
  const unexpected = (detail: string) =>
    new Error(
      `Unexpected answer from the Battle.net account site instead of the game list: ${detail}. Body starts with: ${snippet(JSON.stringify(answer) ?? "")}`,
    );
  if (!isObject(answer)) {
    throw unexpected("not an object");
  }
  const accounts = answer.gameAccounts;
  if (accounts === undefined) {
    throw unexpected("missing field `gameAccounts`");
  }
  if (accounts === null) {
    return [];
  }
  if (!Array.isArray(accounts)) {
    throw unexpected("`gameAccounts` is not a list");
  }
  return accounts.map((account: unknown) => {
    const entry = isObject(account) ? account : {};
    return {
      titleId: titleIdOf(entry.titleId),
      localizedGameName:
        typeof entry.localizedGameName === "string"
          ? entry.localizedGameName
          : undefined,
    };
  });
}

// A title id: a whole number (or its digits); anything else counts as none.
function titleIdOf(value: unknown): number | undefined {
  const id =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0
    ? id
    : undefined;
}

// A CD key in api/classic-games (only its icon is read: the keys are
// secret).
export interface ClassicGame {
  regionalGameFranchiseIconFilename?: string;
}

// The CD keys of api/classic-games; none when the list is null or missing.
// (An unexpected answer is reported without its body, which holds the CD
// keys.)
export function parseClassicGames(answer: unknown): ClassicGame[] {
  const unexpected = (detail: string) =>
    new Error(
      `Unexpected answer from the Battle.net account site instead of the classic games: ${detail}`,
    );
  if (!isObject(answer)) {
    throw unexpected("not an object");
  }
  const games = answer.classicGames;
  if (games === undefined || games === null) {
    return [];
  }
  if (!Array.isArray(games)) {
    throw unexpected("`classicGames` is not a list");
  }
  return games.map((game: unknown) => {
    const icon = isObject(game)
      ? game.regionalGameFranchiseIconFilename
      : undefined;
    return {
      regionalGameFranchiseIconFilename:
        typeof icon === "string" ? icon : undefined,
    };
  });
}

// The owned games of the game accounts and the CD keys, one per game, in the
// account site's order, classic games last.
export function ownedGames(
  accounts: readonly GameAccount[],
  classicGames: readonly ClassicGame[] = [],
  log: (message: string) => void = () => undefined,
): OwnedGame[] {
  if (
    accounts.length > 0 &&
    accounts.every((account) => account.titleId === undefined)
  ) {
    throw new Error(
      `Unexpected answer from the Battle.net account site: none of its ${accounts.length} game accounts has a title id`,
    );
  }

  const owned: OwnedGame[] = [];
  for (const account of accounts) {
    const titleId = account.titleId;
    if (titleId === undefined) {
      continue;
    }
    const name = account.localizedGameName;
    const known = productForTitle(titleId, name);
    const game = known ? toOwnedGame(known) : unknownGame(titleId, name);
    if (!game) {
      log(
        `Battle.net lists a game SRM does not know and gives it no name (title id ${titleId}); it is skipped.`,
      );
      continue;
    }
    // Several game accounts (two WoW licences, say) are one game.
    if (owned.some((o) => o.id === game.id)) {
      continue;
    }
    if (!known) {
      log(
        `Battle.net lists a game SRM does not know (title id ${titleId}); it is added as "${game.title}" and opens the download page.`,
      );
    }
    owned.push(game);
  }

  // As Playnite: classic games only show up as CD keys, told apart by their
  // icon. One Warcraft III key is Reign of Chaos, a second one The Frozen
  // Throne; likewise Diablo II and Lord of Destruction.
  const icons = classicGames
    .map((game) => game.regionalGameFranchiseIconFilename)
    .filter((icon): icon is string => icon !== undefined);
  const count = (franchise: string) =>
    icons.filter((icon) => isFranchise(icon, franchise)).length;
  for (const [franchise, base, expansion] of [
    ["warcraft-iii", "W3C", "W3CX"],
    ["diablo-ii", "D2", "D2X"],
  ]) {
    for (const code of [base, expansion].slice(0, count(franchise))) {
      const classicProduct = product(code);
      if (classicProduct && !owned.some((o) => o.id === classicProduct.code)) {
        owned.push(toOwnedGame(classicProduct));
      }
    }
  }
  return owned;
}

// Whether an icon file name belongs to a franchise, without diablo-ii
// matching diablo-iii.
export function isFranchise(icon: string, franchise: string): boolean {
  const lower = icon.toLowerCase();
  for (
    let start = lower.indexOf(franchise);
    start >= 0;
    start = lower.indexOf(franchise, start + franchise.length)
  ) {
    if (lower[start + franchise.length] !== "i") {
      return true;
    }
  }
  return false;
}

// A product as an owned game, under SRM's name for it where SRM's
// Battle.net parser knows it.
export function toOwnedGame(p: Product): OwnedGame {
  return ownedGame(
    "battlenet",
    p.code,
    srmName(p.code) ?? p.name,
    p.internalId ? { internal_id: p.internalId } : {},
  );
}

// A game the product table lacks (one Blizzard added since), from its
// account entry. It has no internal_id, so its shortcut opens the download
// page. Undefined when the entry has no name to list it under.
export function unknownGame(
  titleId: number,
  localizedName?: string,
): OwnedGame | undefined {
  const title = localizedName === undefined ? "" : cleanTitle(localizedName);
  if (title === "") {
    return undefined;
  }
  const spelled = codeOfTitle(titleId);
  // A code the table has for another game (a classic one) isn't this game's.
  const id =
    spelled !== undefined && product(spelled) === undefined
      ? spelled
      : `title-${titleId}`;
  return ownedGame("battlenet", id, srmName(id) ?? title);
}

function isObject(value: unknown): value is { [key: string]: any } {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export const battlenetClient: StoreClient = {
  key: "battlenet",
  beginLogin,
  completeLogin,
  listLibrary,
};
