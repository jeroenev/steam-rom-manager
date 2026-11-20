// Where the Amazon Games app is and keeps its games, shared by the Amazon
// Games parser and the owned-games code. (Windows only: the paths are
// Windows paths wherever this runs.)
import * as path from "path";

export function defaultAmazonGamesExe(appData: string = process.env.APPDATA) {
  return path.win32.resolve(
    `${appData}\\..\\local\\Amazon Games\\App\\Amazon Games.exe`,
  );
}

// Its database of games (DbSet: Id, ProductTitle, InstallDirectory,
// Installed).
export function amazonGamesDb(amazonGamesExe: string) {
  return path.win32.resolve(
    `${path.win32.dirname(amazonGamesExe)}\\..\\Data\\Games\\Sql\\GameInstallInfo.sqlite`,
  );
}
