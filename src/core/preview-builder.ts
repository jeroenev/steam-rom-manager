import {
  PreviewData,
  ParsedUserConfiguration,
  ParsedUserConfigurationFile,
  ParserType,
  OnlineImages,
  AppSettings,
  SteamTree,
  SGDBToArt,
  ArtworkType,
  PreviewDataAppImage,
  initArtworkRecord,
  Logger,
} from "../models";
import { ArtworkCache, VDF_Manager } from "../lib";
import { APP } from "../variables";
import * as steam from "../lib/helpers/steam";
import * as url from "../lib/helpers/url";
import * as ids from "../lib/helpers/steam";
import { artworkTypes, artworkIdDict } from "../lib/artwork-types";
import { superTypesMap } from "../lib/parsers/available-parsers";
import * as _ from "lodash";
import { imageProviderNames } from "../lib/image-providers/available-providers";
import { ParsersStore } from "./parsers-store";
import { SettingsStore } from "./settings-store";
import { addUniqueLocalImage, emptyPools } from "./image-pools";
import {
  DEFAULT_MULTI_STORE_SETTINGS,
  MultiStoreSettings,
  OwnedEntry,
  arrangeOwned,
  storeRank,
} from "../lib/stores/arrange";
import { isStoreKey } from "../lib/stores/types";

export interface BuildResult {
  // Absent when the parsers produced nothing to add.
  previewData?: PreviewData;
  numberOfItems: number;
  // Fresh artwork pools: search queries and local images, no online images.
  onlineImages: OnlineImages;
  // SteamGridDB artwork previously chosen per game (artworkCache.json).
  sgdbToArt?: SGDBToArt;
}

