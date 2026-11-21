import {
  ParserInfo,
  GenericParser,
  ParsedData,
  ParsedSuccess,
} from "../../models";
import { APP } from "../../variables";
import * as _ from "lodash";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import { SqliteWrapper } from "../helpers/sqlite";
import { galaxyPaths, readGogRegistryGames } from "../helpers/launchers";

export class GOGParser implements GenericParser {
  private get lang() {
    return APP.lang.gogParser;
  }
  getParserInfo(): ParserInfo {
    return {
      title: "GOG Galaxy",
      info: this.lang.docs__md.self.join(""),
      inputs: {
        galaxyExeOverride: {
          label: this.lang.galaxyExeOverrideTitle,
          placeholder: this.lang.galaxyExeOverridePlaceholder[APP.osType],
          inputType: "path",
          info: this.lang.docs__md.input.join(""),
        },
        gogLauncherMode: {
          label: this.lang.launcherModeInputTitle,
          inputType: "toggle",
          info: this.lang.docs__md.input.join(""),
        },
        parseLinkedExecs: {
          label: this.lang.parseLinkedExecsTitle,
          inputType: "toggle",
          info: this.lang.docs__md.input.join(""),
        },
        parseRegistryEntries: {
          label: this.lang.parseRegistryEntries,
          inputType: "toggle",
          hidden: os.type() != "Windows_NT",
          info: this.lang.docs__md.input.join(""),
        },
      },
    };
  }

  // A game's registry values as a parsed game, a reason to skip it, or
  // null when they aren't a game's.
  private processRegEntry(
    transformed: Record<string, string>,
  ): { success: ParsedSuccess; failMessage: string } | null {
    if (
      transformed.gameName &&
      transformed.gameID &&
      transformed.launchCommand &&
      transformed.workingDir
    ) {
      if (transformed.dependsOn) {
        // ignore DLC
        return {
          success: null,
          failMessage: `Skipping DLC: ${transformed.gameName}`,
        };
      }
      if (!fs.existsSync(transformed.launchCommand)) {
        return {
          success: null,
          failMessage: `Skipping Missing Executable: ${transformed.gameName}`,
        };
      }
      return {
        success: {
          extractedTitle: transformed.gameName,
          extractedAppId: transformed.gameID,
          launchOptions: `/command=runGame /gameId=${transformed.gameID}`,
          filePath: transformed.launchCommand,
          fileLaunchOptions: transformed.launchParam,
          startInDirectory: transformed.workingDir,
        },
        failMessage: null,
      };
    }
    return null;
  }

  private async getRegInstalled(executableLocation: string) {
    const parsedArray = (await readGogRegistryGames()).map((values) =>
      this.processRegEntry(values),
    );
    let parsedData: ParsedData = {
      executableLocation: executableLocation,
      success: parsedArray
        .filter((x) => x && !x.failMessage)
        .map((x) => x.success),
      failed: parsedArray
        .filter((x) => x && x.failMessage)
        .map((x) => x.failMessage),
    };
    return parsedData;
  }

  execute(
    directories: string[],
    inputs: { [key: string]: any },
    cache?: { [key: string]: any },
  ) {
    return new Promise<ParsedData>(async (resolve, reject) => {
      const galaxy = galaxyPaths();
      if (!galaxy) {
        return reject(this.lang.errors.gogNotCompatible);
      }
      let { dbPath, exePath: galaxyExePath } = galaxy;
      if (inputs.galaxyExeOverride) {
        galaxyExePath = inputs.galaxyExeOverride;
      }
      if (inputs.parseRegistryEntries && os.type() == "Windows_NT") {
        this.getRegInstalled(galaxyExePath)
          .then((parsedData) => {
            parsedData.executableLocation = galaxyExePath;
            resolve(parsedData);
          })
          .catch((err) => {
            reject(this.lang.errors.fatalError__i.interpolate({ error: err }));
          });
      } else {
        if (!fs.existsSync(dbPath)) {
          return reject(this.lang.errors.gogNotInstalled);
        }
        try {
          const sqliteWrapper = new SqliteWrapper("gog-galaxy", dbPath, {
            externals: !!inputs.parseLinkedExecs,
          });
          const playtasks = (await sqliteWrapper.read()) as any[];
          let parsedData: ParsedData = { success: [], failed: [] };
          parsedData.executableLocation = galaxyExePath;
          for (let task of playtasks) {
            if (task.params.executablePath) {
              const productID = task.productId.toString();
              const flag = os.type() == "Windows_NT" ? "/" : "--";
              let fallbackTitle;
              if (os.type() == "Windows_NT") {
                fallbackTitle = path
                  .dirname(task.params.executablePath)
                  .split(path.sep)
                  .pop();
              } else {
                fallbackTitle = task.params.executablePath
                  .split(path.sep)
                  .pop()
                  .slice()
                  .replace(/\.[^.]*$/, "");
              }
              parsedData.success.push({
                extractedTitle: task.title || fallbackTitle,
                extractedAppId: productID,
                launchOptions: `${flag}command=runGame ${flag}gameId=${productID}`,
                filePath: task.params.executablePath,
                fileLaunchOptions: task.params.commandLineArgs,
              });
            }
          }
          resolve(parsedData);
        } catch (err) {
          reject(this.lang.errors.fatalError__i.interpolate({ error: err }));
        }
      }
    });
  }
}
