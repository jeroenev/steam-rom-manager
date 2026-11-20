// itch.io: every game the account holds a download key for (purchases,
// claims, bundles, gifts), installed or not. Ported from BoilR's itch.rs.
//
// Uses itch's server-side API (https://itch.io/docs/api/serverside) with an
// API key the user makes on their account settings page: GET /profile for
// the account and GET /profile/owned-keys?page=N for the keys, each with its
// game. (Playnite's ItchioLibrary reads the same through the itch app's
// butler; this needs no itch app.)
//
// Assumed about the API, not verified against it: pages count from 1, an
// empty owned_keys list means no more pages, and errors come as an `errors`
// (or `error`) field, also with a success status. Nothing depends on the
// size of a page. Seen against it: a key it doesn't take gets 403 with
// {"errors":["invalid key"]}.
//
// Like Playnite's defaults, only items classified game or tool are listed;
// free games only added to a collection have no key and aren't listed. A
// game whose platforms are named and include neither Windows nor Linux
// (Android or macOS only) is skipped; one that names none (a browser game)
// is listed.
//
// OwnedGame.id is the itch game id, in decimal. extra: `url`, the game's
// page on itch.io.

import {
  HttpStatus,
  cleanTitle,
  loginRejected,
  readText,
  snippet,
  withoutQuery,
  wrapErr,
} from "./http";
import { paginate } from "./http";
import { StoreResponse } from "./host";
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

export const API_KEYS_URL = "https://itch.io/user/settings/api-keys";
const PROFILE_URL = "https://api.itch.io/profile";
const OWNED_KEYS_URL = "https://api.itch.io/profile/owned-keys";
// Asked for in the hope of fewer requests; the paging works with any size.
const KEYS_PER_PAGE = "500";
// A stop for a server that never sends an empty page. Reaching it is an
// error.
const MAX_PAGES = 1000;
// Playnite's default ImportGameClassification.
const LISTED_CLASSIFICATIONS = ["game", "tool"];
// The traits that say which platforms a game has downloads for.
const PLATFORM_TRAITS = ["p_windows", "p_linux", "p_osx", "p_android"];
// What Steam runs games on (Linux runs Windows games too, with Proton).
const PLATFORM_TRAITS_HERE = ["p_windows", "p_linux"];

// What SRM keeps for an itch.io account: the key is the login.
interface ItchSession {
  apiKey: string;
}

export interface ItchUser {
  username?: string;
  display_name?: string;
}

export interface OwnedKey {
  // The id of the key itself.
  id?: number;
  game_id?: number;
  game?: ItchGame;
}

export interface ItchGame {
  id?: number;
  title?: string;
  url?: string;
  classification?: string;
  // p_windows, p_linux, p_osx, p_android, can_be_bought, has_demo, ...
  traits?: string[];
}

export function beginLogin(): PendingLogin {
  return {
    store: "itch",
    startUrl: API_KEYS_URL,
    // No login window: itch.io signs in with an API key.
    doneUrlPrefixes: [],
    pageTextUrlPrefixes: [],
    cookieUrls: [],
    manual: {
      kind: "paste",
      url: API_KEYS_URL,
      instructions:
        'Sign in to itch.io in your browser and open your API keys page (Settings > API keys). Click "Generate new API key", then "View" next to the new key, and paste the key here. You can revoke it on the same page at any time.',
      placeholder: "itch.io API key",
    },
    state: {},
  };
}

async function completeLogin(
  _pending: PendingLogin,
  capture: LoginCapture,
  ctx: StoreContext,
): Promise<StoreSession> {
  const apiKey = capture.pasted ? parsePastedKey(capture.pasted) : undefined;
  if (!apiKey) {
    throw new Error(
      `That is not an itch.io API key. Copy the key from ${API_KEYS_URL} and paste it.`,
    );
  }
  const user = await fetchProfile(ctx, apiKey);
  const session: ItchSession = { apiKey };
  return { accountName: accountName(user), data: session };
}