// The app id of a parsed file's shortcut (an artwork-only parser's file names
// an existing shortcut's).
export function appIdOf(
  parserType: ParserType,
  file: Pick<
    ParsedUserConfigurationFile,
    "modifiedExecutableLocation" | "titles"
  >,
): string {
  return superTypesMap[parserType] !== "ArtworkOnly"
    ? steam.generateAppId(file.modifiedExecutableLocation, file.titles.final)
    : steam.lengthenAppId(file.modifiedExecutableLocation.replace(/\"/g, ""));
}

const STORE_ACCOUNT: ParserType = "Store Account";

const accountKey = (steamDirectory: string, accountID: string) =>
  `${steamDirectory}\n${accountID}`;

// The app ids every parser but the Store Account parsers gives, per Steam
// directory and user account. A Store Account shortcut (a game that isn't
// installed) with one of them is left out: it is that parser's game (an
// installed copy its id didn't match, such as an EA game whose content id
// wasn't known; or one installed from another store whose launcher-mode
// parser uses the same program, PowerShell for Epic and EA), and would
// otherwise replace it or put it in "Not installed". Two Store Account
// parsers with the same app id: ownedInOtherStores settles it by the store
// order when their stores differ; for one store's, the first one's.
export function otherParsersAppIds(
  configs: readonly ParsedUserConfiguration[],
): Map<string, Set<string>> {
  const taken = new Map<string, Set<string>>();
  for (const config of configs) {
    if (config.parserType === STORE_ACCOUNT) {
      continue;
    }
    for (const account of config.foundUserAccounts) {
      const key = accountKey(config.steamDirectory, account.accountID);
      let ids = taken.get(key);
      if (!ids) {
        ids = new Set();
        taken.set(key, ids);
      }
      for (const file of config.files) {
        ids.add(appIdOf(config.parserType, file));
      }
    }
  }
  return taken;
}

// The Store Account files left out because the Store Account parser of
// another store has the same game for the same Steam directory and user
// account, and that store comes first in the store order: per Steam
// directory and user account. The same game is the same normalizeTitle of
// the extracted title (see arrangeOwned; never with multiStore "all"), or,
// in either mode, the same app id: stores whose shortcuts run the same
// program (the browser opener, PowerShell for Epic and EA) give the same
// title one Steam shortcut, which goes to the store that comes first, not to
// the parser that comes first. Files the guard above leaves out
// (`takenByOthers`) don't count: they aren't added. Other parsers' files are
// no part of this.
export function ownedInOtherStores(
  configs: readonly ParsedUserConfiguration[],
  settings: MultiStoreSettings,
  takenByOthers: Map<string, Set<string>> = otherParsersAppIds(configs),
): Map<string, Set<ParsedUserConfigurationFile>> {
  type Entry = OwnedEntry & { file: ParsedUserConfigurationFile };
  const entries = new Map<string, Entry[]>();
  for (const config of configs) {
    if (config.parserType !== STORE_ACCOUNT || !isStoreKey(config.store)) {
      continue;
    }
    for (const account of config.foundUserAccounts) {
      const key = accountKey(config.steamDirectory, account.accountID);
      const taken = takenByOthers.get(key);
      let list = entries.get(key);
      if (!list) {
        list = [];
        entries.set(key, list);
      }
      for (const file of config.files) {
        if (!taken?.has(appIdOf(config.parserType, file))) {
          list.push({
            title: file.titles.extracted ?? file.titles.final ?? "",
            store: config.store,
            file,
          });
        }
      }
    }
  }
  const leftOut = new Map<string, Set<ParsedUserConfigurationFile>>();
  const rank = (entry: Entry) => storeRank(entry.store, settings.storeOrder);
  for (const [key, list] of entries) {
    const { kept, otherStore } = arrangeOwned(list, settings);
    // One shortcut per app id: the best-ranked store's. (One store's
    // entries with the same app id stay: the first one is added.)
    const best = new Map<string, number>();
    for (const entry of kept) {
      const appId = appIdOf(STORE_ACCOUNT, entry.file);
      const known = best.get(appId);
      if (known === undefined || rank(entry) < known) {
        best.set(appId, rank(entry));
      }
    }
    const sameShortcut = kept.filter(
      (entry) => rank(entry) > best.get(appIdOf(STORE_ACCOUNT, entry.file))!,
    );
    const files = [...otherStore, ...sameShortcut].map((entry) => entry.file);
    if (files.length > 0) {
      leftOut.set(key, new Set(files));
    }
  }
  return leftOut;
}

// The app ids of the shortcuts each Steam user of `tree` has in Steam
// (shortcuts.vdf), made from program and title as SRM's own are: per Steam
// directory and user account. (getNonSteamShortcutsData doesn't index
// them.)
export async function steamShortcutIds(
  tree: SteamTree<any>,
): Promise<Map<string, Set<string>>> {
  const ids = new Map<string, Set<string>>();
  if (tree.numberOfUsers === 0) {
    return ids;
  }
  const vdf = new VDF_Manager();
  await vdf.prepare(tree.tree as any as PreviewData);
  await vdf.read({
    shortcuts: { read: true, skipIndexing: false },
    addedItems: false,
    screenshots: false,
  });
  vdf.forEach((steamDirectory, userId, listItem) => {
    ids.set(
      accountKey(steamDirectory, userId),
      new Set(listItem.shortcuts.getAppIds()),
    );
  });
  return ids;
}

// Builds the preview list: runs the enabled parsers and turns their output
// into per-Steam-user apps with artwork pools. Reads parser inputs and Steam
// files, so it runs in the main process.
export class PreviewBuilder {
  constructor(
    private loggerService: Logger,
    private parsers: Pick<
      ParsersStore,
      "executeFileParser" | "executeFileParserReusing" | "getAll"
    >,
    private settings: Pick<SettingsStore, "get">,
  ) {}

  private get appSettings(): AppSettings {
    return this.settings.get();
  }

  private get lang() {
    return APP.lang.preview.service;
  }

  // Throws if the parsers fail; logs (as the UI did) what was skipped.
  // `parserIds`: run just these parsers, enabled or not.
  // `reuse` (Add Games' refresh): parsers that haven't changed since the
  // last build aren't parsed again (see ParseCache).
  async build({
    parserIds,
    reuse = false,
  }: { parserIds?: string[]; reuse?: boolean } = {}): Promise<BuildResult> {
    const pools = emptyPools();
    let previewData;
    const chosen = parserIds
      ? this.parsers.getAll().filter((c) => parserIds.includes(c.parserId))
      : [];
    let data =
      reuse && !parserIds
        ? await this.parsers.executeFileParserReusing(...chosen)
        : await this.parsers.executeFileParser(...chosen);
    const ran = data.parsedData.parsedConfigs.length;
    if (reuse && data.reparsed < ran) {
      this.loggerService.info(
        this.lang.info.reusedParsers__i.interpolate({
          parsed: data.reparsed,
          total: ran,
        }),
      );
    }
    if (data.skipped.length > 0) {
      this.loggerService.info(
        this.lang.info.disabledConfigurations__i.interpolate({
          count: data.skipped.length,
        }),
        { invokeAlert: true, alertTimeout: 3000 },
      );
      for (let i = 0; i < data.skipped.length; i++) {
        this.loggerService.info(data.skipped[i]);
      }
    }

    if (data.invalid.length > 0) {
      this.loggerService.info(
        this.lang.info.invalidConfigurations__i.interpolate({
          count: data.invalid.length,
        }),
        { invokeAlert: true, alertTimeout: 3000 },
      );
      for (let i = 0; i < data.invalid.length; i++) {
        this.loggerService.info(data.invalid[i]);
      }
    }

    if (data.parsedData.parsedConfigs.length > 0) {
      if (data.parsedData.noUserAccounts) {
        this.loggerService.info(this.lang.info.noAccountsWarning, {
          invokeAlert: true,
          alertTimeout: 3000,
        });
      } else {
        if (
          !this.appSettings.previewSettings.disableCategories &&
          !this.appSettings.autoKillSteam
        ) {
          this.loggerService.info(this.lang.info.shutdownSteam, {
            invokeAlert: true,
            alertTimeout: 3000,
          });
        }
        previewData = await this.createPreviewData(
          data.parsedData.parsedConfigs,
          pools,
        );
      }
    } else if (data.invalid.length === 0 && data.skipped.length === 0) {
      if (this.parsers.getAll().length === 0)
        this.loggerService.info(this.lang.info.noParserConfigurations, {
          invokeAlert: true,
          alertTimeout: 3000,
        });
      else
        this.loggerService.info(this.lang.info.parserFoundNoFiles, {
          invokeAlert: true,
          alertTimeout: 3000,
        });
    }
    if (!previewData || previewData.numberOfItems === 0) {
      return { numberOfItems: 0, onlineImages: pools };
    }
    const artworkCache = new ArtworkCache();
    await artworkCache.read();
    return {
      previewData: previewData.data,
      numberOfItems: previewData.numberOfItems,
      onlineImages: pools,
      sgdbToArt: artworkCache.sgdbToArt,
    };
  }

  private async createPreviewData(
    data: ParsedUserConfiguration[],
    pools: OnlineImages,
  ) {
    let steamTreeData = steam.generateTreeFromParsedConfig(data);
    let treeData: { gridData: SteamTree<any>; steamTreeData: SteamTree<any> };
    if (this.appSettings.previewSettings.retrieveCurrentSteamImages)
      treeData = await steam
        .getGridImagesForTree(steamTreeData)
        .then((gridData) => {
          return { gridData, steamTreeData };
        });
    else treeData = { gridData: steamTreeData, steamTreeData };

    let nonSteamShortcutsData = await steam
      .getNonSteamShortcutsData(treeData.steamTreeData)
      .then((shortcutData) => {
        return Object.assign(treeData, { shortcutData });
      });
    let shortcutsData = nonSteamShortcutsData.shortcutData.tree;
    let gridData = nonSteamShortcutsData.gridData.tree;
    let numberOfItems: number = 0;
    let previewData: PreviewData = {};
    const takenByOthers = otherParsersAppIds(data);
    let ownedDuplicates = 0;
    const otherStores = ownedInOtherStores(
      data,
      this.appSettings.ownedGames ?? DEFAULT_MULTI_STORE_SETTINGS,
      takenByOthers,
    );
    let ownedInOtherStore = 0;
    const inSteam = data.some(
      (config) => config.parserType === STORE_ACCOUNT && config.files.length,
    )
      ? await steamShortcutIds(steamTreeData)
      : new Map<string, Set<string>>();

    for (let i = 0; i < data.length; i++) {
      let config = data[i];
      if (previewData[config.steamDirectory] === undefined)
        previewData[config.steamDirectory] = {};

      for (let j = 0; j < config.foundUserAccounts.length; j++) {
        let userAccount = config.foundUserAccounts[j];

        if (
          previewData[config.steamDirectory][userAccount.accountID] ===
          undefined
        ) {
          previewData[config.steamDirectory][userAccount.accountID] = {
            username: userAccount.name,
            excluded: data
              .map((x) => x.excluded)
              .reduce((x, y) => x.concat(y), []),
            apps: {},
          };
        } else if (
          previewData[config.steamDirectory][userAccount.accountID].username !==
          userAccount.name
        ) {
          previewData[config.steamDirectory][userAccount.accountID].username =
            `${previewData[config.steamDirectory][userAccount.accountID].username} | ${userAccount.name}`;
        }

        for (let k = 0; k < data[i].files.length; k++) {
          let file = config.files[k];
          let executableLocation = file.modifiedExecutableLocation;
          let appID = appIdOf(config.parserType, file);
          const userKey = accountKey(
            config.steamDirectory,
            userAccount.accountID,
          );
          if (config.parserType === STORE_ACCOUNT) {
            if (takenByOthers.get(userKey)?.has(appID)) {
              ownedDuplicates++;
              continue;
            }
            if (otherStores.get(userKey)?.has(file)) {
              ownedInOtherStore++;
              continue;
            }
          }

          if (
            shortcutsData[config.steamDirectory][userAccount.accountID][
              appID
            ] !== undefined
          ) {
            if (
              shortcutsData[config.steamDirectory][userAccount.accountID][
                appID
              ]["icon"] !== undefined
            ) {
              if (
                file.localImages["icon"].indexOf(
                  shortcutsData[config.steamDirectory][userAccount.accountID][
                    appID
                  ]["icon"],
                ) === -1
              ) {
                file.localImages["icon"].unshift(
                  shortcutsData[config.steamDirectory][userAccount.accountID][
                    appID
                  ]["icon"],
                );
              }
            }
          }
          // (a Store Account game's id at its store: both providers find
          // the game by it first)
          const platformIds = file.sgdbPlatformId ? [file.sgdbPlatformId] : [];
          for (const artworkType of artworkTypes) {
            if (pools[artworkType][file.imagePool] === undefined) {
              pools[artworkType][file.imagePool] = {
                online: {
                  sgdb: {
                    searchQueries: file.onlineImageQueries,
                    platformIds: [...platformIds],
                    imageProviderAPIs: config.imageProviderAPIs.sgdb,
                    content: [],
                  },
                  steamCDN: {
                    searchQueries: file.onlineImageQueries,
                    platformIds: [...platformIds],
                    imageProviderAPIs: config.imageProviderAPIs.steamCDN || {},
                    content: [],
                  },
                },
                offline: { local: [], manual: [], imported: [] },
                retrieving: false,
                parserEnabledProviders: config.imageProviders,
              };
            } else {
              // (another parser's game with this pool: its providers too)
              pools[artworkType][file.imagePool].parserEnabledProviders =
                _.union(
                  pools[artworkType][file.imagePool].parserEnabledProviders,
                  config.imageProviders,
                );
              for (const provider of config.imageProviders) {
                const online =
                  pools[artworkType][file.imagePool].online[provider];
                online.imageProviderAPIs = config.imageProviderAPIs[provider];
                online.searchQueries = _.union(
                  online.searchQueries,
                  file.onlineImageQueries,
                );
                online.platformIds = _.unionWith(
                  online.platformIds ?? [],
                  platformIds,
                  _.isEqual,
                );
              }
            }
          }

          if (
            previewData[config.steamDirectory][userAccount.accountID].apps[
              appID
            ] === undefined
          ) {
            let images: Record<ArtworkType, PreviewDataAppImage> =
              initArtworkRecord<PreviewDataAppImage>(() => null);
            for (const artworkType of artworkTypes) {
              const steamImage =
                gridData[config.steamDirectory][userAccount.accountID][
                  ids.shortenAppId(appID).concat(artworkIdDict[artworkType])
                ];
              const steamImageUrl = steamImage
                ? url.encodeFile(steamImage)
                : undefined;
              images[artworkType] = {
                singleProviders: {
                  steam: steamImage
                    ? {
                        imageProvider: imageProviderNames.steam,
                        imageUrl: steamImageUrl,
                        imageRes: url.imageDimensions(steamImageUrl),
                        loadStatus: "done",
                      }
                    : undefined,
                  artworkBackup: file.backupImage[artworkType]
                    ? {
                        imageProvider: imageProviderNames.artworkBackup,
                        imageUrl: file.backupImage[artworkType],
                        imageRes: url.imageDimensions(
                          file.backupImage[artworkType],
                        ),
                        loadStatus: "done",
                      }
                    : undefined,
                },
                default: file.defaultImage[artworkType]
                  ? {
                      imageProvider: imageProviderNames.default,
                      imageUrl: file.defaultImage[artworkType],
                      imageRes: url.imageDimensions(
                        file.defaultImage[artworkType],
                      ),
                      loadStatus: "done",
                    }
                  : undefined,
                imagePool: file.imagePool,
                imageIndex: 0,
              };
              for (let localUrl of file.localImages[artworkType]) {
                addUniqueLocalImage(
                  pools,
                  file.imagePool,
                  {
                    imageProvider: imageProviderNames.local,
                    imageUrl: localUrl,
                    imageRes: url.imageDimensions(localUrl),
                    loadStatus: "done",
                  },
                  artworkType,
                  "local",
                );
              }
            }

            previewData[config.steamDirectory][userAccount.accountID].apps[
              appID
            ] = {
              entryId: numberOfItems++,
              status: "add",
              configurationTitle: config.configurationTitle,
              parserId: config.parserId,
              parserType: config.parserType,
              steamCategories: file.steamCategories,
              startInDirectory: file.startInDirectory,
              onlineProviders: config.imageProviders,
              drmProtect: config.drmProtect,
              argumentString: file.argumentString,
              filePath: file.filePath,
              title: file.titles.final,
              extractedTitle: file.titles.extracted,
              sortAsTitle: file.sortAsTitle,
              steamInputEnabled: config.steamInputEnabled,
              controllers: config.controllers,
              compatToolName: file.compatToolName,
              images: images,
              overlayImages: config.overlayImages,
              executableLocation,
              ...(file.launchWrapper && { launchWrapper: file.launchWrapper }),
              ...(config.parserType === STORE_ACCOUNT && {
                notInSteam: !inSteam.get(userKey)?.has(appID),
              }),
            };
          } else {
            let currentCategories =
              previewData[config.steamDirectory][userAccount.accountID].apps[
                appID
              ].steamCategories;
            previewData[config.steamDirectory][userAccount.accountID].apps[
              appID
            ].steamCategories = _.union(
              currentCategories,
              file.steamCategories,
            );
          }
        }
      }
    }
    if (ownedDuplicates > 0) {
      this.loggerService.info(
        this.lang.info.ownedDuplicates__i.interpolate({
          count: ownedDuplicates,
        }),
      );
    }
    if (ownedInOtherStore > 0) {
      this.loggerService.info(
        this.lang.info.ownedInOtherStores__i.interpolate({
          count: ownedInOtherStore,
        }),
      );
    }
    return { numberOfItems: numberOfItems, data: previewData };
  }
}
