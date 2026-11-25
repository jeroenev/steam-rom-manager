// Where the itch app keeps its games (butler's database), shared by the
// itch.io parser and the owned-games code.
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

export function defaultItchAppDataDir(
  osType: string = os.type(),
  home: string = os.homedir(),
  appData: string = process.env.APPDATA,
): string | undefined {
  switch (osType) {
    case "Windows_NT":
      return `${appData}\\itch`;
    case "Linux":
      return `${home}/.config/itch`;
    case "Darwin":
      return `${home}/Library/Application Support/itch`;
  }
  return undefined;
}

// Every place the itch app can keep its data: on Linux the Flatpak's
// (io.itch.itch, common on a Steam Deck) as well as the native app's.
export function itchAppDataDirs(
  osType: string = os.type(),
  home: string = os.homedir(),
  appData: string = process.env.APPDATA,
): string[] {
  const native = defaultItchAppDataDir(osType, home, appData);
  if (!native) {
    return [];
  }
  return osType == "Linux"
    ? [native, `${home}/.var/app/io.itch.itch/config/itch`]
    : [native];
}

// The itch app's folder: the native app's, or the Flatpak's when only that
// one has a database.
export function findItchAppDataDir(
  osType: string = os.type(),
  home: string = os.homedir(),
  appData: string = process.env.APPDATA,
): string | undefined {
  const dirs = itchAppDataDirs(osType, home, appData);
  return dirs.find((dir) => fs.existsSync(itchDbPath(dir))) ?? dirs[0];
}

export function itchDbPath(appDataDir: string) {
  return path.join(appDataDir, "/db/butler.db");
}
