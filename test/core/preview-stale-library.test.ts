// A Store Account parser whose store's last refresh failed uses the games
// fetched before; the preview's log (the app's event log, and the command
// line's) says so once per store, and why, also when the parse cache
// reused the parser's result.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { PreviewBuilder } from "../../src/core/preview-builder";
import { galaxyPaths } from "../../src/lib/helpers/launchers";
import * as storage from "../../src/lib/stores/storage";
import { ownedGame } from "../../src/lib/stores/types";
import { makeFakeSteam, makeSettings, tempDir } from "../helpers/fixtures";
import {
  ALICE,
  BOB,
  buildPreview,
  parsedConfig,
  parsedFile,
} from "../helpers/parsed-configs";

const GALAXY_EXE = galaxyPaths("Windows_NT").exePath;
const FETCHED_AT = Date.UTC(2026, 10, 1, 12, 0, 0);

describe("a Store Account library used after a failed refresh", () => {
  let root: string;
  let steamDir: string;

  beforeAll(() => {
    root = tempDir("stale-library");
    steamDir = makeFakeSteam(path.join(root, "steam"), [ALICE, BOB]);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  afterEach(() => {
    storage.deleteAccount("gog");
    storage.saveFailure("gog", null);
  });

  // GOG's parser, for both Steam users, and a Glob parser.
  const configs = () => [
    parsedConfig(
      steamDir,
      "Store Account",
      "owned-gog",
      [parsedFile(GALAXY_EXE, "Frostpunk", "", ["Not installed"])],
      [ALICE, BOB],
      { store: "gog" },
    ),
    parsedConfig(steamDir, "Glob", "glob", [
      parsedFile("C:\\Emu\\snes9x.exe", "Chrono Trigger", "", []),
    ]),
  ];
  const cached = () =>
    storage.saveLibrary("gog", {
      accountName: "player",
      fetchedAt: FETCHED_AT,
      games: [ownedGame("gog", "1", "Frostpunk")],
      partial: false,
    });
  const date = new Date(FETCHED_AT).toLocaleString();

  it("says the games fetched before are used, and why the refresh failed", async () => {
    cached();
    storage.saveFailure("gog", {
      at: Date.now(),
      message: "GOG did not answer (503)",
      needsSignIn: false,
    });
    const { logged } = await buildPreview(configs());
    const lines = logged.filter((line) => line.startsWith("GOG:"));
    expect(lines).toEqual([
      `GOG: using the games fetched on ${date}; the last refresh failed: GOG did not answer (503)`,
    ]);
  });

  it("an expired sign-in asks to sign in again", async () => {
    cached();
    storage.saveFailure("gog", {
      at: Date.now(),
      message: "The store rejected the saved login",
      needsSignIn: true,
    });
    const { logged } = await buildPreview(configs());
    expect(logged.filter((line) => line.startsWith("GOG:"))).toEqual([
      `GOG: the saved sign-in no longer works, so the games fetched on ${date} are used. Sign in again in the Store Account parser's settings.`,
    ]);
  });

  it("says nothing when the last refresh worked, or nothing was fetched before", async () => {
    cached();
    expect(
      (await buildPreview(configs())).logged.filter((l) =>
        l.startsWith("GOG:"),
      ),
    ).toEqual([]);
    storage.deleteAccount("gog");
    storage.saveFailure("gog", {
      at: Date.now(),
      message: "down",
      needsSignIn: false,
    });
    expect(
      (await buildPreview(configs())).logged.filter((l) =>
        l.startsWith("GOG:"),
      ),
    ).toEqual([]);
  });

  it("also when the parse cache reused the parser's result", async () => {
    cached();
    storage.saveFailure("gog", {
      at: Date.now(),
      message: "down",
      needsSignIn: false,
    });
    const logged: string[] = [];
    const parsed = {
      parsedData: { parsedConfigs: configs(), noUserAccounts: false },
      skipped: [] as string[],
      invalid: [] as string[],
      reparsed: 0,
    };
    const builder = new PreviewBuilder(
      { info: (message: any) => logged.push(String(message)) } as any,
      {
        executeFileParser: async () => {
          throw new Error("not this one");
        },
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
    await builder.build({ reuse: true });
    expect(logged.filter((line) => line.startsWith("GOG:"))).toEqual([
      `GOG: using the games fetched on ${date}; the last refresh failed: down`,
    ]);
  });
});
