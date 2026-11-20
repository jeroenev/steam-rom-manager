// Which owned games go into Steam: not betas and demos, not what Steam or
// another launcher has installed, one entry for a game several stores own.
// Ported from BoilR's accounts/arrange.rs, platform.rs and core owned.rs.

import * as fs from "fs";
import * as path from "path";
import * as genericParser from "@node-steam/vdf";
import * as json from "../helpers/json";
import { StoreKey } from "./types";

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

// What to do with a game more than one store account owns while it isn't
// installed: one entry, from the first store in the preferred order; one per
// store, each named after its store ("Frostpunk (GOG)"); or one per store,
// with the same name.
export type MultiStore = "preferred" | "labelStore" | "all";

// The store order when none is set: DRM-free first, then the stores with
// the most complete launchers.
export const DEFAULT_STORE_ORDER: readonly StoreKey[] = [
  "gog",
  "epic",
  "amazon",
  "ea",
  "battlenet",
  "humble",
  "itch",
];

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

// The short name of a store in a game's name.
export function storeLabel(store: string): string {
  const labels: Record<string, string> = {
    epic: "Epic",
    gog: "GOG",
    amazon: "Amazon",
    ea: "EA",
    battlenet: "Battle.net",
    humble: "Humble",
    itch: "itch.io",
  };
  return labels[store] ?? store;
}

// A game's name with the label asked for: "Frostpunk (GOG)", "Frostpunk
// (Not installed)", "Frostpunk (GOG, not installed)".
export function labelledName(
  title: string,
  store: string,
  showStore: boolean,
  showNotInstalled: boolean,
): string {
  const label =
    showStore && showNotInstalled
      ? `${storeLabel(store)}, not installed`
      : showStore
        ? storeLabel(store)
        : showNotInstalled
          ? "Not installed"
          : undefined;
  return label ? `${title} (${label})` : title;
}

// A game in the lists of a run: installed (from any launcher), or owned and
// not installed (`store` set).
export interface ArrangeEntry {
  title: string;
  installed: boolean;
  store?: StoreKey;
}

export interface ArrangeSettings {
  // Leave out a game another launcher has installed (the same name).
  skipInstalledElsewhere: boolean;
  // Leave out a game Steam has installed itself.
  skipGamesInSteam: boolean;
  multiStore: MultiStore;
  storeOrder: readonly string[];
}

export const DEFAULT_ARRANGE_SETTINGS: ArrangeSettings = {
  skipInstalledElsewhere: true,
  skipGamesInSteam: true,
  multiStore: "preferred",
  storeOrder: DEFAULT_STORE_ORDER,
};

// What arrangeOwned left out.
export interface Arranged {
  // Steam has the game installed itself.
  inSteam: number;
  // Installed from another launcher.
  installedElsewhere: number;
  // Owned in a store further down the preferred order.
  otherStore: number;
}

// Applies the settings to the entries of a run (names compared by
// normalizeTitle):
// 1. with skipInstalledElsewhere, an owned entry whose title an installed
//    entry has goes;
// 2. with skipGamesInSteam, one whose title is in `steamTitles` goes;
// 3. a title several stores own keeps one entry ("preferred"), or each
//    entry is named after its store ("labelStore").
// Installed entries stay as they are; the order is kept.
export function arrangeOwned<T extends ArrangeEntry>(
  entries: T[],
  settings: ArrangeSettings,
  steamTitles: Set<string>,
): { entries: T[]; arranged: Arranged } {
  const arranged: Arranged = {
    inSteam: 0,
    installedElsewhere: 0,
    otherStore: 0,
  };
  const owned = (entry: T) => !entry.installed && !!entry.store;
  const installedTitles = new Set(
    entries.filter((e) => e.installed).map((e) => normalizeTitle(e.title)),
  );
  let kept = entries.filter((entry) => {
    if (!owned(entry)) {
      return true;
    }
    const title = normalizeTitle(entry.title);
    if (settings.skipInstalledElsewhere && installedTitles.has(title)) {
      arranged.installedElsewhere++;
      return false;
    }
    if (settings.skipGamesInSteam && steamTitles.has(title)) {
      arranged.inSteam++;
      return false;
    }
    return true;
  });

  // Every store that owns a title, best first.
  const storesOf = new Map<string, StoreKey[]>();
  for (const entry of kept.filter(owned)) {
    const title = normalizeTitle(entry.title);
    const stores = storesOf.get(title) || [];
    if (!stores.includes(entry.store)) {
      stores.push(entry.store);
    }
    storesOf.set(title, stores);
  }
  for (const stores of storesOf.values()) {
    stores.sort(
      (a, b) =>
        storeRank(a, settings.storeOrder) - storeRank(b, settings.storeOrder),
    );
  }

  if (settings.multiStore == "preferred") {
    // The preferred store's first entry of a title stays.
    const done = new Set<string>();
    kept = kept.filter((entry) => {
      if (!owned(entry)) {
        return true;
      }
      const title = normalizeTitle(entry.title);
      const best = storesOf.get(title)?.[0];
      if ((best === undefined || best == entry.store) && !done.has(title)) {
        done.add(title);
        return true;
      }
      arranged.otherStore++;
      return false;
    });
  } else if (settings.multiStore == "labelStore") {
    kept = kept.map((entry) =>
      owned(entry) &&
      (storesOf.get(normalizeTitle(entry.title))?.length ?? 0) > 1
        ? {
            ...entry,
            title: labelledName(entry.title, entry.store, true, false),
          }
        : entry,
    );
  }
  return { entries: kept, arranged };
}
