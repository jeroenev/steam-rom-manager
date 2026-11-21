// Which owned games go into Steam: not betas and demos, not what Steam or
// another launcher has installed, one entry for a game several stores own.
// Ported from BoilR's accounts/arrange.rs, platform.rs and core owned.rs.

import * as fs from "fs";
import * as path from "path";
import * as genericParser from "@node-steam/vdf";
import * as json from "../helpers/json";
import { DEFAULT_STORE_ORDER, MultiStore, StoreKey } from "./types";

// Whether a title names a beta, a demo, a playtest or a test server rather
// than the game: "Barony (Beta)", "Shadwen demo", "Mortal Shell Tech Beta",
// "KillingFloor2Beta". Whole words only, so "Demon's Tilt" or "Alpha
// Protocol" stay.
export function isPrerelease(title: string): boolean {
  const WORDS = ["beta", "demo", "playtest", "pts"];
  const PHRASES = ["test server", "tech test", "public test"];
  const words = title
    .toLowerCase()
    .split(/[^\p{Alphabetic}\p{N}]/u)
    .filter((word) => word !== "");
  if (words.some((word) => WORDS.includes(word))) {
    return true;
  }
  const spaced = words.join(" ");
  if (PHRASES.some((phrase) => spaced.includes(phrase))) {
    return true;
  }
  // A store id used as a title, its words run together.
  return title
    .split(/\s+/)
    .some(
      (word) =>
        word.length > 6 && (word.endsWith("Beta") || word.endsWith("Demo")),
    );
}

// A title reduced to what tells games apart: letters and digits, lower
// case, no trademark signs. "PREY" and "Prey", "Brothers - A Tale of Two
// Sons" and "Brothers: A Tale of Two Sons" come out the same.
export function normalizeTitle(title: string): string {
  return Array.from(title)
    .filter((c) => /[\p{Alphabetic}\p{N}]/u.test(c))
    .map((c) => c.toLowerCase())
    .join("");
}

// The games Steam has installed itself, from the app manifests of every
// library folder of the Steam install at `steamDir`. Nothing when Steam's
// files can't be read.
export function steamInstalledGames(
  steamDir: string,
): { appId: string; name: string }[] {
  const steamapps = path.join(steamDir, "steamapps");
  const folders = [steamapps];
  try {
    const libraries = json.caselessGet(
      genericParser.parse(
        fs.readFileSync(path.join(steamapps, "libraryfolders.vdf"), "utf8"),
      ),
      [["libraryfolders"]],
    );
    for (const [key, library] of Object.entries<any>(libraries || {})) {
      // (now { path, apps }; old files had "1" "D:\\SteamLibrary")
      const folder =
        typeof library === "string"
          ? /^\d+$/.test(key)
            ? library
            : undefined
          : json.caselessGet(library, [["path"]]);
      if (folder) {
        // (the VDF reader leaves Steam's escaped backslashes doubled)
        folders.push(
          path.join(String(folder).replace(/\\\\/g, "\\"), "steamapps"),
        );
      }
    }
  } catch {
    // (only the main library, then)
  }
  const games: { appId: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const key = path.resolve(folder).toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(folder)
        .filter((file) => /^appmanifest_\d+\.acf$/i.test(file));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const state = json.caselessGet(
          genericParser.parse(fs.readFileSync(path.join(folder, file), "utf8")),
          [["AppState"]],
        );
        const name = json.caselessGet(state, [["name"]]);
        const appId = json.caselessGet(state, [["appid"]]);
        if (name !== null && name !== undefined && String(name) !== "") {
          games.push({ appId: String(appId ?? ""), name: String(name) });
        }
      } catch {
        // (one bad manifest: that game only)
      }
    }
  }
  return games;
}

// The normalized titles of the games Steam has installed itself.
export function steamInstalledTitles(steamDir: string): Set<string> {
  return new Set(
    steamInstalledGames(steamDir).map((g) => normalizeTitle(g.name)),
  );
}

// Where a store stands in the preferred order: lower is preferred. Stores
// missing from `order` come after the listed ones, in DEFAULT_STORE_ORDER.
export function storeRank(
  store: string,
  order: readonly string[] = DEFAULT_STORE_ORDER,
): number {
  const rank = order.indexOf(store);
  if (rank >= 0) {
    return rank;
  }
  const fallback = DEFAULT_STORE_ORDER.indexOf(store as StoreKey);
  return order.length + (fallback >= 0 ? fallback : DEFAULT_STORE_ORDER.length);
}

// A game a store account owns and hasn't installed, as one store's Store
// Account parser lists it.
export interface OwnedEntry {
  title: string;
  store: StoreKey;
}

export interface MultiStoreSettings {
  multiStore: MultiStore;
  // Store keys, most preferred first (see storeRank).
  storeOrder: readonly string[];
}

export const DEFAULT_MULTI_STORE_SETTINGS: MultiStoreSettings = {
  multiStore: "preferred",
  storeOrder: DEFAULT_STORE_ORDER,
};

// The entries of one Steam user that stay when several stores own a game
// (the same normalizeTitle), and those that go. With "preferred", only the
// entries of the store that comes first in the store order among the stores
// that own it stay; with "all" (or with one store), every one. A store's
// entries stay or go together: two entries of one store are not a game
// several stores own. The order is kept.
export function arrangeOwned<T extends OwnedEntry>(
  entries: readonly T[],
  settings: MultiStoreSettings,
): { kept: T[]; otherStore: T[] } {
  if (settings.multiStore === "all") {
    return { kept: [...entries], otherStore: [] };
  }
  const rank = (entry: T) => storeRank(entry.store, settings.storeOrder);
  // The best rank among the stores that own a title. (A title of only
  // signs matches nothing.)
  const best = new Map<string, number>();
  for (const entry of entries) {
    const title = normalizeTitle(entry.title);
    const known = best.get(title);
    if (title !== "" && (known === undefined || rank(entry) < known)) {
      best.set(title, rank(entry));
    }
  }
  const kept: T[] = [];
  const otherStore: T[] = [];
  for (const entry of entries) {
    const known = best.get(normalizeTitle(entry.title));
    if (known !== undefined && rank(entry) > known) {
      otherStore.push(entry);
    } else {
      kept.push(entry);
    }
  }
  return { kept, otherStore };
}
