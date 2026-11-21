// A Store Account shortcut (a game that isn't installed) with the same app id
// as another parser's shortcut (same program and title) is left out of the
// preview: the other parser's game wins, whichever parser runs first, and
// isn't put in "Not installed".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  PreviewBuilder,
  appIdOf,
  otherParsersAppIds,
} from "../../src/core/preview-builder";
import {
  ParsedUserConfiguration,
  ParsedUserConfigurationFile,
  ParserType,
  initArtworkRecord,
} from "../../src/models";
import { POWERSHELL_EXE } from "../../src/lib/helpers/launchers";
import { shortenAppId } from "../../src/lib/helpers/steam/generate-app-id";
import { makeFakeSteam, makeSettings, tempDir } from "../helpers/fixtures";

const ALICE = { accountID: "11111111", name: "alice", steamID64: "" };
const BOB = { accountID: "22222222", name: "bob", steamID64: "" };

function file(
  exe: string,
  title: string,
  args: string,
  categories: string[],
): ParsedUserConfigurationFile {
  return {
    executableLocation: exe,
    modifiedExecutableLocation: `"${exe}"`,
    startInDirectory: path.win32.dirname(exe),
    filePath: exe,
    titles: {
      extracted: title,
      fuzzy: title,
      final: title,
    } as unknown as ParsedUserConfigurationFile["titles"],
    sortAsTitle: "",
    argumentString: args,
    compatToolName: "",
    appendArgsToExecutable: false,
    onlineImageQueries: [title],
    steamCategories: categories,
    imagePool: title,
    defaultImage: initArtworkRecord(() => undefined as any),
    backupImage: initArtworkRecord(() => undefined as any),
    localImages: initArtworkRecord(() => [] as string[]),
    resolvedDefaultImages: initArtworkRecord(() => [] as string[]),
    resolvedLocalImages: initArtworkRecord(() => [] as string[]),
  };
}

