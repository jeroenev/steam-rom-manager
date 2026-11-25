// A Store Account parser that has no games to give (signed out, or a
// library never fetched) is left out of the preview with a line in the log
// (the app's event log, and the command line's); the other parsers' games
// are listed all the same.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeFakeSteam, tempDir } from "../helpers/fixtures";
import {
  ALICE,
  BOB,
  buildPreview,
  parsedConfig,
  parsedFile,
} from "../helpers/parsed-configs";

describe("a Store Account parser that was skipped", () => {
  let root: string;
  let steamDir: string;

  beforeAll(() => {
    root = tempDir("skipped-parser");
    steamDir = makeFakeSteam(path.join(root, "steam"), [ALICE, BOB]);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const reason =
    "Not signed in to Ubisoft Connect. Sign in under **Account** in this parser's settings.";
  const configs = () => [
    parsedConfig(
      steamDir,
      "Store Account",
      "Ubisoft Connect (not installed)",
      [],
      [ALICE, BOB],
      { skipped: reason },
    ),
    parsedConfig(steamDir, "Glob", "glob", [
      parsedFile("C:\Emu\snes9x.exe", "Chrono Trigger", "", []),
    ]),
  ];

  it("the other parsers' games are listed, and the log says which parser was left out and why", async () => {
    const { result, logged } = await buildPreview(configs());
    expect(result.numberOfItems).toBeGreaterThan(0);
    expect(JSON.stringify(result.previewData)).toContain("Chrono Trigger");
    expect(
      logged.filter((line) => line.startsWith("Ubisoft Connect")),
    ).toEqual([
      `Ubisoft Connect (not installed): no games from this Store Account parser, the other parsers' games are listed. ${reason}`,
    ]);
  });

  it("says nothing of parsers that weren't skipped", async () => {
    const { logged } = await buildPreview([configs()[1]]);
    expect(logged.filter((line) => line.includes("no games from"))).toEqual([]);
  });

  it("only the skipped parser: nothing to list, and no error", async () => {
    const { result, logged } = await buildPreview([configs()[0]]);
    expect(result.numberOfItems).toBe(0);
    expect(logged.some((line) => line.includes("no games from"))).toBe(true);
  });
});
