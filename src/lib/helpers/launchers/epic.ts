// Where the Epic Games Launcher keeps its installed games, shared by the
// Epic parser and the owned-games code.
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { glob } from "glob";

// The launcher's install manifests; undefined where Epic has no launcher.
export function defaultEpicManifestsDir(
  osType: string = os.type(),
  home: string = os.homedir(),
): string | undefined {
  if (osType == "Windows_NT") {
    return "C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests";
  }
  if (osType == "Darwin") {
    return path.join(
      home,
      "/Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests",
    );
  }
  return undefined;
}

// One manifest (*.item) per installed game.
export function epicManifestFiles(dir: string): Promise<string[]> {
  return glob([dir.replace(/\\/g, "/"), "*.item"].join("/"));
}

// A manifest: AppName, DisplayName, InstallLocation, LaunchExecutable, ...
export function readEpicManifest(file: string): any {
  return JSON.parse(fs.readFileSync(file).toString());
}

// The link that has the launcher start an installed game.
export function epicLaunchLink(appName: string) {
  return `com.epicgames.launcher://apps/${appName}?action=launch&silent=true`;
}
