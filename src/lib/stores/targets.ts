// What the Steam shortcut of an owned, not installed game runs: the store's
// own launcher, opened on the game (where it installs it), when that
// launcher is installed; else, on Linux, Heroic, when it's signed in to the
// store (Epic, GOG and Amazon); else the store's page in the browser.
// Ported from BoilR's accounts/targets.rs.
//
// A Steam shortcut's id comes from its program and its title. So where SRM
// has a launcher-mode parser for the store, the shortcut uses that parser's
// program (PowerShell for Epic, EA and Ubisoft Connect, GalaxyClient.exe,
// Amazon Games.exe, Battle.net.exe): once the game is installed and that
// parser lists it under the same title, the shortcut keeps its id, and with
// it its artwork and exceptions. (Not for an EA Desktop or UPlay parser that
// waits for the game to exit: its shortcuts run SRM's launch script,
// lib/launch-wrapper.)

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_BATTLE_NET_EXE,
  HEROIC_FLATPAK_ID,
  HEROIC_SIGN_IN_FILES,
  HeroicRunner,
  POWERSHELL_EXE,
  defaultAmazonGamesExe,
  explorerPath,
  galaxyPaths,
  heroicConfigDirs,
  powershellOpen,
  powershellPath,
} from "../helpers/launchers";
import { OwnedGame, StoreKey } from "./types";

// Store ids end up in a command line (PowerShell's -Command, a launcher's
// arguments, a shell on Linux): only plain ids go in. A game whose id isn't
// one gets the next way to install it (Heroic, then the store page).
const PLAIN_ID = /^[A-Za-z0-9._:-]+$/;

export function plainId(value: string | undefined): value is string {
  return value !== undefined && PLAIN_ID.test(value);
}

