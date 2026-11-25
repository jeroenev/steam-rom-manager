import { userAccountData, StringLiteralArray } from "./helpers.model";
import { Controllers } from "./controllers.model";
import { ImageProviderAPI } from "./user-configuration.model";
import { OnlineProviderType, ArtworkType, SelectItem } from ".";
import { LaunchWrapper, ParserLaunchWrapper } from "./launch-wrapper.model";
import type { StoreKey } from "../lib/stores/types";
import type { SgdbPlatformId } from "./image-providers.model";

export interface StringMap {
  [key: string]: any;
}

/* Title waterfall is
 - 1. extractedTitle (the title extracted by the parser; no modifications)
 - 2. customVariablesTitle (the title after applying any custom variables to the title)
 - 3. shortcutsPassthroughTitle (the title being read from the shortcut if what is being parsed is a .lnk or .desktop)
 - 4. fuzzyTitle (the title produced by fuzzy matching if enabled)
 - 5. finalTitle (the final title that will be used in steam)

 - 2b. sortAsTitle (the separate sort-by title that will be used by steam; only exists if set by a custom variable)
*/

export const TITLE_MODIFIER_KEYS = [
  "extracted",
  "postShortcutPassthrough",
  "postCustomVariables",
  "postFuzzy",
  "postTitleModifier",
  "final",
] as const; // ordered title waterfall
export type TitleModifierKey = (typeof TITLE_MODIFIER_KEYS)[number];
export type TitleModifiers = Record<TitleModifierKey, string | null>;

export interface ParsedUserConfigurationFile {
  executableLocation: string;
  modifiedExecutableLocation: string;
  startInDirectory: string;
  filePath: string;
  titles: TitleModifiers;
  sortAsTitle: string; // not actually part of the title waterfall
  argumentString: string;
  // Resolved Steam Play compat tool for this specific file. Seeded from the
  // parser config, then possibly overridden per-game by a user exception.
  // "" = don't force one; "__none__" = force no tool (opt this game out).
  compatToolName: string;
  appendArgsToExecutable: boolean;
  onlineImageQueries: string[];
  // The game's id at a store SteamGridDB knows (ParsedSuccess); dropped when
  // an exception sets the game's artwork search.
  sgdbPlatformId?: SgdbPlatformId;
  steamCategories: string[];
  imagePool: string;
  defaultImage: Record<ArtworkType, string>;
  backupImage: Record<ArtworkType, string>;
  localImages: Record<ArtworkType, string[]>;
  resolvedDefaultImages: Record<ArtworkType, string[]>;
  resolvedLocalImages: Record<ArtworkType, string[]>;
  // The parser's own scripts for this game (folded into launchWrapper).
  parserLaunchWrapper?: ParserLaunchWrapper;
  // Set when the shortcut runs SRM's launch script: modifiedExecutableLocation
  // is then the script's, and the game's own executable is the target.
  launchWrapper?: LaunchWrapper;
}

export interface ParsedUserConfiguration {
  configurationTitle: string;
  parserId: string;
  parserType: ParserType;
  drmProtect: boolean;
  imageProviders: OnlineProviderType[];
  imageProviderAPIs: ImageProviderAPI;
  controllers: Controllers;
  steamInputEnabled: SteamInputEnabled;
  steamDirectory: string;
  shortcutPassthrough: boolean;
  overlayImages: Record<ArtworkType, string>;
  foundUserAccounts: userAccountData[];
  missingUserAccounts: string[];
  files: ParsedUserConfigurationFile[];
  failed: string[];
  // Games left out by an exclusion (see models/user-exceptions.model.ts).
  excluded: { exclusionId: string; title: string; filePath: string }[];
  // A Store Account parser's: the store whose account it lists.
  store?: StoreKey;
  // ParsedData.skipped
  skipped?: string;
}
const inputTypes = StringLiteralArray([
  "text",
  "path",
  "dir",
  "toggle",
  "select",
  "multiselect",
  // Not a setting: the sign-in and library of the store account a Store
  // Account parser lists, shown in the parser editor. Never saved with the
  // parser (userConfigurations.json goes into bug reports), so it's left
  // out of availableParserInputs and the schema.
  "account",
]);
export type ParserInputType = (typeof inputTypes)[number];

// Whether an input of this type is part of the parser's settings.
export function isSavedInput(inputType: ParserInputType) {
  return inputType !== "account";
}

export interface ParserInputField {
  [inputKey: string]: {
    label: string;
    placeholder?: string;
    inputType: ParserInputType;
    allowedValues?: SelectItem[];
    initialValue?: string[] | string | boolean;
    hidden?: boolean;
    // Only show this input when another parser input equals a given value
    // (e.g. show the Steam API key only when the fetch strategy is "webapi").
    hiddenUnless?: { field: string; value: string };
    // An "account" input: the parser input that names its store.
    accountOf?: string;
    required?: boolean;
    important?: boolean;
    info?: string;
    validationFn?: (inputData: any) => null | string;
  };
}

