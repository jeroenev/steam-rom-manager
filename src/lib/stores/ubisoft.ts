// Ubisoft Connect: every game the account owns, installed or not, read from
// the caches of the Ubisoft Connect signed in on this PC. Windows only. No
// sign-in window, and nothing is sent to Ubisoft: SRM reads what Ubisoft
// Connect saved when it last signed in (helpers/launchers/ubisoft.ts reads
// the encrypted caches).
//
// - cache\ownership\<user id>.vdat: what the account owns. The plain text is
//   UplayDB's OwnershipCache (proto_ownership_cache/ownership_cache.proto):
//   owned_games = 1, each OwnedGame with product_id = 1, cd_key = 4,
//   platform = 5, product_type = 6, state = 7, target_partner = 17 (1:
//   Epic), activation_type = 18 (2: subscription), ubiServices_app_id = 19.
//   Only the numbers SRM needs are read: never the CD key nor the app id.
// - cache\configuration\configurations.vdat: each product's configuration
//   (YAML), for its title, space_id, third_party_platform and start_game.
//
// Kept, as Playnite's UplayLibrary and SRM's UPlay parser keep them: games
// (product_type 0) the account can play (state 3), that Ubisoft Connect
// starts (start_game) and that aren't another store's copy (platform 3,
// bought on Steam; or a third_party_platform). Ubisoft+ games
// (activation_type 2) are left out: they go when the subscription does.
//
// The "sign-in" saves which account's cache to read (its user id, the file's
// name): the account signed in to Ubisoft Connect last, when SRM signed in.
// Ubisoft Connect has no account name SRM may read (it is in user.vdat, next
// to the sign-in, which SRM never opens). The library's date is the cache's:
// a game bought since shows up once Ubisoft Connect has run again.
//
// OwnedGame.id is the product id: the launcher's id, which uplay:// links,
// the Installs registry key and the UPlay parser use. extra: `space_id`
// (SteamGridDB knows the game by it), `partner: "epic"` for a copy linked to
// the Epic Games Store.

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import {
  ProtoField,
  Unprotect,
  configurationRecords,
  protoFields,
  protoNumber,
  readVdat,
  readVdatFile,
  ubisoftConfigurationsFile,
  ubisoftDataDir,
  ubisoftOwnershipDir,
  unprotectForCurrentUser,
} from "../helpers/launchers/ubisoft";
import { cleanTitle, loginRejected, messageOf } from "./http";
import { sessionData } from "./storage";
import {
  ListContext,
  ListResult,
  OwnedGame,
  PendingLogin,
  StoreClient,
  StoreSession,
  ownedGame,
} from "./types";

// What SRM keeps for the account: which ownership cache is its. Not secret
// (a file name), but kept with the other sign-ins.
interface UbisoftSession {
  userId: string;
}

// Ubisoft user ids are GUIDs; only plain names name a file.
const USER_ID = /^[A-Za-z0-9-]+$/;
// (as SteamGridDB takes it: a GUID)
const SPACE_ID = /^[A-Za-z0-9-]+$/;

// OwnedGame's numbers (see the top).
const PRODUCT_GAME = 0;
const STATE_PLAYABLE = 3;
const PLATFORM_STEAM = 3;
const PARTNER_EPIC = 1;
const ACTIVATION_SUBSCRIPTION = 2;

// Where SRM reads Ubisoft Connect; tests set their own.
export interface UbisoftEnvironment {
  osType: string;
  // %LOCALAPPDATA%\Ubisoft Game Launcher
  dataDir: string | undefined;
  unprotect: Unprotect;
}

const systemEnvironment = (): UbisoftEnvironment => ({
  osType: process.platform === "win32" ? "Windows_NT" : process.platform,
  dataDir: ubisoftDataDir(),
  unprotect: unprotectForCurrentUser,
});

let environment: () => UbisoftEnvironment = systemEnvironment;

// (tests) None puts back this machine's.
export function setUbisoftEnvironment(env?: Partial<UbisoftEnvironment>) {
  environment = env
    ? () => ({ ...systemEnvironment(), ...env })
    : systemEnvironment;
}

// One product the account owns, as far as SRM reads it.
export interface OwnedProduct {
  productId: number;
  platform?: number;
  productType?: number;
  state?: number;
  targetPartner?: number;
  activationType?: number;
}