const DIGITS = /^\d+$/;
// (a store page's last part)
const PLAIN_SLUG = /^[A-Za-z0-9._-]+$/;
// A web page a store module named, as it can go between double quotes in a
// command line (no quote, $, backtick, backslash or space).
const PLAIN_PAGE = /^https:\/\/[^\s"'`$\\]+$/;

// What the shortcut of a game that isn't installed opens (the Store Account
// parser's storeInstallWith).
export type InstallWith = "auto" | "heroic" | "browser";

export type HeroicInstall =
  | { kind: "flatpak" }
  // `exe`: absolute, or "heroic" (on the host's PATH)
  | { kind: "native"; exe: string };

// The launchers on this machine: what a shortcut can go through.
export interface Launchers {
  osType: string;
  // Each store's launcher, where it's installed: the program a shortcut
  // starts (GOG, Amazon, Battle.net) or only a sign that the store's link
  // will work (Epic, EA and Ubisoft Connect go through PowerShell, the itch
  // app through the opener).
  epic?: string;
  galaxy?: string;
  amazon?: string;
  ea?: string;
  battlenet?: string;
  itch?: string;
  ubisoft?: string;
  // PowerShell as the EA Desktop parser runs it (where Windows is; Epic's
  // parser always uses POWERSHELL_EXE). Unset: POWERSHELL_EXE.
  powershell?: string;
  heroic?: HeroicInstall;
  // The stores Heroic is signed in to: it only installs games of those.
  heroicStores: StoreKey[];
  // What opens a link or a web page: explorer.exe, xdg-open, open.
  opener: string;
  // The flatpak program (for a Heroic Flatpak).
  flatpak: string;
}

export interface InstallTarget {
  exe: string;
  args: string;
  startDir: string;
  via: "launcher" | "heroic" | "browser";
}

// What detection looks at; tests give a fake file system.
export interface DetectEnv {
  osType: string;
  env: Record<string, string | undefined>;
  home: string;
  exists(file: string): boolean;
}

export function systemDetectEnv(): DetectEnv {
  return {
    osType: os.type(),
    env: process.env,
    home: os.homedir(),
    exists: (file) => fs.existsSync(file),
  };
}

// (Steam runs the shortcut on the host, also when SRM runs as a Flatpak:
// these are where the host has them on every common distribution and on
// SteamOS. A search of SRM's own PATH could find programs only SRM's
// sandbox has.)
const XDG_OPEN = "/usr/bin/xdg-open";
const FLATPAK = "/usr/bin/flatpak";

export function detectLaunchers(env: DetectEnv = systemDetectEnv()): Launchers {
  const first = (candidates: (string | undefined)[]) =>
    candidates.find((file) => !!file && env.exists(file));
  if (env.osType == "Windows_NT") {
    // (a folder from an environment variable, Windows style)
    const under = (vars: string[], ...rest: string[]) =>
      vars.map((name) =>
        env.env[name] ? path.win32.join(env.env[name], ...rest) : undefined,
      );
    return {
      osType: env.osType,
      epic: first(
        ["Win64", "Win32"].flatMap((arch) =>
          under(
            ["ProgramFiles(x86)", "ProgramFiles"],
            "Epic Games",
            "Launcher",
            "Portal",
            "Binaries",
            arch,
            "EpicGamesLauncher.exe",
          ),
        ),
      ),
      // SRM's parsers' own paths come first: the program is part of the
      // shortcut's id.
      galaxy: first([
        galaxyPaths("Windows_NT").exePath,
        ...under(
          ["ProgramFiles(x86)", "ProgramFiles"],
          "GOG Galaxy",
          "GalaxyClient.exe",
        ),
      ]),
      amazon: first([
        env.env.APPDATA ? defaultAmazonGamesExe(env.env.APPDATA) : undefined,
        ...under(["LOCALAPPDATA"], "Amazon Games", "App", "Amazon Games.exe"),
      ]),
      ea: first(
        ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"].flatMap(
          (name) => [
            ...under(
              [name],
              "Electronic Arts",
              "EA Desktop",
              "EA Desktop",
              "EADesktop.exe",
            ),
            ...under([name], "Origin", "Origin.exe"),
          ],
        ),
      ),
      battlenet: first([
        DEFAULT_BATTLE_NET_EXE,
        ...under(
          ["ProgramFiles(x86)", "ProgramFiles"],
          "Battle.net",
          "Battle.net.exe",
        ),
      ]),
      itch: first(under(["LOCALAPPDATA"], "itch", "itch.exe")),
      ubisoft: first(
        under(
          ["ProgramFiles(x86)", "ProgramFiles"],
          "Ubisoft",
          "Ubisoft Game Launcher",
          "upc.exe",
        ),
      ),
      powershell: powershellPath(env.env.SystemRoot),
      heroicStores: [],
      opener: explorerPath(env.env.SystemRoot),
      flatpak: FLATPAK,
    };
  }
  if (env.osType == "Linux") {
    const home = env.home;
    return {
      osType: env.osType,
      itch: first([
        path.posix.join(home, ".itch", "itch"),
        path.posix.join(home, ".local/share/flatpak/exports/bin/io.itch.itch"),
        "/var/lib/flatpak/exports/bin/io.itch.itch",
      ]),
      heroic: heroicInstall(
        findInPath("heroic", env) ?? first(["/opt/Heroic/heroic"]),
        env.exists,
        home,
      ),
      heroicStores: heroicSignedInStores(home, env.exists),
      opener: XDG_OPEN,
      flatpak: FLATPAK,
    };
  }
  return {
    osType: env.osType,
    heroicStores: [],
    opener: "/usr/bin/open",
    flatpak: FLATPAK,
  };
}

// A program on PATH; never inside a Flatpak (see XDG_OPEN).
function findInPath(name: string, env: DetectEnv): string | undefined {
  if (env.env.FLATPAK_ID || env.exists("/.flatpak-info")) {
    return undefined;
  }
  return (env.env.PATH || "")
    .split(":")
    .filter((dir) => dir.startsWith("/"))
    .map((dir) => path.posix.join(dir, name))
    .find((file) => env.exists(file));
}

// Which Heroic is there. Inside SRM's own Flatpak neither the host's PATH
// nor /var/lib/flatpak (where SteamOS keeps a system-wide Heroic Flatpak)
// can be seen; what can be is the folder a Flatpak app keeps its data in,
// ~/.var/app/<id>, there once Heroic has run. A native Heroic that can't be
// found shows by its config folder, and runs by name on the host.
export function heroicInstall(
  native: string | undefined,
  exists: (file: string) => boolean,
  home: string | undefined,
): HeroicInstall | undefined {
  if (native) {
    return { kind: "native", exe: native };
  }
  const flatpakSigns = [
    path.posix.join("/var/lib/flatpak/app", HEROIC_FLATPAK_ID),
  ];
  if (home) {
    flatpakSigns.push(
      path.posix.join(home, ".local/share/flatpak/app", HEROIC_FLATPAK_ID),
      path.posix.join(home, ".var/app", HEROIC_FLATPAK_ID),
    );
  }
  if (flatpakSigns.some((file) => exists(file))) {
    return { kind: "flatpak" };
  }
  if (home && exists(path.posix.join(home, ".config/heroic"))) {
    return { kind: "native", exe: "heroic" };
  }
  return undefined;
}

