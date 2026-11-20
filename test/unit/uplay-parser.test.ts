// UPlay (Ubisoft Connect), "Wait for the game to exit". The parser itself
// needs the registry and Ubisoft Connect's configuration cache; the wrapper
// its games get is tested here.
import { describe, expect, it } from "vitest";
import { parserScript } from "../../src/lib/launch-wrapper";
import {
  gameFolder,
  ubisoftWaitForExitWrapper,
} from "../../src/lib/launch-wrapper/launchers";

describe("UPlay: wait for the game to exit", () => {
  it("hands the launch to Ubisoft Connect through SRM's launch script, which watches the game's folder", () => {
    // (the registry's InstallDir, as Ubisoft Connect writes it)
    const folder = "D:\\UplayLibrary\\Far Cry 3";
    expect(
      ubisoftWaitForExitWrapper("46", "D:/UplayLibrary/Far Cry 3/"),
    ).toEqual({
      launch: { file: "uplay://launch/46/0" },
      // (by folder only: Far Cry 3's game is farcry3_d3d11.exe, not the
      // executable its configuration names)
      game: { folder, startTimeoutMinutes: 10 },
      preLaunch: [
        {
          script: parserScript("ubisoft-connect-start.ps1"),
          args: ["-GameFolder", folder],
        },
      ],
      postLaunch: [
        { script: parserScript("ubisoft-connect-start.ps1"), args: ["-Mark"] },
      ],
      postExit: [
        {
          script: parserScript("ubisoft-connect-stop.ps1"),
          args: ["-GameFolder", folder],
        },
      ],
    });
  });

  it("with the Steam overlay setting, an open Ubisoft Connect is closed before the launch", () => {
    const wrapper = ubisoftWaitForExitWrapper("420", "D:\\Games\\Far Cry 4\\", {
      steamOverlay: true,
    });
    expect(wrapper.preLaunch).toEqual([
      {
        script: parserScript("ubisoft-connect-start.ps1"),
        args: ["-GameFolder", "D:\\Games\\Far Cry 4", "-Restart"],
      },
    ]);
  });

  it("not for a game in a drive's root or without a folder: every program there would count as the game", () => {
    for (const dir of ["D:/", "D:\\", "D:", "", "games\\Far Cry 3"]) {
      expect(ubisoftWaitForExitWrapper("46", dir), dir).toBeUndefined();
    }
    expect(gameFolder("\\\\server\\share\\")).toBeUndefined();
    expect(gameFolder("\\\\server\\share\\Games\\X\\")).toBe(
      "\\\\server\\share\\Games\\X",
    );
  });
});
