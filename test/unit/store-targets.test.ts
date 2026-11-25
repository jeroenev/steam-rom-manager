// What the shortcut of an owned, not installed game runs (ported from
// BoilR's accounts/targets.rs tests), with launcher detection over a fake
// file system.
import { describe, expect, it } from "vitest";
import {
  DetectEnv,
  Launchers,
  detectLaunchers,
  heroicInstall,
  installTarget,
  storePage,
} from "../../src/lib/stores/targets";
import { OwnedGame, StoreKey, ownedGame } from "../../src/lib/stores/types";

const game = (
  store: StoreKey,
  id: string,
  extra: Record<string, string> = {},
) => ownedGame(store, id, "Some Game", extra);

const linux = (more: Partial<Launchers> = {}): Launchers => ({
  osType: "Linux",
  heroicStores: [],
  opener: "/usr/bin/xdg-open",
  flatpak: "/usr/bin/flatpak",
  ...more,
});

const windows = (more: Partial<Launchers> = {}): Launchers => ({
  osType: "Windows_NT",
  heroicStores: [],
  opener: "C:\\WINDOWS\\explorer.exe",
  flatpak: "/usr/bin/flatpak",
  ...more,
});

const POWERSHELL =
  "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

// A file system with only these files.
function fakeEnv(
  osType: string,
  files: string[],
  env: Record<string, string> = {},
  home = "/home/deck",
): DetectEnv {
  const there = new Set(files.map((f) => f.toLowerCase()));
  return { osType, env, home, exists: (file) => there.has(file.toLowerCase()) };
}

const WINDOWS_ENV = {
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramFiles: "C:\\Program Files",
  ProgramW6432: "C:\\Program Files",
  APPDATA: "C:\\Users\\A\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\A\\AppData\\Local",
};

