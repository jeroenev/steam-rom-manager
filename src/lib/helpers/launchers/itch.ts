// Where the itch app keeps its games (butler's database), shared by the
// itch.io parser and the owned-games code.
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

export function itchDbPath(appDataDir: string) {
  return path.join(appDataDir, "/db/butler.db");
}