// The store each Heroic runner installs from.
const HEROIC_RUNNERS: [StoreKey, HeroicRunner][] = [
  ["epic", "legendary"],
  ["gog", "gog"],
  ["amazon", "nile"],
];

// The stores Heroic (native or Flatpak) is signed in to.
export function heroicSignedInStores(
  home: string,
  exists: (file: string) => boolean,
): StoreKey[] {
  const dirs = heroicConfigDirs(home);
  return HEROIC_RUNNERS.filter(([, runner]) =>
    dirs.some((dir) =>
      exists(path.posix.join(dir, HEROIC_SIGN_IN_FILES[runner])),
    ),
  ).map(([store]) => store);
}

export function installTarget(
  game: OwnedGame,
  installWith: InstallWith,
  launchers: Launchers,
): InstallTarget {
  switch (installWith) {
    case "browser":
      return browser(launchers, storePage(game));
    case "heroic":
      return (
        heroicTarget(game, launchers) ??
        launcherTarget(game, launchers) ??
        browser(launchers, storePage(game))
      );
    default:
      return (
        launcherTarget(game, launchers) ??
        heroicTarget(game, launchers) ??
        browser(launchers, storePage(game))
      );
  }
}

// The store's own launcher, opened on the game.
function launcherTarget(
  game: OwnedGame,
  launchers: Launchers,
): InstallTarget | undefined {
  const inLauncher = (exe: string, args: string): InstallTarget => ({
    exe,
    args,
    startDir: path.win32.dirname(exe),
    via: "launcher",
  });
  switch (game.store) {
    case "epic":
      // (the Epic parser's PowerShell, which doesn't follow SystemRoot)
      return launchers.epic && plainId(game.id)
        ? inLauncher(POWERSHELL_EXE, powershellOpen(epicInstallLink(game)))
        : undefined;
    case "gog":
      // (how Windows hands Galaxy its goggalaxy:// links)
      return launchers.galaxy && plainId(game.id)
        ? inLauncher(
            launchers.galaxy,
            `/urlProtocol="goggalaxy://openGameView/${game.id}"`,
          )
        : undefined;
    case "amazon":
      return launchers.amazon && plainId(game.id)
        ? inLauncher(launchers.amazon, `amazon-games://install/${game.id}`)
        : undefined;
    case "ea":
      return launchers.ea && plainId(game.extra.content_id || game.id)
        ? inLauncher(
            launchers.powershell ?? POWERSHELL_EXE,
            powershellOpen(eaInstallLink(game)),
          )
        : undefined;
    case "battlenet": {
      // Games the launcher can't install (classic CD-key games, games SRM
      // doesn't know) have no internal id: they get the download page.
      const internalId = game.extra.internal_id;
      return launchers.battlenet && plainId(internalId)
        ? inLauncher(launchers.battlenet, `--game=${internalId}`)
        : undefined;
    }
    case "itch":
      return launchers.itch && DIGITS.test(game.id)
        ? {
            ...openLink(launchers, `itch://install?game_id=${game.id}&launch`),
            via: "launcher",
          }
        : undefined;
    case "ubisoft":
      // (the UPlay parser's PowerShell in launcher mode, which doesn't
      // follow SystemRoot)
      return launchers.ubisoft && DIGITS.test(game.id)
        ? inLauncher(POWERSHELL_EXE, powershellOpen(ubisoftInstallLink(game)))
        : undefined;
    case "humble":
      return undefined;
  }
}

// Ubisoft Connect's install link (Playnite's, GOG Galaxy's and Lutris's).
// It opens Ubisoft Connect's install dialog, whether Ubisoft Connect was
// running or not, also for a game linked to an Epic account (checked with
// Ubisoft Connect 175, 2026-11). Only while it's online: in offline mode it
// answers "Unable to start download (Code: 17003)".
export function ubisoftInstallLink(game: OwnedGame) {
  return `uplay://install/${game.id}`;
}