// The owned products of an ownership cache's plain text. Reads only the
// numbers above: the CD key (4) and the app id (19) stay where they are.
export function parseOwnership(plain: Buffer): OwnedProduct[] {
  const products: OwnedProduct[] = [];
  for (const field of protoFields(plain)) {
    if (field.number !== 1 || !field.bytes) {
      continue;
    }
    const game: ProtoField[] = protoFields(field.bytes);
    const productId = protoNumber(game, 1);
    if (productId === undefined) {
      continue;
    }
    products.push({
      productId,
      platform: protoNumber(game, 5),
      productType: protoNumber(game, 6),
      state: protoNumber(game, 7),
      targetPartner: protoNumber(game, 17),
      activationType: protoNumber(game, 18),
    });
  }
  return products;
}

// What SRM reads from a product's configuration.
export interface ProductConfig {
  title?: string;
  spaceId?: string;
  thirdPartyPlatform: boolean;
  startGame: boolean;
}

// A product's configuration (YAML: `root:` and `localizations:`), or
// undefined when it can't be read.
export function readProductConfig(text: string): ProductConfig | undefined {
  let doc: any;
  try {
    doc = yaml.load(text, { json: true });
  } catch {
    return undefined;
  }
  const root = doc?.root;
  if (!root || typeof root !== "object") {
    return undefined;
  }
  const spaceId =
    typeof root.space_id === "string" ? root.space_id.trim() : undefined;
  return {
    title: productTitle(root, doc.localizations),
    spaceId: spaceId && SPACE_ID.test(spaceId) ? spaceId : undefined,
    thirdPartyPlatform: !!root.third_party_platform,
    startGame: !!root.start_game,
  };
}

// The title: the installer's game_identifier as it is, the title SRM's UPlay
// parser gives the installed game, so that the shortcut keeps its id once
// the game is installed (the name can differ: "Rabbids Coding!" for
// RabbidsCoding, a typographic apostrophe). Without one: `name`, often a key
// into `localizations: default:` (l1, NAME, GAMENAME) rather than the title
// itself, else `display_name`, cleaned.
export function productTitle(
  root: any,
  localizations: any,
): string | undefined {
  const identifier = root.installer?.game_identifier;
  if (
    (typeof identifier === "string" || typeof identifier === "number") &&
    String(identifier).trim() !== ""
  ) {
    return String(identifier);
  }
  const strings = localizations?.default;
  const localized = (key: string) => {
    const value =
      strings && typeof strings === "object" ? strings[key] : undefined;
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : undefined;
  };
  for (const candidate of [root.name, root.display_name]) {
    if (typeof candidate !== "string" && typeof candidate !== "number") {
      continue;
    }
    const text = String(candidate).trim();
    const title = cleanTitle(localized(text) ?? text);
    if (title !== "") {
      return title;
    }
  }
  return undefined;
}

// Why a product isn't listed (for the log's counts), or null when it is.
export function leftOutBecause(
  product: OwnedProduct,
  config: ProductConfig | undefined,
): string | null {
  if ((product.productType ?? PRODUCT_GAME) !== PRODUCT_GAME) {
    return "addOn";
  }
  if (product.state !== STATE_PLAYABLE) {
    return "notPlayable";
  }
  if (
    product.platform === PLATFORM_STEAM ||
    (config && config.thirdPartyPlatform)
  ) {
    return "otherStore";
  }
  if (product.activationType === ACTIVATION_SUBSCRIPTION) {
    return "subscription";
  }
  if (!config) {
    return "noConfiguration";
  }
  if (!config.startGame || !config.title) {
    return "notStartable";
  }
  return null;
}

// The games to list, and how many products were left out for a reason the
// log should mention (configurations that are missing or unreadable).
export function ownedGames(
  products: readonly OwnedProduct[],
  configs: ReadonlyMap<number, string>,
): { games: OwnedGame[]; unreadable: number } {
  const games: OwnedGame[] = [];
  const seen = new Set<number>();
  let unreadable = 0;
  for (const product of products) {
    if (seen.has(product.productId)) {
      continue;
    }
    const text = configs.get(product.productId);
    const config = text === undefined ? undefined : readProductConfig(text);
    const why = leftOutBecause(product, config);
    if (why === "noConfiguration") {
      unreadable++;
    }
    if (why !== null) {
      continue;
    }
    seen.add(product.productId);
    const { title, spaceId } = config!;
    const extra: Record<string, string> = {};
    if (spaceId) {
      extra.space_id = spaceId;
    }
    if (product.targetPartner === PARTNER_EPIC) {
      extra.partner = "epic";
    }
    games.push(ownedGame("ubisoft", String(product.productId), title!, extra));
  }
  return { games, unreadable };
}

