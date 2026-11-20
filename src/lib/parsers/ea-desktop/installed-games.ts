// The EA Desktop parser's work, apart from its Windows check, so that it can
// be tested anywhere. (Not in ea-desktop.parser.ts: every export of a parser
// file must be a parser, see parsers/index.ts.)
import { ParsedSuccess } from "../../../models";
import * as fs from "fs-extra";
import * as path from "path";
import { glob } from "glob";
import * as json from "../../helpers/json";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import languageEncoding from "detect-file-encoding-and-language";
import { eaWaitForExitWrapper } from "../../launch-wrapper/launchers";

// Where the EA app installs games unless told otherwise. Searched when the
// parser's folder field is empty; the older default first, so games SRM
// found there before stay first.
export const defaultGamesDirs = [
  "C:\\Program Files (x86)\\EA Games",
  "C:\\Program Files\\EA Games",
];

// Shortcuts in launcher mode start PowerShell. A shortcut's app id comes
// from its exe's path (and title), so wherever Windows is in C:\WINDOWS (in
// any case) the path stays the one SRM always wrote.
export function powershellPath(systemRoot: string | undefined): string {
  const root = (systemRoot || "").replace(/[\\/]+$/, "");
  const windows =
    root && root.toLowerCase() !== "c:\\windows" ? root : "C:\\WINDOWS";
  return path.win32.join(
    windows,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

// The folders that hold an EA app install (a __Installer\installerdata.xml):
// - the games in `gamesDir` (the parser's folder field), or when that is
//   empty in whichever of `defaultDirs` exist;
// - every folder Windows lists installed programs in (`installLocations`)
//   that holds installer data, except those in a Steam library.
// Each folder once (case-insensitively, as Windows compares them), in that
// order.
export async function gameFolders({
  gamesDir,
  installLocations,
  defaultDirs = defaultGamesDirs,
}: {
  gamesDir?: string;
  installLocations: string[];
  defaultDirs?: string[];
}): Promise<string[]> {
  const folders: string[] = [];
  const searchDirs = gamesDir
    ? [gamesDir]
    : defaultDirs.filter((dir) => fs.existsSync(dir));
  for (const dir of searchDirs) {
    const installDataFiles: string[] = await glob(
      "*/__Installer/installerdata.xml",
      { dot: true, cwd: dir, absolute: true },
    );
    for (const installDataFile of installDataFiles) {
      folders.push(path.join(path.dirname(installDataFile), ".."));
    }
  }
  for (const location of installLocations) {
    if (inSteamLibrary(location)) continue;
    if (path.isAbsolute(location) && fs.existsSync(installDataFile(location))) {
      folders.push(path.resolve(location));
    }
  }
  const seen = new Set<string>();
  return folders.filter((folder) => {
    const key = path.resolve(folder).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// An EA game bought on Steam has installer data too, and Windows lists it
// (Steam's "Steam App <id>" entries). Steam already lists those games.
function inSteamLibrary(location: string) {
  return /(^|[\\/])steamapps[\\/]+common([\\/]|$)/i.test(location);
}

function installDataFile(gameDir: string) {
  return path.join(gameDir, "__Installer", "installerdata.xml");
}

// The games in `folders`, each once (by its first content id). In launcher
// mode a game is listed without an exe: origin2:// only needs its content id.
// With `waitForExit` (launcher mode, Windows), a game's shortcut runs SRM's
// launch script, which waits for the game (see eaWaitForExitWrapper).
export async function installedGames(
  folders: string[],
  launcherMode: boolean,
  {
    waitForExit = false,
    steamOverlay = false,
  }: { waitForExit?: boolean; steamOverlay?: boolean } = {},
): Promise<{ success: ParsedSuccess[]; failed: string[] }> {
  const success: ParsedSuccess[] = [];
  const failed: string[] = [];
  const contentIds = new Set<string>();
  for (const gameDir of folders) {
    const file = installDataFile(gameDir);
    let xmlBuffer: Buffer;
    try {
      xmlBuffer = fs.readFileSync(file);
    } catch (e) {
      failed.push(`Could not read ${file}: ${e}`);
      continue;
    }
    // Parsers run in the main process: the library's Node build takes
    // a Buffer (or path); its browser build took a Blob.
    const fileInfo = await languageEncoding(xmlBuffer);

    let xmlString;
    if (fileInfo.encoding == "UTF-8") {
      xmlString = xmlBuffer.toString();
    } else if (fileInfo.encoding == "UTF-16LE") {
      xmlString = xmlBuffer.toString("utf16le");
    } else {
      // (one odd file: that game fails, not the whole parser)
      failed.push(`Unrecognized file encoding for ${file}.`);
      continue;
    }

    const game = parseInstallerData(xmlString, gameDir, { launcherMode });
    if (typeof game === "string") {
      failed.push(game);
      continue;
    }
    // (two folders can hold the same game, e.g. a copy left behind)
    if (contentIds.has(game.contentId)) continue;
    contentIds.add(game.contentId);
    const launchWrapper =
      launcherMode && waitForExit
        ? eaWaitForExitWrapper(
            {
              contentId: game.contentId,
              folder: gameDir,
              // (none when the game's exe wasn't found)
              exeName:
                game.filePath !== gameDir
                  ? path.win32.basename(game.filePath)
                  : undefined,
            },
            { steamOverlay },
          )
        : undefined;
    success.push({
      extractedTitle: game.title,
      extractedAppId: game.contentId,
      launchOptions: `-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"origin2://game/launch/?offerIds=${game.contentId}\\""`,
      filePath: game.filePath,
      fileLaunchOptions: game.args,
      ...(launchWrapper && { launchWrapper }),
    });
  }
  return { success, failed };
}

export interface InstallerDataGame {
  title: string;
  // The first content id (the game's own), which origin2:// links take.
  contentId: string;
  // The game's exe; in launcher mode, when there is none, its folder.
  filePath: string;
  // The exe's arguments, from the installer data.
  args?: string;
}

// One game's installerdata.xml (already decoded), in either of the two
// formats EA has used: a game, or an error message (also when the file isn't
// valid XML, e.g. cut short). `exists` is how the exe is looked for when the
// file names none: the folder's name without spaces, in Binaries or the
// folder itself.
export function parseInstallerData(
  xmlString: string,
  gameDir: string,
  {
    launcherMode = false,
    exists = fs.existsSync,
  }: { launcherMode?: boolean; exists?: (file: string) => boolean } = {},
): InstallerDataGame | string {
  // (validate() returns true, or an error object, which is truthy too)
  const valid = XMLValidator.validate(xmlString, {});
  if (valid !== true) {
    return `Game in ${gameDir} failed because its installerdata.xml is not valid XML: ${valid.err.msg} (line ${valid.err.line})`;
  }
  const parsedData = new XMLParser().parse(xmlString);
  let title = "";
  let runtimePath = "";
  let runtime;
  let contentID;
  let appID = "";
  let commandArgs;
  if (
    json.caselessHas(parsedData, [
      ["DiPManifest"],
      ["gameTitles"],
      ["gameTitle"],
    ]) &&
    json.caselessHas(parsedData, [
      ["DiPManifest"],
      ["contentIDs"],
      ["contentID"],
    ])
  ) {
    let gameTitle = json.caselessGet(parsedData, [
      ["DiPManifest"],
      ["gameTitles"],
      ["gameTitle"],
    ]);

    if (Array.isArray(gameTitle) && gameTitle.length) {
      title = String(gameTitle[0]);
    } else {
      title = String(gameTitle);
    }
    runtime = json.caselessGet(
      parsedData,
      [["DiPManifest"], ["runtime"], ["launcher"]],
      true,
    );

    contentID = json.caselessGet(parsedData, [
      ["DiPManifest"],
      ["contentIDs"],
      ["contentID"],
    ]);
  } else if (
    json.caselessHas(parsedData, [["game"], ["metadata"], ["localeInfo"]]) &&
    json.caselessHas(parsedData, [["game"], ["contentIDs"], ["contentID"]])
  ) {
    if (json.caselessHas(parsedData, [["game"], ["runtime"], ["launcher"]])) {
      runtime = json.caselessGet(
        parsedData,
        [["game"], ["runtime"], ["launcher"]],
        true,
      );
    }

    let localeInfo = json.caselessGet(parsedData, [
      ["game"],
      ["metadata"],
      ["localeInfo"],
    ]);
    if (Array.isArray(localeInfo) && localeInfo.length) {
      title = String(localeInfo[0].title);
    } else {
      title = String(localeInfo.title);
    }
    contentID = json.caselessGet(parsedData, [
      ["game"],
      ["contentIDs"],
      ["contentID"],
    ]);
  } else {
    return `Game in ${gameDir} failed because its installerdata.xml was in an unrecognizable format`;
  }

  if (!runtime) {
    //default, executable has same name as directory but stripped of whitespace, and lives in Binaries.
    const executable = `${path.basename(gameDir).replaceAll(/\s/g, "")}.exe`;
    const executablePaths = [
      path.join(gameDir, "Binaries", executable),
      path.join(gameDir, executable),
    ];

    const executablePath = executablePaths.find((file) => exists(file));
    if (executablePath) {
      runtime = {
        // (relative to the game's folder, as installer data names exes)
        filePath: path.relative(gameDir, executablePath),
        parameters: "",
      };
    } else if (!launcherMode) {
      return `Game ${title} failed because its installerdata.xml contained no runtime and the default runtime paths ${executablePaths} does not exist`;
    }
  }

  if (runtime && Array.isArray(runtime) && runtime.length) {
    runtimePath = json.caselessGet(runtime[0], [["filePath"]]);
    commandArgs = json.caselessGet(runtime[0], [["parameters"]]);
  } else if (runtime && json.caselessHas(runtime, [["filePath"]])) {
    runtimePath = json.caselessGet(runtime, [["filePath"]]);
    commandArgs = json.caselessGet(runtime, [["parameters"]]);
  }
  if (Array.isArray(contentID) && contentID.length) {
    appID = String(contentID[0]);
  } else {
    appID = String(contentID);
  }
  if (title && appID && (runtimePath || launcherMode)) {
    return {
      title,
      contentId: appID,
      filePath: runtimePath
        ? path.join(gameDir, runtimePath.replace(/^\[.*?\]/, ""))
        : gameDir,
      args: commandArgs,
    };
  }
  return `Game with title ${title} failed. AppID: ${appID}, runtimePath: ${runtimePath}`;
}