// Playnite's launch link, the one the Epic parser uses (with the game's
// catalog ids, which a game that isn't installed needs). Playnite avoids
// ?action=install: Epic shows an old, buggy install dialog for it. Without
// catalog ids (or with ids that aren't plain), the library page.
export function epicInstallLink(game: OwnedGame) {
  const { namespace, catalog_item_id } = game.extra;
  return plainId(namespace) && plainId(catalog_item_id) && plainId(game.id)
    ? `com.epicgames.launcher://apps/${namespace}%3A${catalog_item_id}%3A${game.id}?action=launch&silent=true`
    : "com.epicgames.launcher://store/library";
}

// The EA app opens its install dialog for this link when the game isn't
// installed (Jeshibu's EaLibrary); the EA Desktop parser launches with it.
export function eaInstallLink(game: OwnedGame) {
  return `origin2://game/launch/?offerIds=${game.extra.content_id || game.id}`;
}

// Heroic installs Epic (Legendary), GOG and Amazon (Nile) games; its launch
// link asks to install a game that isn't. With the runner, as Heroic has to
// know which store to install from.
function heroicTarget(
  game: OwnedGame,
  launchers: Launchers,
): InstallTarget | undefined {
  const runner = HEROIC_RUNNERS.find(([store]) => store == game.store)?.[1];
  if (
    !runner ||
    !launchers.heroic ||
    !launchers.heroicStores.includes(game.store) ||
    // (the link goes into the arguments unquoted)
    !plainId(game.id)
  ) {
    return undefined;
  }
  const link = `heroic://launch/${runner}/${game.id}`;
  if (launchers.heroic.kind == "flatpak") {
    return {
      exe: launchers.flatpak,
      args: `run ${HEROIC_FLATPAK_ID} ${link} --no-gui --no-sandbox`,
      startDir: path.posix.dirname(launchers.flatpak),
      via: "heroic",
    };
  }
  const exe = launchers.heroic.exe;
  return {
    exe,
    args: link,
    startDir: exe.startsWith("/") ? path.posix.dirname(exe) : "/",
    via: "heroic",
  };
}

function browser(launchers: Launchers, url: string): InstallTarget {
  return openLink(launchers, url);
}

function openLink(launchers: Launchers, link: string): InstallTarget {
  const dirname =
    launchers.osType == "Windows_NT" ? path.win32.dirname : path.posix.dirname;
  return {
    exe: launchers.opener,
    args: `"${link}"`,
    // (Steam on Windows can't start a shortcut without one: OS error 123)
    startDir: dirname(launchers.opener),
    via: "browser",
  };
}

// A page where the user can get the game: the store module's `url` when it
// has one. (Only pages that can go between quotes in a command line: what
// the store sent is checked here, so a library saved before is too.)
export function storePage(game: OwnedGame): string {
  const url = game.extra.url;
  if (url && PLAIN_PAGE.test(url)) {
    return url;
  }
  const slug =
    game.extra.slug && PLAIN_SLUG.test(game.extra.slug)
      ? game.extra.slug
      : undefined;
  switch (game.store) {
    case "epic": {
      const productSlug =
        game.extra.product_slug && PLAIN_SLUG.test(game.extra.product_slug)
          ? game.extra.product_slug
          : slug;
      return productSlug
        ? `https://store.epicgames.com/p/${productSlug}`
        : `https://store.epicgames.com/browse?${new URLSearchParams({ q: game.title })}`;
    }
    case "gog":
      return slug
        ? `https://www.gog.com/game/${slug}`
        : "https://www.gog.com/account";
    case "amazon":
      return "https://gaming.amazon.com/home";
    case "ea":
      return "https://www.ea.com/ea-app";
    case "battlenet":
      return "https://download.battle.net/";
    case "ubisoft":
      return "https://ubisoftconnect.com/";
    case "humble":
      return "https://www.humblebundle.com/home/library";
    case "itch":
      return DIGITS.test(game.id)
        ? `https://itch.io/game/${game.id}`
        : "https://itch.io/my-purchases";
  }
}