// TODO Split this up more sanely into ImporterParsedData and ManagerParsedData
export interface ParsedSuccess {
  extractedTitle: string;
  filePath?: string; // Used by ROM parsers, and platform parsers in executable mode
  extractedAppId?: string; // Used by artwork only parsers
  launchOptions?: string; // Used by platform parsers in launcher mode
  fileLaunchOptions?: string; // Used by platform parsers executable mode
  startInDirectory?: string; //Used by manual parsers and parsers whose apps start in a different directory than the executable,
  appendArgsToExecutable?: boolean; //Used by manual parsers
  // Scripts the parser runs around the launch (see lib/launch-wrapper).
  launchWrapper?: ParserLaunchWrapper;
  // The game's id at a store SteamGridDB knows (Store Account parser): its
  // artwork is looked up by it before the title search.
  sgdbPlatformId?: SgdbPlatformId;
}

export interface ParsedData {
  executableLocation?: string; // Used by platform parsers in launcher mode
  success: ParsedSuccess[];
  failed: string[];
  // Why the parser has no games and wasn't run, in a state that is normal
  // (a Store Account parser that isn't signed in): the other parsers' games
  // are listed all the same, and the preview's log says this.
  skipped?: string;
}

export interface ParserVariableData {
  configTitle: string;
  executableLocation: string;
  startInDirectory: string;
  steamDirectory: string;
  romDirectory: string;
  titles: TitleModifiers;
  filePath: string;
  steamDirectoryGlobal: string;
  romsDirectoryGlobal: string;
  retroarchPath: string;
  raCoresDirectory: string;
  localImagesDirectory: string;
}

const directoryVariables = StringLiteralArray([
  "EXEDIR",
  "ROMDIR",
  "STEAMDIR",
  "STARTINDIR",
  "FILEDIR",
]);
const nameVariables = StringLiteralArray(["EXENAME", "FILENAME"]);
const extensionVariables = StringLiteralArray(["EXEEXT", "FILEEXT"]);
const pathVariables = StringLiteralArray(["EXEPATH", "FILEPATH"]);
const parserVariables = StringLiteralArray([
  "TITLE",
  "SHORTCUTTITLE",
  "CUSTOMVARIABLETITLE",
  "FUZZYTITLE",
  "FINALTITLE",
  "PARSERTITLE",
]);
const environmentVariables = StringLiteralArray([
  "/",
  "SRMDIR",
  "STEAMDIRGLOBAL",
  "ACCOUNTSGLOBAL",
  "ROMSDIRGLOBAL",
  "RETROARCHPATH",
  "RACORES",
  "LOCALIMAGESDIR",
]);

export type DirectoryVariables = (typeof directoryVariables)[number];
export type NameVariables = (typeof nameVariables)[number];
export type ExtensionVariables = (typeof extensionVariables)[number];
export type PathVariables = (typeof pathVariables)[number];
export type ParserVariables = (typeof parserVariables)[number];
export type EnvironmentVariables = (typeof environmentVariables)[number];

const steamInputEnabled = StringLiteralArray(["0", "1", "2"]); // 0 disabled, 1 global settings, 2 enabled
export type SteamInputEnabled = (typeof steamInputEnabled)[number];

export type ParserType =
  | "Glob"
  | "Glob-regex"
  | "Manual"
  | "Amazon Games"
  | "Epic"
  | "Legendary"
  | "GOG Galaxy"
  | "itch.io"
  | "Steam"
  | "Non-SRM Shortcuts"
  | "UPlay"
  | "UWP"
  | "EA Desktop"
  | "Battle.net"
  | "GitHub Launcher"
  | "Quiver Launcher"
  | "Store Account";
export type SuperType = "Manual" | "ArtworkOnly" | "ROM" | "Platform";

export interface ParserInfo {
  title: ParserType;
  info?: string;
  inputs?: ParserInputField;
}

export type AllVariables =
  | DirectoryVariables
  | NameVariables
  | ExtensionVariables
  | PathVariables
  | ParserVariables
  | EnvironmentVariables;

export const isEnvironmentVariable = (x: any): x is EnvironmentVariables =>
  environmentVariables.indexOf(x as EnvironmentVariables) >= 0;
export const isNameVariable = (x: any): x is NameVariables =>
  nameVariables.indexOf(x as NameVariables) >= 0;
export const isExtensionVariable = (x: any): x is ExtensionVariables =>
  extensionVariables.indexOf(x as ExtensionVariables) >= 0;
export const isPathVariable = (x: any): x is PathVariables =>
  pathVariables.indexOf(x as PathVariables) >= 0;
export const isParserVariable = (x: any): x is ParserVariables =>
  parserVariables.indexOf(x as ParserVariables) >= 0;
export const isDirectoryVariable = (x: any): x is DirectoryVariables =>
  directoryVariables.indexOf(x as DirectoryVariables) >= 0;
export const isVariable = (x: any): x is AllVariables =>
  isEnvironmentVariable(x) ||
  isNameVariable(x) ||
  isExtensionVariable(x) ||
  isPathVariable(x) ||
  isParserVariable(x) ||
  isDirectoryVariable(x);

export interface GenericParser {
  getParserInfo(): ParserInfo;
  execute: (
    directories: string[],
    inputs: { [key: string]: any },
    cache?: { [key: string]: any },
  ) => Promise<ParsedData>;
}
