// The EA Desktop parser's registry lookup, against this Windows machine's
// installed programs and the EA app's games. Read-only. Opt-in, since it
// needs a game the EA app installed:
//   SRM_LIVE_EA=1
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  queryInstallLocations,
  uninstallLists,
} from "../../src/lib/helpers/windows/installed-programs";

describe.runIf(os.type() === "Windows_NT" && !!process.env.SRM_LIVE_EA)(
  "Windows' installed-programs lists (EA app installed)",
  () => {
    it("reads each machine-wide list, and finds a game the EA app installed", async () => {
      const lists = await Promise.all(
        uninstallLists.map(({ key, flags }) =>
          queryInstallLocations(key, flags),
        ),
      );
      // (a typo in one list's key or flags would empty it; the user's own
      // list can be empty)
      uninstallLists.forEach(({ key }, i) => {
        if (key.startsWith("HKLM"))
          expect(lists[i].length, key).toBeGreaterThan(0);
      });
      expect(
        lists
          .flat()
          .some((l) =>
            fs.existsSync(path.join(l, "__Installer", "installerdata.xml")),
          ),
      ).toBe(true);
    }, 60000);
  },
);
