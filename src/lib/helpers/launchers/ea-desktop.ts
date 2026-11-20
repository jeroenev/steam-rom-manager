// Where the EA app's games are found, for the owned-games code (the EA
// Desktop parser's first default folder).
import { glob } from "glob";

export const DEFAULT_EA_GAMES_DIR = "C:\\Program Files (x86)\\EA Games";

// Each installed game's __Installer/installerdata.xml, one folder down.
export function eaInstallerDataFiles(
  eaGamesDir: string = DEFAULT_EA_GAMES_DIR,
) {
  return glob("*/__Installer/installerdata.xml", {
    dot: true,
    cwd: eaGamesDir,
    absolute: true,
  });
}
