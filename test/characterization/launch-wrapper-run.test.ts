// SRM's launch script, run for real on this OS (PowerShell on Windows, sh
// elsewhere) with a fake game: the stages run in order around the game,
// post-exit only once the game (and what it started) is gone, and a missing
// or failing script is logged without stopping anything.
import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  installLaunchScripts,
  launchLog,
  makeLaunchWrapper,
  writeWrapperFile,
  wrapperFile,
} from "../../src/lib/launch-wrapper";
import { tempDir } from "../helpers/fixtures";

const windows = process.platform === "win32";

describe("launch script", () => {
  it("runs the stages around the game; script failures don't stop it", async () => {
    const root = tempDir("launch");
    const order = path.join(root, "order.txt");
    const gameLog = path.join(root, "game.txt");
    const file = (name: string, content: string) => {
      const p = path.join(root, name);
      fs.writeFileSync(p, content, { mode: 0o755 });
      return p;
    };
    // a step: notes its stage, and (post-exit) what the game had written
    const step = (name: string) =>
      windows
        ? file(
            `${name}.ps1`,
            `$g = if (Test-Path '${gameLog}') { (Get-Content '${gameLog}') -join '+' } else { '' }\r\n` +
              `Add-Content '${order}' "${name} $env:SRM_STAGE $env:SRM_GAME_TITLE [$g]"\r\n` +
              `Write-Host "output of ${name}"\r\n`,
          )
        : file(
            `${name}.sh`,
            `#!/bin/sh\ng=$(cat '${gameLog}' 2>/dev/null | tr '\\n' '+')\n` +
              `echo "${name} $SRM_STAGE $SRM_GAME_TITLE [$g]" >> '${order}'\n` +
              `echo "output of ${name}"\n`,
          );
    const failing = windows
      ? file("fail.ps1", "Write-Host 'about to fail'\r\nexit 3\r\n")
      : file("fail.sh", "#!/bin/sh\necho 'about to fail'\nexit 3\n");
    // the game: starts a child that outlives it (a launcher handing off)
    const game = windows
      ? file(
          "game.cmd",
          `@echo off\r\necho started>>"${gameLog}"\r\n` +
            `start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & echo done>>"${gameLog}""\r\n`,
        )
      : file(
          "game.sh",
          `#!/bin/sh\necho started >> '${gameLog}'\n` +
            `(sleep 3; echo done >> '${gameLog}') &\n`,
        );

    const wrapper = makeLaunchWrapper(
      `"${game}"`,
      {
        enabled: true,
        preLaunch: { script: step("pre"), delay: 1 },
        postLaunch: { script: step("post"), delay: 0 },
        postExit: { script: step("exit"), delay: 0 },
      },
      {
        preLaunch: [{ script: path.join(root, "missing-script") }],
        postExit: [{ script: failing }],
      },
    );
    await installLaunchScripts();
    await writeWrapperFile("11111111", "123", {
      title: "Test Game",
      wrapper,
      launchOptions: "",
      startInDirectory: root,
    });
    const run = windows
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            wrapperFile("11111111", "123"),
          ],
          { encoding: "utf8", timeout: 90000 },
        )
      : spawnSync("/bin/sh", [wrapperFile("11111111", "123")], {
          encoding: "utf8",
          timeout: 90000,
        });
    expect(run.status, run.stderr).toBe(0);

    const lines = fs.readFileSync(order, "utf8").trim().split(/\r?\n/);
    expect(lines).toEqual([
      "pre pre-launch Test Game []",
      // (once the game's process has started: it may not have written yet)
      expect.stringMatching(/^post post-launch Test Game \[/),
      expect.stringMatching(/^exit post-exit Test Game \[started\+done\+?\]$/),
    ]);
    const log = fs.readFileSync(launchLog(), "utf8");
    expect(log).toContain("[Test Game] pre-launch: script not found, skipped");
    expect(log).toContain("output of pre");
    expect(log).toContain("about to fail");
    expect(log).toMatch(
      /post-exit: .*fail\.(ps1|sh) failed \(exit code 3\); carrying on/,
    );
    expect(log).toContain("[Test Game] game exited");
  }, 120000);

  // (Windows only: elsewhere a parser's launch isn't handed to a launcher)
  it.runIf(windows)(
    "doesn't wait for a launcher that couldn't be started; post-exit still runs",
    async () => {
      const root = tempDir("launch-failed");
      const order = path.join(root, "order.txt");
      const exitStep = path.join(root, "exit.ps1");
      fs.writeFileSync(
        exitStep,
        `Add-Content '${order}' "exit $env:SRM_STAGE"\r\n`,
      );
      const gameFolder = path.join(root, "Game");
      fs.mkdirSync(gameFolder);
      await installLaunchScripts();
      await writeWrapperFile("11111111", "124", {
        title: "Missing Launcher Game",
        wrapper: makeLaunchWrapper('"C:\\unused.exe"', undefined, {
          // (a missing program, as a launcher link whose launcher is gone)
          launch: { file: path.join(root, "no-such-launcher.exe") },
          game: { folder: gameFolder, startTimeoutMinutes: 10 },
          postExit: [{ script: exitStep }],
        }),
        launchOptions: "",
        startInDirectory: "",
      });
      const began = Date.now();
      const run = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          wrapperFile("11111111", "124"),
        ],
        { encoding: "utf8", timeout: 90000 },
      );
      expect(run.status, run.stderr).toBe(0);
      expect((Date.now() - began) / 1000).toBeLessThan(30);

      const log = fs
        .readFileSync(launchLog(), "utf8")
        .split(/\r?\n/)
        .filter((line) => line.includes("[Missing Launcher Game]"));
      const at = (text: string) => log.findIndex((line) => line.includes(text));
      expect(at("could not start the game")).toBeGreaterThan(-1);
      expect(at("the game didn't start; skipping post-launch scripts")).toBe(
        at("could not start the game") + 1,
      );
      expect(fs.readFileSync(order, "utf8").trim()).toBe("exit post-exit");
    },
    120000,
  );

  // A Store Account shortcut opening a launcher's install dialog: the launch
  // starts the launcher, which stays open; nothing is a game to wait for.
  it("a launch that only opens something (noWait) waits for nothing, not even what it started", async () => {
    const root = tempDir("launch-nowait");
    const order = path.join(root, "order.txt");
    const step = (name: string) => {
      const p = path.join(root, windows ? `${name}.ps1` : `${name}.sh`);
      fs.writeFileSync(
        p,
        windows
          ? `Add-Content '${order}' "${name} $env:SRM_STAGE"\r\n`
          : `#!/bin/sh\necho "${name} $SRM_STAGE" >> '${order}'\n`,
        { mode: 0o755 },
      );
      return p;
    };
    // the "launcher": starts and stays open for 40 s
    const launcher = path.join(root, windows ? "launcher.cmd" : "launcher.sh");
    fs.writeFileSync(
      launcher,
      windows
        ? "@echo off\r\nping -n 40 127.0.0.1 >nul\r\n"
        : "#!/bin/sh\nsleep 40\n",
      { mode: 0o755 },
    );
    await installLaunchScripts();
    await writeWrapperFile("11111111", "131", {
      title: "Install Only Game",
      wrapper: makeLaunchWrapper(`"${launcher}"`, undefined, {
        noWait: true,
        preLaunch: [{ script: step("pre") }],
        postLaunch: [{ script: step("post") }],
        postExit: [{ script: step("exit") }],
      }),
      launchOptions: "",
      startInDirectory: root,
    });
    const began = Date.now();
    const run = windows
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            wrapperFile("11111111", "131"),
          ],
          { encoding: "utf8", timeout: 90000 },
        )
      : spawnSync("/bin/sh", [wrapperFile("11111111", "131")], {
          encoding: "utf8",
          timeout: 90000,
        });
    expect(run.status, run.stderr).toBe(0);
    expect((Date.now() - began) / 1000).toBeLessThan(25);
    expect(fs.readFileSync(order, "utf8").trim().split(/\r?\n/)).toEqual([
      "pre pre-launch",
      "exit post-exit",
    ]);
    const log = fs
      .readFileSync(launchLog(), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("[Install Only Game]"));
    expect(
      log.some((line) => line.includes("opened; no game to wait for")),
    ).toBe(true);
    expect(log.some((line) => line.includes("game exited"))).toBe(false);
    expect(log.some((line) => line.includes("didn't start"))).toBe(false);
  }, 120000);

  // (Another signed-in user playing the same game from a shared library: their
  // copy, named like the game's executable but with a path this user can't
  // read, isn't this launch's game.)
  it.runIf(windows)(
    "only counts programs of this Windows session as the game",
    async () => {
      // A program that runs only in other sessions (services.exe, in session
      // 0, when the tests run in a user's session). Looked at only.
      const other = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          [
            "$me = [Diagnostics.Process]::GetCurrentProcess().SessionId",
            "$other = @(Get-Process | Group-Object ProcessName | Where-Object { !@($_.Group | Where-Object { $_.SessionId -eq $me }).Count } | ForEach-Object { $_.Name })",
            "If ($other -contains 'services') { 'services' } Else { $other | Select-Object -First 1 }",
          ].join("; "),
        ],
        { encoding: "utf8" },
      );
      expect(other.status, other.stderr).toBe(0);
      const name = other.stdout.trim();
      // (none on a machine with a single session: nothing to show then)
      if (!name) return;

      const root = tempDir("launch-session");
      const gameFolder = path.join(root, "Game");
      fs.mkdirSync(gameFolder);
      const launch = path.join(root, "launch.cmd");
      fs.writeFileSync(launch, "@echo off\r\n");
      await installLaunchScripts();
      await writeWrapperFile("11111111", "127", {
        title: "Other Session Game",
        wrapper: makeLaunchWrapper('"C:\\unused.exe"', undefined, {
          launch: { file: launch },
          game: {
            folder: gameFolder,
            exeName: `${name}.exe`,
            startTimeoutMinutes: 0.05,
          },
        }),
        launchOptions: "",
        startInDirectory: "",
      });
      const run = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          wrapperFile("11111111", "127"),
        ],
        // (counted as the game, the other session's program would be
        // waited for until it exits)
        { encoding: "utf8", timeout: 60000 },
      );
      expect(run.status, run.stderr).toBe(0);
      const log = fs
        .readFileSync(launchLog(), "utf8")
        .split(/\r?\n/)
        .filter((line) => line.includes("[Other Session Game]"))
        .join("\n");
      expect(log).toContain(
        "the game didn't start; skipping post-launch scripts",
      );
      expect(log).not.toContain("game started");
    },
    120000,
  );

  // A game found by its folder (as the EA app's, Ubisoft Connect's and Epic's
  // wrappers find theirs), started by a "launcher" (a .cmd file) as copies of
  // ping.exe in that folder. Its post-launch and post-exit steps note how many
  // of the game's programs ran then. `launcher` gets the game's exe and makes
  // other programs (copies of ping.exe outside the game's folder).
  async function runFolderGame(
    shortAppId: string,
    title: string,
    exeName: string,
    startTimeoutMinutes: number,
    launcher: (gameExe: string, otherExe: (name: string) => string) => string,
    handOff?: string[],
  ) {
    const root = tempDir("launch-folder");
    const order = path.join(root, "order.txt");
    const ping = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "PING.EXE",
    );
    const gameFolder = path.join(root, "Game");
    fs.mkdirSync(gameFolder);
    const gameExe = path.join(gameFolder, `${exeName}.exe`);
    fs.copyFileSync(ping, gameExe);
    const otherExe = (name: string) => {
      const exe = path.join(root, "Launcher", `${name}.exe`);
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.copyFileSync(ping, exe);
      return exe;
    };
    const step = path.join(root, "step.ps1");
    fs.writeFileSync(
      step,
      `Add-Content '${order}' "$env:SRM_STAGE $(@(Get-Process ${exeName} -ErrorAction SilentlyContinue).Count)"\r\n`,
    );
    const launch = path.join(root, "launch.cmd");
    fs.writeFileSync(launch, launcher(gameExe, otherExe));
    await installLaunchScripts();
    await writeWrapperFile("11111111", shortAppId, {
      title,
      wrapper: makeLaunchWrapper('"C:\\unused.exe"', undefined, {
        launch: { file: launch },
        game: {
          folder: gameFolder,
          startTimeoutMinutes,
          ...(handOff && { handOff }),
        },
        postLaunch: [{ script: step }],
        postExit: [{ script: step }],
      }),
      launchOptions: "",
      startInDirectory: "",
    });
    const began = Date.now();
    const run = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        wrapperFile("11111111", shortAppId),
      ],
      { encoding: "utf8", timeout: 100000 },
    );
    expect(run.status, run.stderr).toBe(0);
    const log = fs
      .readFileSync(launchLog(), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes(`[${title}]`))
      .join("\n");
    // (paths of programs running as administrator are read)
    expect(log).not.toContain("can't read the path");
    return {
      seconds: (Date.now() - began) / 1000,
      steps: fs.readFileSync(order, "utf8").trim().split(/\r?\n/),
      log,
    };
  }

  // (seen on Far Cry 3: its first program starts Ubisoft Connect's
  // UbisoftGameLauncher.exe and exits within a second; Ubisoft Connect then
  // stalled on a download and never started the game. Counted as started,
  // the launcher would have been closed under the user.)
  it.runIf(windows)(
    "a game that hands its start to its launcher hasn't started while the launcher's program runs",
    async () => {
      const { seconds, steps, log } = await runFolderGame(
        "125",
        "Handed-Off Game",
        "srmtesthandedoffgame",
        // (9 seconds)
        0.15,
        // (the game runs about 2 seconds: always seen, gone before the 3
        // second check; the launcher's program about 15)
        (gameExe, otherExe) =>
          `@echo off\r\nstart "" /b "${otherExe("srmtesthandoff")}" -n 16 127.0.0.1 >nul\r\n` +
          `start "" /b "${gameExe}" -n 3 127.0.0.1 >nul\r\n`,
        ["srmtesthandoff"],
      );
      expect(log).toContain("the game handed its start to its launcher");
      expect(log).not.toContain("the game closed again during start-up");
      expect(log).toContain(
        "the game didn't start; skipping post-launch scripts",
      );
      expect(log).not.toContain("game started");
      expect(steps).toEqual(["post-exit 0"]);
      expect(seconds).toBeLessThan(60);
    },
    120000,
  );

  // (a crash, or an error exit: the launcher is closed after it, as after
  // any game. With or without a hand-off program the parser names: none
  // runs.)
  it.runIf(windows).each<[string, string, string[] | undefined]>([
    ["129", "Crashing Game", undefined],
    ["130", "Crashing Ubisoft Game", ["srmtestnohandoff"]],
  ])(
    "a game that closes again at once ran and exited (%s, %s)",
    async (shortAppId, title, handOff) => {
      const { steps, log } = await runFolderGame(
        shortAppId,
        title,
        "srmtestcrashinggame",
        // (9 seconds: the wait for the game to come back ends there)
        0.15,
        // (about 2 seconds: always seen, gone before the 3 second check)
        (gameExe) =>
          `@echo off\r\nstart "" /b "${gameExe}" -n 3 127.0.0.1 >nul\r\n`,
        handOff,
      );
      const at = (text: string) => log.indexOf(text);
      expect(at("the game closed again during start-up")).toBeGreaterThan(-1);
      expect(
        at("the game didn't come back: it ran and exited"),
      ).toBeGreaterThan(at("the game closed again during start-up"));
      expect(at("game started")).toBeGreaterThan(
        at("the game didn't come back"),
      );
      expect(log).toContain("game exited");
      expect(log).not.toContain("handed its start");
      expect(log).not.toContain("the game didn't start");
      expect(steps).toEqual(["post-launch 0", "post-exit 0"]);
    },
    120000,
  );

  it.runIf(windows)(
    "a game that restarts itself after a pause is waited for",
    async () => {
      const { steps, log } = await runFolderGame(
        "126",
        "Restarting Game",
        "srmtestrestartgame",
        0.5,
        // (about 2 seconds, gone for about 6 (longer than the 3 second
        // check, which comes at most about 5.5 seconds in), then about 10)
        (gameExe) =>
          `@echo off\r\nstart "" /b "${gameExe}" -n 3 127.0.0.1 >nul\r\n` +
          `ping -n 9 127.0.0.1 >nul\r\n` +
          `start "" /b "${gameExe}" -n 11 127.0.0.1 >nul\r\n`,
      );
      const gone = log.indexOf("the game closed again during start-up");
      expect(gone).toBeGreaterThan(-1);
      expect(gone).toBeLessThan(log.indexOf("game started"));
      expect(log).toContain("game exited");
      expect(log).not.toContain("the game didn't come back");
      expect(log).not.toContain("the game didn't start");
      expect(steps).toEqual(["post-launch 1", "post-exit 0"]);
    },
    120000,
  );
});