describe("install targets", () => {
  it("without launchers, opens the store page", () => {
    const target = installTarget(
      game("gog", "1207658924", { slug: "unreal_gold" }),
      "auto",
      linux(),
    );
    expect(target).toEqual({
      exe: "/usr/bin/xdg-open",
      args: '"https://www.gog.com/game/unreal_gold"',
      startDir: "/usr/bin",
      via: "browser",
    });
  });

  it("Epic and EA go through PowerShell, as their launcher-mode parsers", () => {
    const launchers = windows({
      epic: "C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe",
      ea: "C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe",
    });
    const epic = installTarget(
      game("epic", "Fortnite", {
        namespace: "fn",
        catalog_item_id: "4fe75bbc5a674f4f9b356b5c90567da5",
      }),
      "auto",
      launchers,
    );
    expect(epic).toEqual({
      exe: POWERSHELL,
      args: '-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true\\""',
      startDir: "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0",
      via: "launcher",
    });
    // Without catalog ids: the library.
    expect(installTarget(game("epic", "X"), "auto", launchers).args).toContain(
      "com.epicgames.launcher://store/library",
    );
    const ea = installTarget(
      game("ea", "Origin.OFR.50.0002694", { content_id: "1234" }),
      "auto",
      launchers,
    );
    expect(ea.exe).toBe(POWERSHELL);
    expect(ea.args).toBe(
      '-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"origin2://game/launch/?offerIds=1234\\""',
    );
    // Without a content id, the offer id.
    expect(
      installTarget(game("ea", "OFB-EAST:52735"), "auto", launchers).args,
    ).toContain("offerIds=OFB-EAST:52735");
  });

  it("Ubisoft Connect installs through PowerShell, as the UPlay parser's launcher mode", () => {
    const launchers = windows({
      ubisoft:
        "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe",
      // (the UPlay parser always starts C:\WINDOWS's PowerShell)
      powershell: "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });
    expect(installTarget(game("ubisoft", "5408"), "auto", launchers)).toEqual({
      exe: POWERSHELL,
      args: '-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"uplay://install/5408\\""',
      startDir: "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0",
      via: "launcher",
    });
    // Without Ubisoft Connect: its download page.
    expect(installTarget(game("ubisoft", "5408"), "auto", windows())).toEqual({
      exe: "C:\\WINDOWS\\explorer.exe",
      args: '"https://ubisoftconnect.com/"',
      startDir: "C:\\WINDOWS",
      via: "browser",
    });
    // Only a product id (digits) goes into the link.
    for (const id of ["46/0", "x$(calc)", ""]) {
      expect(installTarget(game("ubisoft", id), "auto", launchers).via).toBe(
        "browser",
      );
    }
  });

  it("GOG, Amazon and Battle.net open their own launchers", () => {
    const launchers = windows({
      galaxy: "C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe",
      amazon:
        "C:\\Users\\A\\AppData\\local\\Amazon Games\\App\\Amazon Games.exe",
      battlenet: "C:\\Program Files (x86)\\Battle.net\\Battle.net.exe",
    });
    expect(installTarget(game("gog", "1"), "auto", launchers)).toEqual({
      exe: "C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe",
      args: '/urlProtocol="goggalaxy://openGameView/1"',
      startDir: "C:\\Program Files (x86)\\GOG Galaxy",
      via: "launcher",
    });
    expect(
      installTarget(game("amazon", "amzn1.adg.product.x"), "auto", launchers),
    ).toEqual({
      exe: "C:\\Users\\A\\AppData\\local\\Amazon Games\\App\\Amazon Games.exe",
      args: "amazon-games://install/amzn1.adg.product.x",
      startDir: "C:\\Users\\A\\AppData\\local\\Amazon Games\\App",
      via: "launcher",
    });
    const overwatch = game("battlenet", "Pro", { internal_id: "prometheus" });
    expect(installTarget(overwatch, "auto", launchers)).toMatchObject({
      exe: "C:\\Program Files (x86)\\Battle.net\\Battle.net.exe",
      args: "--game=prometheus",
    });
    // Classic games have no internal id: the download page.
    expect(installTarget(game("battlenet", "W3"), "auto", launchers)).toEqual({
      exe: "C:\\WINDOWS\\explorer.exe",
      args: '"https://download.battle.net/"',
      startDir: "C:\\WINDOWS",
      via: "browser",
    });
  });

  it("the browser setting skips launchers", () => {
    const launchers = windows({
      galaxy: "C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe",
    });
    const gog = game("gog", "1");
    expect(installTarget(gog, "auto", launchers).args).toContain(
      "goggalaxy://openGameView/1",
    );
    const inBrowser = installTarget(gog, "browser", launchers);
    expect(inBrowser.args).toBe('"https://www.gog.com/account"');
    expect(inBrowser.startDir).toBe("C:\\WINDOWS");
  });

  it("itch goes through the itch app when it's there, Humble to its page", () => {
    expect(
      installTarget(
        game("itch", "42"),
        "auto",
        windows({ itch: "C:\\itch.exe" }),
      ),
    ).toEqual({
      exe: "C:\\WINDOWS\\explorer.exe",
      args: '"itch://install?game_id=42&launch"',
      startDir: "C:\\WINDOWS",
      via: "launcher",
    });
    expect(installTarget(game("itch", "42"), "auto", linux()).args).toBe(
      '"https://itch.io/game/42"',
    );
    const humble = game("humble", "game_name", {
      url: "https://www.humblebundle.com/downloads?key=abc",
    });
    expect(installTarget(humble, "heroic", linux()).args).toBe(
      '"https://www.humblebundle.com/downloads?key=abc"',
    );
  });

  it("uses Heroic on Linux, for the stores it's signed in to", () => {
    const launchers = linux({
      heroic: { kind: "flatpak" },
      heroicStores: ["amazon"],
    });
    // Heroic isn't signed in to GOG, so GOG games open the store page.
    expect(installTarget(game("gog", "1"), "heroic", launchers).exe).toBe(
      "/usr/bin/xdg-open",
    );
    expect(
      installTarget(game("amazon", "amzn1.adg.product.x"), "auto", launchers),
    ).toEqual({
      exe: "/usr/bin/flatpak",
      args: "run com.heroicgameslauncher.hgl heroic://launch/nile/amzn1.adg.product.x --no-gui --no-sandbox",
      startDir: "/usr/bin",
      via: "heroic",
    });
    // A native Heroic.
    const native = linux({
      heroic: { kind: "native", exe: "heroic" },
      heroicStores: ["gog", "epic"],
    });
    expect(installTarget(game("gog", "1"), "auto", native)).toEqual({
      exe: "heroic",
      args: "heroic://launch/gog/1",
      startDir: "/",
      via: "heroic",
    });
    expect(installTarget(game("epic", "Fortnite"), "auto", native).args).toBe(
      "heroic://launch/legendary/Fortnite",
    );
  });

  it("finds Heroic from inside a Flatpak", () => {
    const home = "/home/deck";
    const only = (there: string) => (file: string) => file === there;
    // A system-wide Heroic Flatpak, seen from SRM's own Flatpak: only its
    // data folder.
    expect(
      heroicInstall(
        undefined,
        only("/home/deck/.var/app/com.heroicgameslauncher.hgl"),
        home,
      ),
    ).toEqual({ kind: "flatpak" });
    // Seen from the host.
    expect(
      heroicInstall(
        undefined,
        only("/var/lib/flatpak/app/com.heroicgameslauncher.hgl"),
        home,
      ),
    ).toEqual({ kind: "flatpak" });
    // A native Heroic whose program can't be seen runs by name on the host.
    expect(
      heroicInstall(undefined, only("/home/deck/.config/heroic"), home),
    ).toEqual({
      kind: "native",
      exe: "heroic",
    });
    expect(heroicInstall("/usr/bin/heroic", () => true, home)).toEqual({
      kind: "native",
      exe: "/usr/bin/heroic",
    });
    expect(heroicInstall(undefined, () => false, home)).toBeUndefined();
  });

  it("detects the Windows launchers, SRM's own paths first", () => {
    const launchers = detectLaunchers(
      fakeEnv(
        "Windows_NT",
        [
          "C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe",
          "C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe",
          "C:\\Users\\A\\AppData\\Local\\Amazon Games\\App\\Amazon Games.exe",
          "C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe",
          "C:\\Program Files (x86)\\Battle.net\\Battle.net.exe",
          "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe",
        ],
        WINDOWS_ENV,
      ),
    );
    expect(launchers).toEqual({
      osType: "Windows_NT",
      epic: "C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe",
      galaxy: "C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe",
      // (as the Amazon Games parser writes it: the shortcut's id depends on
      // it)
      amazon:
        "C:\\Users\\A\\AppData\\local\\Amazon Games\\App\\Amazon Games.exe",
      ea: "C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe",
      battlenet: "C:\\Program Files (x86)\\Battle.net\\Battle.net.exe",
      itch: undefined,
      ubisoft:
        "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe",
      // (no SystemRoot: where SRM always had them)
      powershell: POWERSHELL,
      heroicStores: [],
      opener: "C:\\WINDOWS\\explorer.exe",
      flatpak: "/usr/bin/flatpak",
    });
    // Nothing installed: everything opens in the browser.
    const none = detectLaunchers(fakeEnv("Windows_NT", [], WINDOWS_ENV));
    expect(installTarget(game("gog", "1"), "auto", none).via).toBe("browser");
  });

  it("EA's shortcut and the browser follow where Windows is, as the EA Desktop parser does", () => {
    const eaExe =
      "C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe";
    const epicExe =
      "C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe";
    const detect = (systemRoot?: string) =>
      detectLaunchers(
        fakeEnv("Windows_NT", [eaExe, epicExe], {
          ...WINDOWS_ENV,
          ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot }),
        }),
      );
    const elsewhere = detect("D:\\Win");
    const ea = installTarget(game("ea", "OFB-EAST:1"), "auto", elsewhere);
    expect(ea.exe).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(ea.startDir).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0");
    // (the Epic parser always starts C:\WINDOWS's PowerShell)
    expect(installTarget(game("epic", "X"), "auto", elsewhere).exe).toBe(
      POWERSHELL,
    );
    expect(installTarget(game("gog", "1"), "auto", elsewhere)).toMatchObject({
      exe: "D:\\Win\\explorer.exe",
      startDir: "D:\\Win",
      via: "browser",
    });
    // Where Windows is in C:\Windows (any case), or SystemRoot isn't set: the
    // paths shortcuts have always had, so their ids stay.
    for (const usual of [undefined, "C:\\Windows", "c:\\WINDOWS\\"]) {
      const launchers = detect(usual);
      expect(
        installTarget(game("ea", "OFB-EAST:1"), "auto", launchers).exe,
      ).toBe(POWERSHELL);
      expect(launchers.opener).toBe("C:\\WINDOWS\\explorer.exe");
    }
  });

  it("an id that isn't plain never goes into a command line", () => {
    const launchers = windows({
      epic: "C:\\Epic\\EpicGamesLauncher.exe",
      ea: "C:\\EA\\EADesktop.exe",
      galaxy: "C:\\GOG Galaxy\\GalaxyClient.exe",
      amazon: "C:\\Amazon Games\\Amazon Games.exe",
      battlenet: "C:\\Battle.net\\Battle.net.exe",
      itch: "C:\\itch\\itch.exe",
    });
    const hostile = [
      "x$(Start-Process calc)",
      'x";calc;"',
      "x`calc`",
      "x --gpu-launcher=calc",
    ];
    const games = hostile.flatMap((id) => [
      game("epic", id, { namespace: "ns", catalog_item_id: "cat" }),
      game("ea", "Origin.OFR.50.1", { content_id: id }),
      game("ea", id),
      game("gog", id),
      game("amazon", id),
      game("battlenet", "Pro", { internal_id: id }),
      game("itch", id),
    ]);
    for (const owned of games) {
      const target = installTarget(owned, "auto", launchers);
      expect(target.via, `${owned.store} ${owned.id}`).toBe("browser");
      for (const bad of ["$(", "`", ";calc", "--gpu-launcher"]) {
        expect(target.args).not.toContain(bad);
      }
    }
    // Epic's catalog ids too: the library page instead of the game's link.
    const sneaky = installTarget(
      game("epic", "Fortnite", {
        namespace: 'fn";calc;"',
        catalog_item_id: "c",
      }),
      "auto",
      launchers,
    );
    expect(sneaky.via).toBe("launcher");
    expect(sneaky.args).toContain("com.epicgames.launcher://store/library");
    expect(sneaky.args).not.toContain("calc");
    // Heroic: no link for such an id.
    const heroic = linux({
      heroic: { kind: "native", exe: "heroic" },
      heroicStores: ["epic", "gog", "amazon"],
    });
    for (const id of ["x;calc", "x $(calc)", "x&&calc"]) {
      const target = installTarget(game("gog", id), "heroic", heroic);
      expect(target.via).toBe("browser");
      expect(target.args).toBe('"https://www.gog.com/account"');
    }
    // Real ids pass.
    expect(
      installTarget(game("ea", "OFB-EAST:52735"), "auto", launchers).via,
    ).toBe("launcher");
    expect(
      installTarget(
        game("amazon", "amzn1.adg.product.1a2b-3c"),
        "auto",
        launchers,
      ).via,
    ).toBe("launcher");
    expect(installTarget(game("itch", "42"), "auto", launchers).via).toBe(
      "launcher",
    );
  });

  it("a store page that can't go between quotes isn't used", () => {
    for (const url of [
      'https://www.humblebundle.com/x"&calc&"',
      "https://www.humblebundle.com/$(calc)",
      "https://www.humblebundle.com/`calc`",
      "https://www.humblebundle.com/a b",
      "https://www.humblebundle.com/a\\b",
    ]) {
      expect(storePage(game("humble", "h", { url }))).toBe(
        "https://www.humblebundle.com/home/library",
      );
    }
    expect(storePage(game("itch", "x$(calc)"))).toBe(
      "https://itch.io/my-purchases",
    );
    expect(storePage(game("gog", "1", { slug: 'a"b' }))).toBe(
      "https://www.gog.com/account",
    );
    expect(
      storePage(ownedGame("epic", "x", "Alan Wake 2", { product_slug: "a b" })),
    ).toBe("https://store.epicgames.com/browse?q=Alan+Wake+2");
  });

  it("detects Heroic and the stores it's signed in to on Linux", () => {
    const flatpak = detectLaunchers(
      fakeEnv("Linux", [
        "/home/deck/.var/app/com.heroicgameslauncher.hgl",
        "/home/deck/.var/app/com.heroicgameslauncher.hgl/config/heroic/gog_store/auth.json",
        "/home/deck/.config/heroic/nile_config/nile/user.json",
      ]),
    );
    expect(flatpak).toMatchObject({
      heroic: { kind: "flatpak" },
      heroicStores: ["gog", "amazon"],
      opener: "/usr/bin/xdg-open",
    });
    const native = detectLaunchers(
      fakeEnv(
        "Linux",
        [
          "/usr/bin/heroic",
          "/home/deck/.config/heroic/legendaryConfig/legendary/user.json",
          "/home/deck/.itch/itch",
        ],
        { PATH: "/usr/local/bin:/usr/bin" },
      ),
    );
    expect(native).toMatchObject({
      heroic: { kind: "native", exe: "/usr/bin/heroic" },
      heroicStores: ["epic"],
      itch: "/home/deck/.itch/itch",
    });
    // Inside a Flatpak, PATH is the sandbox's: not searched.
    const sandboxed = detectLaunchers(
      fakeEnv("Linux", ["/usr/bin/heroic", "/home/deck/.config/heroic"], {
        PATH: "/usr/bin",
        FLATPAK_ID: "com.steamgriddb.steam-rom-manager",
      }),
    );
    expect(sandboxed.heroic).toEqual({ kind: "native", exe: "heroic" });
  });

  it("knows each store's page", () => {
    const page = (g: OwnedGame) => storePage(g);
    expect(page(game("epic", "x", { product_slug: "fortnite" }))).toBe(
      "https://store.epicgames.com/p/fortnite",
    );
    expect(page(ownedGame("epic", "x", "Alan Wake 2"))).toBe(
      "https://store.epicgames.com/browse?q=Alan+Wake+2",
    );
    expect(page(game("gog", "1"))).toBe("https://www.gog.com/account");
    expect(page(game("amazon", "1"))).toBe("https://gaming.amazon.com/home");
    expect(page(game("ea", "1"))).toBe("https://www.ea.com/ea-app");
    expect(page(game("battlenet", "1"))).toBe("https://download.battle.net/");
    expect(page(game("ubisoft", "46"))).toBe("https://ubisoftconnect.com/");
    expect(page(game("humble", "1"))).toBe(
      "https://www.humblebundle.com/home/library",
    );
    // A store module's https url wins; others don't.
    expect(page(game("itch", "1", { url: "https://a.itch.io/b" }))).toBe(
      "https://a.itch.io/b",
    );
    expect(page(game("itch", "1", { url: "javascript:alert(1)" }))).toBe(
      "https://itch.io/game/1",
    );
  });
});
