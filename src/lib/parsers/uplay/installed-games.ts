// The UPlay parser's work, apart from its Windows check, so that it can be
// tested anywhere. (Not in uplay.parser.ts: every export of a parser file
// must be a parser, see parsers/index.ts.)
import { ParsedSuccess } from "../../../models";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import {
  installedProgramValues,
  queryRegistryValues,
} from "../../helpers/windows/installed-programs";
import { inSteamLibrary } from "../../helpers/steam/in-steam-library";
import { ubisoftWaitForExitWrapper } from "../../launch-wrapper/launchers";

// A game Ubisoft Connect installed: its id (what uplay:// links take) and
// its folder, as the registry has it (often with forward slashes and a
// trailing slash).
export interface UbisoftInstall {
  id: string;
  installDir: string;
}

// The games Ubisoft Connect installed: its Installs\<id> keys and their
// InstallDir, in the registry's 32-bit view (WOW6432Node), where Ubisoft
// Connect writes. None when it can't be read; never rejects.
export async function ubisoftInstalls(): Promise<UbisoftInstall[]> {
  const values = await queryRegistryValues(
    "HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs",
    "InstallDir",
    ["/reg:32"],
  );
  return values
    .map(({ key, data }) => ({
      id: path.win32.basename(key),
      installDir: data,
    }))
    .filter(({ id, installDir }) => /^\d+$/.test(id) && installDir);
}

// The names Windows' installed-programs lists give Ubisoft Connect's games
// (their "Uplay Install <id>" entries), by id. Ubisoft Connect writes them
// from the game's configuration (installer.game_identifier) when it installs
// the game. Never rejects.
export async function ubisoftGameNames(): Promise<{ [id: string]: string }> {
  const names: { [id: string]: string } = {};
  for (const { key, data } of await installedProgramValues("DisplayName")) {
    const id = path.win32.basename(key).match(/^Uplay Install (\d+)$/i);
    if (id && data && !(id[1] in names)) names[id[1]] = data;
  }
  return names;
}

// Ubisoft Connect's configuration cache: the directory override's (by
// default C:\Program Files (x86)\Ubisoft) or the user's. Current versions of
// Ubisoft Connect only write an encrypted configurations.vdat next to it, so
// this file may be old or missing.
export function configurationsFile(
  ubisoftDir: string,
  localAppData = process.env.LOCALAPPDATA ||
    path.join(os.homedir(), "AppData", "Local"),
): string | undefined {
  const candidates = [
    path.join(localAppData, "Ubisoft Game Launcher"),
    path.join(ubisoftDir, "Ubisoft Game Launcher"),
  ].map((dir) => path.join(dir, "cache", "configuration", "configurations"));
  return candidates.find((file) => fs.existsSync(file));
}

// A game's configuration in that cache (one with start_game).
export interface CachedConfiguration {
  // (none when its id couldn't be read)
  launcherId?: number;
  // installer.game_identifier
  title?: string;
  // The first executable, relative to the game's folder, when the
  // configuration names it that way (others are in the registry).
  relativeExe?: string;
  // A game of another store (e.g. bought on Steam).
  thirdPartyPlatform: boolean;
}

// The configurations in the cache file: records of a game's id and its YAML
// configuration.
export function parseConfigurations(file: Buffer): CachedConfiguration[] {
  const finalOutput: any[] = [];
  let game: string[] = ["root:"];
  let launcherId: number = null;
  let end = false;
  const addGame = () => {
    try {
      let gameParsed: any = yaml.load(game.join("\n"), {
        json: true,
      });
      if (launcherId) {
        gameParsed.root.launcher_id = launcherId;
      }
      finalOutput.push(gameParsed);
    } catch (e) {}
  };

  generateHexArray(file.toString("hex")).forEach((hexStr: string) => {
    const line = Buffer.from(hexStr, "hex").toString("utf8").replace(/\n/g, "");
    const foundId = hexStr.match(/08([0-9a-f]+)10[0-9a-f]+1a/);
    if (foundId) {
      if (game.length === 1) {
        let hexChars = foundId[1].match(/.{1,2}/g);
        let ints = hexChars.map((x) => parseInt(x, 16));
        launcherId = convertLaunchId(ints);
        return;
      }
      if (game.length > 1) {
        addGame();
        let hexChars = foundId[1].match(/.{1,2}/g);
        let ints = hexChars.map((x) => parseInt(x, 16));
        launcherId = convertLaunchId(ints);
        game = ["root:"];
        return;
      }
    }
    if (line.indexOf("localizations:") === 0) {
      end = true;
      return;
    }
    // Already manually saved "root:"
    if (line.trim().includes("root:") && !line.trim().includes("_")) {
      end = false;
      return;
    }
    if (!end) {
      // Save lines if starts with spaces
      if (line.substr(0, 2) === "  " && !line.includes("sort_string:")) {
        game.push(line);
      }
    }
  });
  // (the file's last configuration: no record follows it)
  if (game.length > 1) addGame();
  return finalOutput
    .filter((x) => x && x.root && x.root.start_game)
    .map(({ root }) => {
      const startGame = root.start_game.offline || root.start_game.online;
      const executable = ((startGame && startGame.executables) || [])[0];
      const relativeExe =
        executable && executable.path && executable.path.relative;
      const title = root.installer && root.installer.game_identifier;
      return {
        launcherId: root.launcher_id || undefined,
        title: title ? title.toString() : undefined,
        relativeExe: relativeExe ? String(relativeExe) : undefined,
        thirdPartyPlatform: !!root.third_party_platform,
      };
    });
}

