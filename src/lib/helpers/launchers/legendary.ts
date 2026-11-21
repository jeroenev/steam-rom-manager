// Legendary's list of installed Epic games, shared by the Legendary parser
// and the owned-games code. (Heroic keeps its own copy: see heroic.ts.)
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";

export function defaultLegendaryInstalledFile(home: string = os.homedir()) {
  return path.join(home, ".config/legendary/installed.json");
}

// installed.json: { [app_name]: { app_name, title, install_path,
// executable, launch_parameters, is_dlc, ... } }
export function readLegendaryInstalled(file: string): {
  [appName: string]: any;
} {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}