// ---- the cache files ----

function dataDirOf(env: UbisoftEnvironment): string {
  if (env.osType !== "Windows_NT") {
    throw new Error(
      "Ubisoft Connect's games can only be read on Windows, where Ubisoft Connect keeps them.",
    );
  }
  if (!env.dataDir || !fs.existsSync(env.dataDir)) {
    throw new Error(
      "Ubisoft Connect isn't installed for this Windows user, or hasn't run yet. Install it, sign in, then try again.",
    );
  }
  return env.dataDir;
}

// The ownership caches here, newest first.
function ownershipCaches(dataDir: string) {
  const dir = ubisoftOwnershipDir(dataDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // (none yet)
  }
  return names
    .filter((name) => name.toLowerCase().endsWith(".vdat"))
    .map((name) => ({
      userId: name.slice(0, -".vdat".length),
      file: path.join(dir, name),
    }))
    .filter((cache) => USER_ID.test(cache.userId))
    .map((cache) => ({ ...cache, mtimeMs: fs.statSync(cache.file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function beginLogin(): PendingLogin {
  return {
    store: "ubisoft",
    startUrl: "",
    // No login window: SRM reads Ubisoft Connect's cache on this PC.
    doneUrlPrefixes: [],
    pageTextUrlPrefixes: [],
    cookieUrls: [],
    manual: { kind: "local" },
    state: {},
  };
}

// Takes the account Ubisoft Connect signed in to last on this PC. Its cache
// is read by the first refresh, right after.
async function completeLogin(): Promise<StoreSession> {
  const dataDir = dataDirOf(environment());
  const newest = ownershipCaches(dataDir)[0];
  if (!newest) {
    throw new Error(
      "Ubisoft Connect hasn't signed in on this PC yet: start it, sign in, then try again.",
    );
  }
  // (a cache SRM can't read fails here rather than in the first refresh)
  readVdat(await fs.promises.readFile(newest.file));
  const session: UbisoftSession = { userId: newest.userId };
  return { accountName: null, data: session };
}

async function listLibrary(
  session: StoreSession,
  ctx: ListContext,
): Promise<ListResult> {
  const { userId } = sessionData<UbisoftSession>(
    "ubisoft",
    session,
    (data) => typeof data.userId === "string" && USER_ID.test(data.userId),
  );
  const env = environment();
  const dataDir = dataDirOf(env);
  const caches = ownershipCaches(dataDir);
  const mine = caches.find(
    (cache) => cache.userId.toLowerCase() === userId.toLowerCase(),
  );
  if (!mine) {
    throw loginRejected(
      'Ubisoft Connect no longer has the cache of the account SRM uses on this PC (it was signed out of, or its data was removed). Start Ubisoft Connect and sign in, then click "Use Ubisoft Connect on this PC" again.',
    );
  }
  if (caches[0] !== mine) {
    ctx.log(
      'Ubisoft Connect has signed in to another account since SRM started using it: SRM still lists the games of the first. To list the other account\'s, click "Use Ubisoft Connect on this PC" again.',
    );
  }
  const keys = new Map<string, Buffer>();
  let products: OwnedProduct[];
  let configs: Map<number, string>;
  try {
    const ownership = await readVdatFile(
      mine.file,
      dataDir,
      env.unprotect,
      keys,
    );
    try {
      products = parseOwnership(ownership);
    } finally {
      // (the plain text holds CD keys)
      ownership.fill(0);
    }
    configs = configurationRecords(
      await readVdatFile(
        ubisoftConfigurationsFile(dataDir),
        dataDir,
        env.unprotect,
        keys,
      ),
    );
  } catch (err) {
    throw new Error(
      `Could not read Ubisoft Connect's cache: ${messageOf(err)}`,
      { cause: err },
    );
  } finally {
    for (const key of keys.values()) {
      key.fill(0);
    }
  }
  const { games, unreadable } = ownedGames(products, configs);
  if (unreadable > 0) {
    ctx.log(
      `${unreadable} Ubisoft Connect games were left out: Ubisoft Connect's cache has no configuration for them that SRM can read.`,
    );
  }
  return { games, fetchedAt: Math.min(mine.mtimeMs, ctx.now()) };
}

export const ubisoftClient: StoreClient = {
  key: "ubisoft",
  beginLogin,
  completeLogin,
  listLibrary,
};
