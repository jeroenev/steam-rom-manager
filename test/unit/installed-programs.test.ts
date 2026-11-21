// Windows' installed-programs lists, read with the real reg.exe (on Windows
// only, so CI's Windows run covers it). The EA Desktop tests feed reg.exe's
// output in, or mock these: a broken query would only show there as an
// empty list.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  installLocations,
  queryInstallLocations,
} from "../../src/lib/helpers/windows/installed-programs";

describe.runIf(os.type() === "Windows_NT")(
  "Windows' installed-programs lists (real reg.exe)",
  () => {
    it("reads the folders installed programs are in", async () => {
      const locations = await installLocations();
      expect(locations.length).toBeGreaterThan(0);
      // (not every value is an absolute path, or a folder that exists)
      expect(
        locations.some((l) => path.win32.isAbsolute(l) && fs.existsSync(l)),
      ).toBe(true);
    }, 60000);

    // A scratch key of the user's, removed afterwards.
    const reg = path.win32.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "reg.exe",
    );
    const key = `HKCU\\Software\\steam-rom-manager-test-${process.pid}`;
    afterAll(() => {
      try {
        execFileSync(reg, ["delete", key, "/f"], { stdio: "ignore" });
      } catch (e) {
        // (never created)
      }
    });

    it("keeps any character of a folder's name (was: non-ASCII ones lost to the console's code page)", async () => {
      const folder = "D:\\Jeux vidéo\\Игры\\Alice™ 日本";
      execFileSync(
        reg,
        [
          "add",
          `${key}\\Game`,
          "/v",
          "InstallLocation",
          "/t",
          "REG_SZ",
          "/d",
          folder,
          "/f",
        ],
        { stdio: "ignore" },
      );
      expect(await queryInstallLocations(key, [])).toEqual([folder]);
      // (a key that isn't there: reg.exe fails, and adds nothing)
      expect(await queryInstallLocations(`${key}-missing`, [])).toEqual([]);
    }, 60000);
  },
);
