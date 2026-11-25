import { OnlineProviderType } from ".";
import { imageLoadStrategies } from "../lib/image-providers/available-providers";
import { FuzzyListTimestamps } from "./fuzzy.model";
import { DEFAULT_STORE_ORDER, MultiStore, StoreKey } from "../lib/stores/types";

export type imageLoadStrategy = (typeof imageLoadStrategies)[number];

export interface PreviewSettings {
  retrieveCurrentSteamImages: boolean;
  disableCategories: boolean;
  deleteDisabledShortcuts: boolean;
  imageZoomPercentage: number;
  imageLoadStrategy: imageLoadStrategy;
  imageTypes: string[];
  hideUserAccount: boolean;
}

export interface AppSettings {
  fuzzyMatcher: {
    timestamps: FuzzyListTimestamps;
    verbose: boolean;
  };
  environmentVariables: {
    steamDirectory: string;
    userAccounts: string[];
    romsDirectory: string;
    retroarchPath: string;
    localImagesDirectory: string;
    raCoresDirectory: string;
  };
  language: string;
  theme: string;
  emudeckInstall: boolean;
  autoUpdate: boolean;
  offlineMode: boolean;
  enabledProviders: OnlineProviderType[];
  batchDownloadSize: number;
  dnsServers: string[];
  previewSettings: PreviewSettings;
  navigationWidth: number;
  clearLogOnTest: boolean;
  autoKillSteam: boolean;
  autoRestartSteam: boolean;
  parserGroups: ParserGroup[];
  ownedGames: OwnedGamesSettings;
}

// Games the store accounts own but haven't installed (Store Account
// parsers).
export interface OwnedGamesSettings {
  // Most preferred first; stores left out come after, in
  // DEFAULT_STORE_ORDER.
  storeOrder: StoreKey[];
  // A game several stores own: one shortcut, from the first of them in
  // storeOrder, or one from every store.
  multiStore: MultiStore;
  // The app asks before a save that adds more such games than this to
  // Steam (0: never).
  confirmAbove: number;
  // A library older than this is fetched again by itself.
  libraryMaxAgeHours: number;
}

export const DEFAULT_OWNED_GAMES: Readonly<OwnedGamesSettings> = {
  storeOrder: [...DEFAULT_STORE_ORDER],
  multiStore: "preferred",
  confirmAbove: 100,
  libraryMaxAgeHours: 6,
};

export interface ParserGroup {
  name: string;
  collapsed: boolean;
}
