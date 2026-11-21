import { ParserInfo, GenericParser, ParsedData } from "../../models";
import { APP } from "../../variables";
import * as fs from "fs-extra";
import * as os from "os";
import {
  configurationsFile,
  parseConfigurations,
  ubisoftGameNames,
  ubisoftGames,
  ubisoftInstalls,
} from "./uplay/installed-games";

export class UPlayParser implements GenericParser {
  private get lang() {
    return APP.lang.uplayParser;
  }
  getParserInfo(): ParserInfo {
    return {
      title: "UPlay",
      info: this.lang.docs__md.self.join(""),
      inputs: {
        uplayDir: {
          label: this.lang.uplayDirTitle,
          placeholder: this.lang.uplayDirPlaceholder[APP.osType],
          inputType: "dir",
          info: this.lang.docs__md.input.join(""),
        },
        uplayLauncherMode: {
          label: this.lang.launcherModeInputTitle,
          inputType: "toggle",
          info: this.lang.docs__md.input.join(""),
        },
        uplayWaitForExit: {
          label: this.lang.waitForExitInputTitle,
          inputType: "toggle",
          hidden: os.type() != "Windows_NT",
          info: this.lang.docs__md.input.join(""),
        },
        uplaySteamOverlay: {
          label: this.lang.steamOverlayInputTitle,
          inputType: "toggle",
          hidden: os.type() != "Windows_NT",
          info: this.lang.docs__md.input.join(""),
        },
      },
    };
  }

  execute(
    directories: string[],
    inputs: { [key: string]: any },
    cache?: { [key: string]: any },
  ) {
    return new Promise<ParsedData>(async (resolve, reject) => {
      if (os.type() !== "Windows_NT") {
        return reject(this.lang.errors.uplayNotCompatible);
        //TODO Mac Handling
      }
      try {
        const launcherMode = !!inputs.uplayLauncherMode;
        // Exe mode needs Ubisoft Connect's configuration cache (for the
        // games' exes); launcher mode lists the games Ubisoft Connect
        // installed, and takes only titles from the cache.
        const configPath = configurationsFile(
          inputs.uplayDir || "C:\\Program Files (x86)\\Ubisoft",
        );
        if (!configPath && !launcherMode) {
          return reject(this.lang.errors.uplayNotInstalled);
        }
        const installs = await ubisoftInstalls();
        if (!configPath && !installs.length) {
          return reject(this.lang.errors.uplayNotInstalled);
        }
        const success = ubisoftGames({
          installs,
          configurations: configPath
            ? parseConfigurations(fs.readFileSync(configPath))
            : [],
          names: launcherMode ? await ubisoftGameNames() : {},
          launcherMode,
          // ("Wait for the game to exit" only works when launching via
          // Ubisoft Connect)
          waitForExit: !!inputs.uplayWaitForExit,
          steamOverlay: !!inputs.uplaySteamOverlay,
        });
        resolve({
          executableLocation: `C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
          success,
          failed: [],
        });
      } catch (err) {
        reject(this.lang.errors.fatalError__i.interpolate({ error: err }));
      }
    });
  }
}
