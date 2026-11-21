import * as path from "path";
import { ParserLaunchWrapper } from "../../models";
import { parserScript } from "./index";

// "Wait for the game to exit" for games that the EA app or Ubisoft Connect
// start (Windows, launching via the launcher). SRM's launch script opens the
// game's link, so the launcher starts inside the process tree Steam tracks
// when it was closed, and waits while a program from the game's folder runs:
// Steam shows the game as running while it runs, plus the time the parser's
// scripts take to close a launcher the launch started. Those note before the
// launch whether the launch starts the launcher, and close it after the game
// if so (an open launcher is left alone, and so is one that another game
// still needs). Based on BoilR's launch-and-wait
// (https://github.com/PhilipK/BoilR).

export interface LauncherWaitOptions {
  // Also close an open launcher before the game, so that the launch starts
  // it and the game gets Steam's overlay.
  steamOverlay?: boolean;
}

// A launcher may update the game or ask the user to sign in first.
const startTimeoutMinutes = 10;

// The game's folder as SRM's launch script and the scripts take it: a
// Windows path without a trailing backslash (which would escape the quote
// around a script argument). None for a drive's root, where every program on
// the drive would count as the game, or a relative path.
export function gameFolder(folder: string): string | undefined {
  if (!folder) return undefined;
  const normalized = path.win32.normalize(folder);
  if (!path.win32.isAbsolute(normalized)) return undefined;
  const trimmed = normalized.replace(/[\\/]+$/, "");
  const root = path.win32.parse(normalized).root.replace(/[\\/]+$/, "");
  return trimmed.length > root.length ? trimmed : undefined;
}

// An EA app game, by its content id (what origin2:// links take) and the
// folder that holds its __Installer folder. The EA app syncs cloud saves
// after the game; its log says when that's done.
export function eaWaitForExitWrapper(
  game: { contentId: string; folder: string; exeName?: string },
  { steamOverlay = false }: LauncherWaitOptions = {},
): ParserLaunchWrapper | undefined {
  const folder = gameFolder(game.folder);
  if (!folder) return undefined;
  const start = parserScript("ea-app-start.ps1");
  const which = [
    "-GameFolder",
    folder,
    ...(game.exeName ? ["-ExeName", game.exeName] : []),
  ];
  return {
    launch: { file: `origin2://game/launch/?offerIds=${game.contentId}` },
    game: {
      folder,
      ...(game.exeName ? { exeName: game.exeName } : {}),
      startTimeoutMinutes,
    },
    preLaunch: [
      {
        script: start,
        args: [...which, ...(steamOverlay ? ["-Restart"] : [])],
      },
    ],
    postLaunch: [{ script: start, args: ["-Mark"] }],
    postExit: [{ script: parserScript("ea-app-stop.ps1"), args: which }],
  };
}

// A Ubisoft Connect game, by its id and install folder (from the registry,
// which may use forward slashes). The game's process can differ from the
// executable its configuration names (Far Cry 3 runs farcry3_d3d11.exe), so
// the game is found by its folder only. A game's first program may hand the
// game's start to Ubisoft Connect and exit (Far Cry 3's starts
// UbisoftGameLauncher.exe, which stays while Ubisoft Connect updates the
// game or stalls): the game hasn't started then.
export function ubisoftWaitForExitWrapper(
  gameId: string,
  installDir: string,
  { steamOverlay = false }: LauncherWaitOptions = {},
): ParserLaunchWrapper | undefined {
  const folder = gameFolder(installDir);
  if (!folder) return undefined;
  const start = parserScript("ubisoft-connect-start.ps1");
  return {
    launch: { file: `uplay://launch/${gameId}/0` },
    game: { folder, startTimeoutMinutes, handOff: ["UbisoftGameLauncher"] },
    preLaunch: [
      {
        script: start,
        args: ["-GameFolder", folder, ...(steamOverlay ? ["-Restart"] : [])],
      },
    ],
    postLaunch: [{ script: start, args: ["-Mark"] }],
    postExit: [
      {
        script: parserScript("ubisoft-connect-stop.ps1"),
        args: ["-GameFolder", folder],
      },
    ],
  };
}