function generateHexArray(str: string) {
  const lines = [];
  const split = str.match(/.{1,2}/g) || [];
  let line = "";
  for (let i = 0; i < split.length; i++) {
    line += split[i];
    if (split[i] === "0a" && split[i - 2] !== "08") {
      lines.push(line);
      line = "";
    }
  }
  return lines;
}

function convertLaunchId(hexArr: number[]) {
  let launchId = 0;
  let multiplier = 1;
  for (let i = 0; i < hexArr.length; i++, multiplier *= 256) {
    if (hexArr[i] === 16) {
      break;
    }
    launchId += hexArr[i] * multiplier;
  }

  if (launchId > 256 * 256) {
    launchId -= 128 * 256 * Math.ceil(launchId / (256 * 256));
    launchId -= 128 * Math.ceil(launchId / 256);
  } else if (launchId > 256) {
    launchId -= 128 * Math.ceil(launchId / 256);
  }
  return launchId;
}

// The games to list:
// - In exe mode, those whose configuration in the cache names their exe
//   relative to their folder (and that Ubisoft Connect lists as installed).
// - In launcher mode (uplay:// links only need the game's id), the games
//   exe mode lists, plus every game Ubisoft Connect installed itself: those
//   in its Installs key that also have a "Uplay Install <id>" entry in
//   Windows' installed-programs lists (`names`), as BoilR lists them. Not
//   those whose folder is gone, in a Steam library, or that the cache knows
//   only as another store's. A game keeps the title and exe it gets in exe
//   mode (and so its app id); others are named by the cache, else by that
//   entry, and their exe is their folder.
// With `waitForExit` (launcher mode, Windows), a game's shortcut runs SRM's
// launch script, which waits for the game (see ubisoftWaitForExitWrapper).
export function ubisoftGames({
  installs,
  configurations,
  names = {},
  launcherMode,
  waitForExit = false,
  steamOverlay = false,
  exists = fs.existsSync,
}: {
  installs: UbisoftInstall[];
  configurations: CachedConfiguration[];
  names?: { [id: string]: string };
  launcherMode: boolean;
  waitForExit?: boolean;
  steamOverlay?: boolean;
  exists?: (folder: string) => boolean;
}): ParsedSuccess[] {
  const games: ParsedSuccess[] = [];
  const add = (id: string, title: string, filePath: string, dir: string) => {
    const launchWrapper =
      launcherMode && waitForExit
        ? ubisoftWaitForExitWrapper(id, dir, { steamOverlay })
        : undefined;
    games.push({
      extractedTitle: title,
      extractedAppId: id,
      launchOptions: `-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"uplay://launch/${id}\\""`,
      filePath,
      //fileLaunchOptions: not available
      ...(launchWrapper && { launchWrapper }),
    });
  };
  const own = configurations.filter((config) => !config.thirdPartyPlatform);
  // (the exe SRM has always given a game: its first executable, by the
  // cache's first configuration with the game's id that names one)
  const withExe = own.filter(
    (config) => config.launcherId && config.title && config.relativeExe,
  );

  if (!launcherMode) {
    const installDirs: { [id: string]: string } = {};
    for (const { id, installDir } of installs) installDirs[id] = installDir;
    for (const config of withExe) {
      const installDir = installDirs[String(config.launcherId)];
      if (installDir) {
        add(
          String(config.launcherId),
          config.title,
          path.win32.join(installDir, config.relativeExe),
          installDir,
        );
      }
    }
    return games;
  }

  for (const { id, installDir } of installs) {
    if (!exists(installDir) || inSteamLibrary(installDir)) continue;
    const ofGame = (config: CachedConfiguration) =>
      String(config.launcherId) === id;
    // (the cache knows it only as another store's game: that store lists it)
    if (configurations.some(ofGame) && !own.some(ofGame)) {
      continue;
    }
    const folder = path.win32.resolve(installDir);
    const listed = withExe.find(ofGame);
    if (listed) {
      add(
        id,
        listed.title,
        path.win32.join(installDir, listed.relativeExe),
        installDir,
      );
      continue;
    }
    // (only a game Ubisoft Connect installed itself, which gets a "Uplay
    // Install <id>" entry: one it only registered for another store (an
    // Epic install, say) has none, and that store lists it. A configuration
    // in the cache doesn't tell: the cache has every game the account has
    // seen, wherever it was bought.)
    if (!names[id]) continue;
    const named = own.find((config) => ofGame(config) && config.title);
    add(id, (named && named.title) || names[id], folder, installDir);
  }
  return games;
}