describe("Store Account shortcuts another parser already adds", () => {
  let root: string;
  let steamDir: string;

  beforeAll(() => {
    root = tempDir("owned-duplicates");
    steamDir = makeFakeSteam(path.join(root, "steam"), [ALICE, BOB]);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  function config(
    parserType: ParserType,
    parserId: string,
    files: ParsedUserConfigurationFile[],
    accounts = [ALICE],
  ): ParsedUserConfiguration {
    return {
      configurationTitle: parserId,
      parserId,
      parserType,
      drmProtect: false,
      imageProviders: [],
      imageProviderAPIs: { sgdb: {}, steamCDN: {} } as any,
      controllers: {} as any,
      steamInputEnabled: "1" as any,
      steamDirectory: steamDir,
      shortcutPassthrough: false,
      overlayImages: initArtworkRecord(() => ""),
      foundUserAccounts: accounts,
      missingUserAccounts: [],
      files,
      failed: [],
      excluded: [],
    };
  }

  // The installed game, as the EA Desktop parser in launcher mode adds it.
  const eaDesktop = (accounts = [ALICE]) =>
    config(
      "EA Desktop",
      "ea-desktop",
      [
        file(
          POWERSHELL_EXE,
          "Battlefield 3",
          '-Command "&Start-Process \\"origin2://game/launch/?offerIds=70619\\""',
          ["EA"],
        ),
      ],
      accounts,
    );
  // The owned game whose offer id didn't match the installed copy's content
  // id: the same program and title.
  const owned = (accounts = [ALICE]) =>
    config(
      "Store Account",
      "owned-ea",
      [
        file(
          POWERSHELL_EXE,
          "Battlefield 3",
          '-Command "&Start-Process \\"origin2://game/launch/?offerIds=DR:225064100\\""',
          ["Not installed"],
        ),
        file(
          POWERSHELL_EXE,
          "Dead Space",
          '-Command "&Start-Process \\"origin2://game/launch/?offerIds=1028663\\""',
          ["Not installed"],
        ),
      ],
      accounts,
    );

  async function preview(configs: ParsedUserConfiguration[]) {
    const logged: string[] = [];
    const parsed = {
      parsedData: { parsedConfigs: configs, noUserAccounts: false },
      skipped: [] as string[],
      invalid: [] as string[],
      reparsed: configs.length,
    };
    const builder = new PreviewBuilder(
      { info: (message: any) => logged.push(String(message)) } as any,
      {
        executeFileParser: async () => parsed,
        executeFileParserReusing: async () => parsed,
        getAll: (): unknown[] => [],
      } as any,
      {
        get: () =>
          makeSettings({
            previewSettings: { retrieveCurrentSteamImages: false },
          }),
      } as any,
    );
    const result = await builder.build();
    const apps = (account: string) =>
      Object.values(result.previewData![steamDir][account].apps);
    return { result, apps, logged };
  }

  for (const order of ["installed first", "Store Account first"]) {
    it(`the other parser's shortcut stays as it is (${order})`, async () => {
      const configs =
        order === "installed first"
          ? [eaDesktop(), owned()]
          : [owned(), eaDesktop()];
      const { result, apps, logged } = await preview(configs);
      expect(result.numberOfItems).toBe(2);
      const battlefield = apps(ALICE.accountID).filter(
        (app) => app.title === "Battlefield 3",
      );
      expect(battlefield).toHaveLength(1);
      expect(battlefield[0]).toMatchObject({
        parserId: "ea-desktop",
        steamCategories: ["EA"],
        argumentString: expect.stringContaining("offerIds=70619"),
      });
      // The other owned game is still there.
      expect(
        apps(ALICE.accountID).find((app) => app.title === "Dead Space"),
      ).toMatchObject({ parserId: "owned-ea" });
      expect(logged.join("\n")).toContain("Left out 1 Store Account");
    });
  }

  it("also when the installed game is another store's, through the same program (Epic's PowerShell)", async () => {
    const epic = config("Epic", "epic", [
      file(
        POWERSHELL_EXE,
        "Dead Space",
        '-Command "&Start-Process \\"com.epicgames.launcher://apps/x%3Ay%3Az?action=launch&silent=true\\""',
        ["Epic"],
      ),
    ]);
    const { apps } = await preview([owned(), epic]);
    const deadSpace = apps(ALICE.accountID).filter(
      (app) => app.title === "Dead Space",
    );
    expect(deadSpace).toHaveLength(1);
    expect(deadSpace[0]).toMatchObject({
      parserId: "epic",
      steamCategories: ["Epic"],
    });
  });

  it("only for the Steam users that have the other parser's shortcut", async () => {
    const { apps } = await preview([owned([ALICE, BOB]), eaDesktop([ALICE])]);
    expect(
      apps(ALICE.accountID).find((app) => app.title === "Battlefield 3"),
    ).toMatchObject({ parserId: "ea-desktop" });
    expect(
      apps(BOB.accountID).find((app) => app.title === "Battlefield 3"),
    ).toMatchObject({
      parserId: "owned-ea",
      steamCategories: ["Not installed"],
    });
  });

  it("two Store Account parsers with one game: the first one's, as before", async () => {
    const other = config("Store Account", "owned-ea-2", [
      file(POWERSHELL_EXE, "Dead Space", "-Command other", ["Owned"]),
    ]);
    const { apps } = await preview([owned(), other]);
    const deadSpace = apps(ALICE.accountID).filter(
      (app) => app.title === "Dead Space",
    );
    expect(deadSpace).toHaveLength(1);
    expect(deadSpace[0].parserId).toBe("owned-ea");
    expect(otherParsersAppIds([owned(), other]).size).toBe(0);
  });

  it("an artwork-only parser's shortcut counts by the id it names", () => {
    const id = appIdOf(
      "Store Account",
      file(POWERSHELL_EXE, "Dead Space", "", []),
    );
    // (an artwork-only parser's "executable" is the shortcut's short id)
    const artworkOnly = config("Non-SRM Shortcuts", "artwork", [
      {
        ...file(POWERSHELL_EXE, "Anything", "", []),
        modifiedExecutableLocation: shortenAppId(id),
      },
    ]);
    const taken = otherParsersAppIds([artworkOnly]);
    expect([...taken.values()][0].has(id)).toBe(true);
  });
});
