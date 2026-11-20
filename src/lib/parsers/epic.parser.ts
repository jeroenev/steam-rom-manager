import {
  ParserInfo,
  GenericParser,
  ParsedData,
  ParserLaunchWrapper,
} from "../../models";
import { parserScript } from "../launch-wrapper";
import { APP } from "../../variables";
import * as _ from "lodash";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  POWERSHELL_EXE,
  defaultEpicManifestsDir,
  epicLaunchLink,
  epicManifestFiles,
  powershellOpen,
  readEpicManifest,
} from "../helpers/launchers";

export class EpicParser implements GenericParser {
  private get lang() {
    return APP.lang.epicParser;
  }
  getParserInfo(): ParserInfo {
    return {
      title: "Epic",
      info: this.lang.docs__md.self.join(""),
      inputs: {
        epicManifests: {
          label: this.lang.manifestsInputTitle,
          placeholder: this.lang.manifestsInputPlaceholder[APP.osType],
          inputType: "dir",
          info: this.lang.docs__md.input.join(""),
        },
        epicLauncherMode: {
          label: this.lang.launcherModeInputTitle,
          inputType: "toggle",
          info: this.lang.docs__md.input.join(""),
        },
        epicWaitForExit: {
          label: this.lang.waitForExitInputTitle,
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
      let appTitles: string[] = [];
      let epicManifestsDir: string = "";
      if (inputs.epicManifests) {
        epicManifestsDir = inputs.epicManifests;
      } else {
        if (os.type() == "Linux") {
          return reject(this.lang.errors.epicNotCompatible);
        }
        epicManifestsDir = defaultEpicManifestsDir() || "";
      }
      if (!fs.existsSync(epicManifestsDir)) {
        return reject(this.lang.errors.epicNotInstalled);
      }
      const waitForExit =
        !!inputs.epicLauncherMode &&
        !!inputs.epicWaitForExit &&
        os.type() == "Windows_NT";
      try {
        let parsedData: ParsedData = {
          executableLocation: POWERSHELL_EXE,
          success: [],
          failed: [],
        };
        const files: string[] = await epicManifestFiles(epicManifestsDir);
        for (let file of files) {
          if (fs.existsSync(file) && fs.lstatSync(file).isFile()) {
            let item = readEpicManifest(file);
            let launchPath = path.join(
              item.InstallLocation,
              item.LaunchExecutable,
            );
            if (
              item.LaunchExecutable &&
              fs.existsSync(launchPath) &&
              !appTitles.includes(item.DisplayName)
            ) {
              appTitles.push(item.DisplayName);
              parsedData.success.push({
                extractedTitle: item.DisplayName,
                extractedAppId: item.AppName,
                launchOptions: powershellOpen(epicLaunchLink(item.AppName)),
                filePath: launchPath,
                fileLaunchOptions: item.LaunchCommand,
                ...(waitForExit && {
                  launchWrapper: waitForExitWrapper(item),
                }),
              });
            }
          }
        }
        resolve(parsedData);
      } catch (err) {
        reject(this.lang.errors.fatalError__i.interpolate({ error: err }));
      }
    });
  }
}

// "Wait for the game to exit" (Windows, launching via Epic): SRM's launch
// script restarts Epic (so Epic and the game are in the process tree Steam
// tracks), has it launch the game, and waits for the game (any process in
// its install folder) to exit; then Epic syncs cloud saves and is closed.
// From https://github.com/SteamGridDB/steam-rom-manager/pull/904 (hbogaeus).
function waitForExitWrapper(item: any): ParserLaunchWrapper {
  const cloudSync = parserScript("epic-cloud-sync.ps1");
  const stopEpic = { script: parserScript("epic-stop.ps1") };
  return {
    launch: {
      file: epicLaunchLink(item.AppName),
    },
    game: {
      folder: path.win32.normalize(item.InstallLocation),
      exeName: path.win32.basename(item.LaunchExecutable),
    },
    preLaunch: [stopEpic],
    postLaunch: [
      { script: cloudSync, args: ["-appName", item.AppName, "-Mark"] },
    ],
    postExit: [
      { script: cloudSync, args: ["-appName", item.AppName] },
      stopEpic,
    ],
  };
}