async function listLibrary(session: StoreSession, ctx: ListContext) {
  const { apiKey } = sessionData<ItchSession>(
    "itch",
    session,
    (data) => typeof data.apiKey === "string" && data.apiKey !== "",
  );
  let keys: OwnedKey[];
  try {
    keys = await paginate("itch.io", firstPage(), MAX_PAGES, async (page) => {
      const url = new URL(OWNED_KEYS_URL);
      url.searchParams.set("page", String(page.number));
      url.searchParams.set("per_page", KEYS_PER_PAGE);
      const response = await ctx.http.request(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return readPage(await readAnswer(response), page);
    });
  } catch (err) {
    throw wrapErr(err, "Could not list the itch.io games");
  }
  return { games: ownedGames(keys) };
}

async function fetchProfile(ctx: StoreContext, apiKey: string) {
  const response = await ctx.http.request(PROFILE_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return parseProfile(await readAnswer(response));
}

// The body of an api.itch.io answer. itch.io answers a key it doesn't take
// with 403 and {"errors":["invalid key"]} (seen against the real API, 2026):
// its own words about the key are a refused login, whatever the status.
async function readAnswer(response: StoreResponse) {
  const text = await readText(response);
  checkAnswer(response, text);
  return text;
}

// Throws for an answer that isn't a success: a refused login when itch's
// errors are about the key, else its status (401: sign in again; 429 and
// 5xx: try again later).
export function checkAnswer(
  response: Pick<StoreResponse, "ok" | "status" | "url">,
  text: string,
) {
  if (response.ok) {
    return;
  }
  let errors: ApiErrors | undefined;
  try {
    errors = apiErrors(JSON.parse(text));
  } catch {
    // (not JSON: the status says it)
  }
  if (errors?.aboutTheKey) {
    throw keyRejected(errors);
  }
  throw new HttpStatus(
    response.status,
    withoutQuery(response.url),
    snippet(text),
  );
}

function keyRejected(errors: ApiErrors) {
  return loginRejected(
    `itch.io rejected the API key (${errors.messages.join("; ")}). Create a new key at ${API_KEYS_URL} and sign in again.`,
  );
}

// The pasted key, trimmed. API keys are one token of letters and digits.
export function parsePastedKey(pasted: string): string | undefined {
  const key = pasted.trim();
  return key !== "" && /^[A-Za-z0-9_-]+$/.test(key) ? key : undefined;
}

export function accountName(user: ItchUser): string | null {
  for (const name of [user.username, user.display_name]) {
    if (typeof name === "string" && name.trim() !== "") {
      return name.trim();
    }
  }
  return null;
}

export function parseProfile(text: string): ItchUser {
  const response = parseApi(text, "profile");
  if (!response.user || typeof response.user !== "object") {
    throw unexpected("profile", "missing field `user`", text);
  }
  return response.user;
}

// The keys on a page of profile/owned-keys, or undefined when the answer
// has no list.
export function parseOwnedKeys(text: string): OwnedKey[] | undefined {
  const response = parseApi(text, "owned games");
  try {
    const keys = luaList<any>(response.owned_keys);
    return keys?.map(readKey);
  } catch (err) {
    throw unexpected("owned games", (err as Error).message, text);
  }
}

function readKey(key: any): OwnedKey {
  const game = key?.game;
  return {
    id: numberOr(key?.id),
    game_id: numberOr(key?.game_id),
    game:
      game && typeof game === "object"
        ? {
            id: numberOr(game.id),
            title: typeof game.title === "string" ? game.title : undefined,
            url: typeof game.url === "string" ? game.url : undefined,
            classification:
              typeof game.classification === "string"
                ? game.classification
                : undefined,
            traits: luaList<string>(game.traits),
          }
        : undefined,
  };
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// itch.io's API is written in Lua, where an empty list and an empty object
// are the same table, so an empty list can come as {}. Takes a list, an
// object of items keyed by position ({} included), or null.
export function luaList<T>(value: unknown): T[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "object") {
    const position = (key: string) =>
      /^\d+$/.test(key) ? Number(key) : Number.MAX_SAFE_INTEGER;
    return Object.entries(value)
      .sort(([a], [b]) => position(a) - position(b))
      .map(([, item]) => item as T);
  }
  throw new Error(`expected a list, found ${JSON.stringify(value)}`);
}

// Where the paging of the owned keys is: the page to ask for, and what the
// page before held, to notice a server that answers every page number with
// the same page.
export interface Page {
  number: number;
  before: KeyId[];
}

// What tells one key from another: the key's id and its game's id.
type KeyId = [number | undefined, number | undefined];

export function firstPage(): Page {
  return { number: 1, before: [] };
}

// Reads the answer for `page` and says which page to ask for next, or null
// after the last one.
//
// A list cut short would be saved as the whole library. So only an empty
// list ends the paging (a short page doesn't: no page size is assumed), or a
// later page without a list. An error answer, a first page without a list,
// and a page that repeats the one before are errors.
export function readPage(text: string, page: Page): [OwnedKey[], Page | null] {
  let keys = parseOwnedKeys(text);
  if (!keys) {
    if (page.number === 1) {
      throw new Error(
        `Unexpected owned games response from itch.io: it holds no list of keys. Body starts with: ${snippet(text)}`,
      );
    }
    keys = [];
  }
  if (keys.length === 0) {
    return [keys, null];
  }
  const ids: KeyId[] = keys.map((key) => [key.id, key.game_id]);
  if (JSON.stringify(ids) === JSON.stringify(page.before)) {
    throw new Error(
      `itch.io answered page ${page.number} with the keys of page ${Math.max(page.number - 1, 0)} again, so the list is incomplete and was not saved`,
    );
  }
  return [keys, { number: page.number + 1, before: ids }];
}

function unexpected(what: string, detail: string, text: string) {
  return new Error(
    `Unexpected ${what} response from itch.io: ${detail}. Body starts with: ${snippet(text)}`,
  );
}

// Decodes an api.itch.io answer. Errors come as {"errors": ["invalid key"]},
// maybe with a success status. An answer with an `errors` or `error` field
// is an error whatever the field holds and whatever else the answer holds.
function parseApi(text: string, what: string): any {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw unexpected(what, (err as Error).message, text);
  }
  const errors = apiErrors(value);
  if (errors) {
    if (errors.aboutTheKey) {
      throw keyRejected(errors);
    }
    throw new Error(`itch.io returned an error: ${errors.messages.join("; ")}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unexpected(what, "not an object", text);
  }
  return value;
}

export interface ApiErrors {
  messages: string[];
  // A message, in itch's own words, is about the API key: the login is
  // refused. Anything else (an outage, a rate limit, an error of a shape not
  // seen before) isn't.
  aboutTheKey: boolean;
}

// The errors of an answer, or undefined when it has neither an `errors` nor
// an `error` field (null counts as none).
export function apiErrors(answer: any): ApiErrors | undefined {
  if (!answer || typeof answer !== "object") {
    return undefined;
  }
  const fields = ["errors", "error"]
    .map((field) => answer[field])
    .filter((value) => value !== undefined && value !== null);
  if (!fields.length) {
    return undefined;
  }
  let aboutTheKey = false;
  const messages: string[] = [];
  const items = fields.flatMap((field) =>
    Array.isArray(field) ? field : [field],
  );
  for (const item of items) {
    let message: string;
    if (typeof item === "string") {
      aboutTheKey ||= ["key", "auth", "scope"].some((word) =>
        item.includes(word),
      );
      message = item;
    } else {
      message = snippet(JSON.stringify(item));
    }
    if (message.trim() !== "") {
      messages.push(message);
    }
  }
  if (!messages.length) {
    messages.push("no details given");
  }
  return { messages, aboutTheKey };
}

// One OwnedGame per listed game, in key order, without duplicates.
export function ownedGames(keys: OwnedKey[]): OwnedGame[] {
  const seen = new Set<number>();
  const games: OwnedGame[] = [];
  for (const key of keys) {
    const game = key.game;
    if (!game) {
      continue;
    }
    const id = game.id ?? key.game_id;
    if (id === undefined) {
      continue;
    }
    const title = game.title ? cleanTitle(game.title) : "";
    if (
      title === "" ||
      !isListed(game.classification) ||
      !runsHere(game.traits || []) ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    const extra: Record<string, string> = {};
    if (game.url) {
      extra.url = game.url;
    }
    games.push(ownedGame("itch", String(id), title, extra));
  }
  return games;
}

// A missing classification is taken as a game; unknown ones are skipped.
export function isListed(classification: string | undefined) {
  return (
    classification === undefined ||
    LISTED_CLASSIFICATIONS.includes(classification)
  );
}

// Whether a game with these traits runs where Steam does: it has a Windows
// or a Linux download, or names no platform at all (a browser game, an
// upload without tags), which says nothing against it.
export function runsHere(traits: string[]) {
  const platforms = traits.filter((t) => PLATFORM_TRAITS.includes(t));
  return (
    platforms.length === 0 ||
    platforms.some((t) => PLATFORM_TRAITS_HERE.includes(t))
  );
}

export const itchClient: StoreClient = {
  key: "itch",
  beginLogin,
  completeLogin,
  listLibrary,
};
