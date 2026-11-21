// Where GOG Galaxy and GOG's installers keep the installed games, shared by
// the GOG Galaxy parser and the owned-games code.
import * as os from "os";
import Registry from "winreg";

// Galaxy's database and program; undefined where there is no Galaxy.
export function galaxyPaths(
  osType: string = os.type(),
): { dbPath: string; exePath: string } | undefined {
  if (osType == "Windows_NT") {
    return {
      dbPath: "C:\\ProgramData\\GOG.com\\Galaxy\\storage\\galaxy-2.0.db",
      exePath: "C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe",
    };
  }
  if (osType == "Darwin") {
    return {
      dbPath: "/Users/Shared/GOG.com/Galaxy/Storage/galaxy-2.0.db",
      exePath: "/Applications/GOG Galaxy.app/Contents/MacOS/GOG Galaxy",
    };
  }
  return undefined;
}

// Every GOG game installed on Windows (through Galaxy or an offline
// installer) has a key here.
export const GOG_GAMES_REGISTRY_KEY = "\\SOFTWARE\\WOW6432Node\\GOG.com\\Games";

// The values of each game's key (gameID, gameName, launchCommand,
// workingDir, dependsOn for DLC, ...). Windows only.
export function readGogRegistryGames(): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const reg = new Registry({
      hive: Registry.HKLM,
      key: GOG_GAMES_REGISTRY_KEY,
    });
    reg.keys((err: Error, regkeys: Registry.Registry[]) => {
      if (err) {
        return reject(err);
      }
      Promise.all((regkeys || []).map(regKeyValues))
        .then(resolve)
        .catch(reject);
    });
  });
}

function regKeyValues(regkey: Registry.Registry) {
  return new Promise<Record<string, string>>((resolve, reject) => {
    regkey.values((err: Error, values: Registry.RegistryItem[]) => {
      if (err) {
        return reject(err);
      }
      resolve(
        Object.fromEntries(
          (values || [])
            .filter((entry) => entry.name && entry.value)
            .map((entry) => [entry.name, entry.value]),
        ),
      );
    });
  });
}
