// A Store Account game's id at its store (where SteamGridDB knows games by
// it) goes with its artwork pool to the artwork providers, which look the
// game up by it before they search its title. Other parsers' pools have
// none; a search the user sets replaces it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { Subject } from "rxjs";
import { PreviewEngine } from "../../src/core/preview-engine";
import { emptyPools, keepRetrievedPools } from "../../src/core/image-pools";
import { BuildResult } from "../../src/core/preview-builder";
import { ParsedUserConfigurationFile, SgdbPlatformId } from "../../src/models";
import { POWERSHELL_EXE } from "../../src/lib/helpers/launchers";
import { makeFakeSteam, makeSettings, tempDir } from "../helpers/fixtures";
import {
  ALICE,
  buildPreview,
  parsedConfig,
  parsedFile,
} from "../helpers/parsed-configs";

const EPIC_EXE =
  "C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe";
const providers = ["sgdb", "steamCDN"] as any;

const sugar: SgdbPlatformId = { platform: "egs", id: "Sugar" };
const calluna: SgdbPlatformId = { platform: "egs", id: "Calluna" };

// A Store Account game (not installed), with its id at Epic.
const ownedGame = (title: string, id: SgdbPlatformId) => ({
  ...parsedFile(POWERSHELL_EXE, title, `launch ${title}`, ["Not installed"]),
  sgdbPlatformId: id,
});
// An installed game of the Epic parser.
const installedGame = (title: string): ParsedUserConfigurationFile =>
  parsedFile(EPIC_EXE, title, "", []);

describe("a Store Account game's store id, for its artwork", () => {
  let root: string;
  let steamDir: string;

  beforeAll(() => {
    root = tempDir("store-artwork");
    steamDir = makeFakeSteam(path.join(root, "steam"), [ALICE]);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  // Control is installed (the Epic parser's) and also listed by the Store
  // Account parser, under another program: both are in the list, in one
  // pool (its title).
  const build = () =>
    buildPreview(
      [
        parsedConfig(
          steamDir,
          "Epic",
          "epic",
          [installedGame("Fortnite"), installedGame("Control")],
          [ALICE],
          { imageProviders: providers },
        ),
        parsedConfig(
          steamDir,
          "Store Account",
          "owned-epic",
          [ownedGame("Rocket League", sugar), ownedGame("Control", calluna)],
          [ALICE],
          { imageProviders: providers, store: "epic" },
        ),
      ],
      makeSettings({
        previewSettings: { retrieveCurrentSteamImages: false },
      }),
    );

  it("goes with the game's pool, for both providers; other parsers' pools have none", async () => {
    const { result } = await build();
    const ids = (pool: string) =>
      Object.fromEntries(
        Object.entries(result.onlineImages.tall[pool].online).map(
          ([provider, online]) => [provider, online.platformIds],
        ),
      );
    expect(ids("Rocket League")).toEqual({
      sgdb: [sugar],
      steamCDN: [sugar],
    });
    expect(ids("Fortnite")).toEqual({ sgdb: [], steamCDN: [] });
    // (a pool another parser's game shares: the Store Account game's id too)
    expect(ids("Control")).toEqual({ sgdb: [calluna], steamCDN: [calluna] });
  });

  it("reaches the artwork providers with the pool's searches; a search the user sets replaces it", async () => {
    const { result } = await build();
    const calls: { title: string; provider: string; ids: SgdbPlatformId[] }[] =
      [];
    const engine = new PreviewEngine({
      logger: { info: () => {}, error: () => {}, success: () => {} } as any,
      parsers: {} as any,
      providers: {
        stopEvent: new Subject<void>(),
        stopUrlDownload: () => {},
        retrieveUrls: (
          title: string,
          _type: string,
          _apis: unknown,
          provider: string,
          callback: (event: string, data: any) => void,
          platformIds: SgdbPlatformId[],
        ) => {
          calls.push({ title, provider, ids: platformIds });
          setImmediate(() => callback("completed", { title }));
        },
      } as any,
      settings: {
        get: () =>
          makeSettings({ enabledProviders: ["sgdb", "steamCDN"] }) as any,
      },
      builder: { build: async (): Promise<BuildResult> => result },
      writer: {} as any,
    });
    await engine.generatePreviewData();
    await engine.waitForImages();
    const idsOf = (title: string) =>
      calls.filter((c) => c.title === title).map((c) => c.ids);
    // (every artwork type, both providers)
    expect(idsOf("Rocket League").length).toBeGreaterThanOrEqual(2);
    expect(
      new Set(idsOf("Rocket League").map((x) => JSON.stringify(x))),
    ).toEqual(new Set([JSON.stringify([sugar])]));
    expect(idsOf("Fortnite").every((ids) => ids.length === 0)).toBe(true);

    // Add Games' details: a search title for Rocket League.
    calls.length = 0;
    engine.updateAppImages(
      "Rocket League Collector's",
      "Rocket League",
      "tall",
    );
    engine.downloadImageUrls("tall", ["Rocket League Collector's"]);
    await engine.waitForImages();
    expect(calls).toEqual([
      { title: "Rocket League Collector's", provider: "sgdb", ids: [] },
      { title: "Rocket League Collector's", provider: "steamCDN", ids: [] },
    ]);
  });

  it("a refresh looks a pool up again when its store ids changed", () => {
    const pool = (platformIds: SgdbPlatformId[], retrieved: boolean) => ({
      retrieving: false,
      retrieved,
      parserEnabledProviders: ["sgdb"] as any,
      online: {
        sgdb: {
          searchQueries: ["Rocket League"],
          platformIds,
          imageProviderAPIs: {} as any,
          content: [] as any[],
        },
        steamCDN: {
          searchQueries: ["Rocket League"],
          platformIds,
          imageProviderAPIs: {} as any,
          content: [] as any[],
        },
      },
      offline: { local: [], manual: [], imported: [] } as any,
    });
    const previous = emptyPools();
    previous.tall["Rocket League"] = pool([], true);
    previous.tall["Kept"] = pool([sugar], true);
    const pools = emptyPools();
    pools.tall["Rocket League"] = pool([sugar], false);
    pools.tall["Kept"] = pool([sugar], false);
    expect(keepRetrievedPools(previous, pools).tall).toEqual(["Rocket League"]);
  });
});
