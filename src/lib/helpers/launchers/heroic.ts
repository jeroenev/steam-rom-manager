// Heroic (Linux): which of its stores it's signed in to, and the games it
// has installed through Legendary (Epic), its GOG code and Nile (Amazon).
// Natively Heroic keeps its files in ~/.config/heroic; as a Flatpak, in
// ~/.var/app/com.heroicgameslauncher.hgl/config/heroic. The file shapes are
// those BoilR's Heroic platform reads.
import * as fs from "fs-extra";
import * as path from "path";

export const HEROIC_FLATPAK_ID = "com.heroicgameslauncher.hgl";

export type HeroicRunner = "legendary" | "gog" | "nile";

export function heroicConfigDirs(home: string): string[] {
  return [
    path.posix.join(home, ".config", "heroic"),
    path.posix.join(home, ".var", "app", HEROIC_FLATPAK_ID, "config", "heroic"),
  ];
}

// The file that's there once Heroic is signed in to the runner's store.
export const HEROIC_SIGN_IN_FILES: Record<HeroicRunner, string> = {
  legendary: "legendaryConfig/legendary/user.json",
  gog: "gog_store/auth.json",
  nile: "nile_config/nile/user.json",
};

const INSTALLED_FILES: Record<HeroicRunner, string> = {
  legendary: "legendaryConfig/legendary/installed.json",
  gog: "gog_store/installed.json",
  nile: "nile_config/nile/installed.json",
};

// The games Heroic has installed with one runner, from one config folder:
// the store's id, and the title where the file has one. Throws when the file
// can't be read.
export function readHeroicInstalled(
  configDir: string,
  runner: HeroicRunner,
): { id: string; title?: string }[] {
  const file = path.join(configDir, INSTALLED_FILES[runner]);
  if (!fs.existsSync(file)) {
    return [];
  }
  const installed = JSON.parse(fs.readFileSync(file, "utf-8"));
  switch (runner) {
    case "legendary":
      // (as Legendary's own; DLC sits next to the games)
      return Object.entries(installed || {})
        .filter(([, app]: [string, any]) => app?.is_dlc !== true)
        .map(([key, app]: [string, any]) => ({
          id: String(app?.app_name || key),
          title: typeof app?.title === "string" ? app.title : undefined,
        }));
    case "gog":
      // { installed: [{ appName, platform, install_path }] }
      return (installed?.installed || [])
        .map((game: any) => ({ id: String(game?.appName ?? "") }))
        .filter((game: { id: string }) => game.id !== "");
    case "nile": {
      // A list, or { installed: [...] }, of { id, path }.
      const entries = Array.isArray(installed)
        ? installed
        : installed?.installed || [];
      return entries
        .map((game: any) => ({
          id: String(game?.id ?? game?.appName ?? game?.app_name ?? ""),
          title:
            typeof game?.path === "string"
              ? path.basename(game.path.replace(/[\\/]+$/, ""))
              : undefined,
        }))
        .filter((game: { id: string }) => game.id !== "");
    }
  }
}
