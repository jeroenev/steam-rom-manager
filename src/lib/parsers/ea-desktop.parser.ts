import { ParserInfo, GenericParser, ParsedData } from "../../models";
import { APP } from "../../variables";
import * as os from "os";
import { installLocations } from "../helpers/windows/installed-programs";
import {
  gameFolders,
  installedGames,
  powershellPath,
} from "./ea-desktop/installed-games";

export class EADesktopParser implements GenericParser {
  private get lang() {
    return APP.lang.eaDesktopParser;
  }

  getParserInfo(): ParserInfo {
    return {
      title: "EA Desktop",
      info: this.lang.docs__md.self.join(""),
      inputs: {
        eaGamesDir: {
          label: this.lang.eaGamesDirTitle,
          placeholder: this.lang.eaGamesDirPlaceholder[APP.osType],
          inputType: "dir",
          info: this.lang.docs__md.input.join(""),
        },
        eaLauncherMode: {
          label: this.lang.eaLauncherModeTitle,
          inputType: "toggle",
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
        return reject(this.lang.errors.eaNotCompatible);
      }
      try {
        // Games in the folder field (or EA's default folders) and wherever
        // Windows' installed programs say the EA app installed one.
        const folders = await gameFolders({
          gamesDir: inputs.eaGamesDir,
          installLocations: await installLocations(),
        });
        const { success, failed } = await installedGames(
          folders,
          !!inputs.eaLauncherMode,
        );
        resolve({
          executableLocation: powershellPath(process.env.SystemRoot),
          success,
          failed,
        });
      } catch (err) {
        reject(this.lang.errors.fatalError__i.interpolate({ error: err }));
      }
    });
  }
}
