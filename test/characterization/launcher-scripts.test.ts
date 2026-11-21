// The scripts that "Wait for the game to exit" adds for EA app and Ubisoft
// Connect games, run for real in Windows PowerShell. They never meet a real
// launcher here: the launcher's process name is made up, and where a
// launcher has to run, it's a copy of ping.exe under a made-up name in a
// temporary folder. Settings files and logs are temporary files too.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  installLaunchScripts,
  launchLog,
  makeLaunchWrapper,
  parserScript,
  writeWrapperFile,
  wrapperFile,
} from "../../src/lib/launch-wrapper";
import {
  eaWaitForExitWrapper,
  ubisoftWaitForExitWrapper,
} from "../../src/lib/launch-wrapper/launchers";
import { LaunchScript } from "../../src/models";
import { tempDir } from "../helpers/fixtures";

const windows = process.platform === "win32";
const noLauncher = "srm-test-no-such-launcher";
const hide = "closebehavior: CloseBehavior_Minimize";
const quit = "closebehavior: CloseBehavior_Close";

const powershellArgs = (script: string, args: string[]) => [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  parserScript(script),
  ...args,
];

// Runs one of the installed scripts; its output and how long it took.
function run(script: string, args: string[]) {
  const started = Date.now();
  const result = spawnSync("powershell.exe", powershellArgs(script, args), {
    encoding: "utf8",
    timeout: 120000,
  });
  expect(result.status, result.stderr).toBe(0);
  return { output: result.stdout, seconds: (Date.now() - started) / 1000 };
}

// The same, without waiting (to change a file while it runs).
function runAsync(script: string, args: string[]) {
  const started = Date.now();
  const child = spawn("powershell.exe", powershellArgs(script, args));
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  return new Promise<{ output: string; seconds: number }>((resolve) =>
    child.on("exit", () =>
      resolve({ output, seconds: (Date.now() - started) / 1000 }),
    ),
  );
}

const root = windows ? tempDir("launcher-scripts") : "";
let dirs = 0;
const newDir = (name: string) => {
  const dir = path.join(root, `${name}-${++dirs}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const markers = (dir: string) => fs.readdirSync(dir).sort();

const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
// A copy of a program of Windows' at <folder>\<name>.exe.
function copyProgram(program: string, folder: string, name: string) {
  fs.mkdirSync(folder, { recursive: true });
  const exe = path.join(folder, `${name}.exe`);
  if (!fs.existsSync(exe)) fs.copyFileSync(path.join(system32, program), exe);
  return exe;
}

// A program that keeps running for a while: ping.exe, copied to
// <folder>\<name>.exe.
const programs: ChildProcess[] = [];
function startProgram(folder: string, name: string) {
  const exe = copyProgram("PING.EXE", folder, name);
  const child = spawn(exe, ["-n", "300", "127.0.0.1"], {
    stdio: "ignore",
    windowsHide: true,
  });
  programs.push(child);
  return child;
}
const running = (child: ChildProcess) => {
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Programs that programs here started (no handle to end them by): ended
// by name after the tests.
const startedByOthers: string[] = [];
// A launcher that started a program and waits for it (a game it started):
// cmd.exe copied to <folder>\<name>.exe, running a copy of ping.exe at
// <childFolder>\<child>.exe.
function startLauncherWithChild(
  folder: string,
  name: string,
  childFolder: string,
  child: string,
) {
  const exe = copyProgram("cmd.exe", folder, name);
  const childExe = copyProgram("PING.EXE", childFolder, child);
  startedByOthers.push(child);
  const launcher = spawn(exe, ["/c", childExe, "-n", "300", "127.0.0.1"], {
    stdio: "ignore",
    windowsHide: true,
  });
  programs.push(launcher);
  return launcher;
}
// How many programs of this name run.
const count = (name: string) =>
  Number(
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `@(Get-Process '${name}' -ErrorAction SilentlyContinue).Count`,
      ],
      { encoding: "utf8" },
    ).stdout.trim(),
  );
// Waits up to 10 seconds for a program of this name to run.
async function started(name: string) {
  for (let i = 0; i < 50 && !count(name); i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(count(name)).toBe(1);
}

describe.runIf(windows)("launcher scripts (EA app, Ubisoft Connect)", () => {
  beforeAll(() => installLaunchScripts());
  afterAll(() => {
    for (const child of programs) child.kill();
    if (startedByOthers.length) {
      spawnSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Stop-Process -Name ${startedByOthers.map((name) => `'${name}'`).join(",")} -Force -ErrorAction SilentlyContinue`,
      ]);
    }
    // (a moment for the copies of ping.exe to go)
    spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep 1"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("Ubisoft Connect's close setting", () => {
    const original =
      "misc:\r\n" +
      `  ${hide}\r\n` +
      "  language: Français\r\n" +
      "user:\r\n" +
      "    closebehavior: other\r\n";
    const settings = (text = original) => {
      const file = path.join(newDir("settings"), "settings.yaml");
      fs.writeFileSync(file, text, "utf8");
      return file;
    };
    const options = (file: string, state: string, runDir: string) => [
      "-SettingsFile",
      file,
      "-StateDir",
      state,
      "-RunDir",
      runDir,
      "-ProcessName",
      noLauncher,
    ];
    const lasting = (state: string) =>
      fs.existsSync(
        path.join(state, "ubisoft-connect-closebehavior-changed.txt"),
      );

    it("says quit while a launch has it running, then back; indentation, line endings and encoding intact", () => {
      const file = settings();
      const state = newDir("state");
      const runDir = newDir("run");
      const game = newDir("game");
      const opts = options(file, state, runDir);

      const start = run("ubisoft-connect-start.ps1", [
        "-GameFolder",
        game,
        ...opts,
      ]);
      expect(start.output).toContain("This launch starts Ubisoft Connect");
      expect(fs.readFileSync(file, "utf8")).toBe(
        original.replace(`  ${hide}\r\n`, `  ${quit}\r\n`),
      );
      expect(lasting(state)).toBe(true);
      run("ubisoft-connect-start.ps1", ["-Mark", ...opts]);
      expect(markers(runDir)).toEqual([
        "ubisoft-connect-started",
        "ubisoft-game-started",
        "ubisoft-setting-changed",
      ]);

      const stop = run("ubisoft-connect-stop.ps1", [
        "-GameFolder",
        game,
        "-GraceSeconds",
        "0",
        ...opts,
      ]);
      expect(stop.output).toContain("The launcher is not running");
      expect(stop.output).toContain("Changed");
      // (byte for byte: no byte order mark added, UTF-8 kept)
      expect(fs.readFileSync(file)).toEqual(Buffer.from(original, "utf8"));
      expect(lasting(state)).toBe(false);
    }, 60000);

    it("is left alone when the line is missing, or there twice", () => {
      for (const text of [
        original.replace(`  ${hide}\r\n`, ""),
        original + `  ${hide}\r\n`,
        original.replace(hide, quit),
      ]) {
        const file = settings(text);
        const state = newDir("state");
        const runDir = newDir("run");
        const start = run(
          "ubisoft-connect-start.ps1",
          options(file, state, runDir),
        );
        expect(start.output).toContain("left as it is");
        expect(fs.readFileSync(file, "utf8")).toBe(text);
        expect(markers(runDir)).toEqual(["ubisoft-connect-started"]);
        expect(lasting(state)).toBe(false);
      }
    }, 60000);

    it("a later launch changes back what a launch cut short left changed, even when its game never starts", () => {
      const file = settings();
      const state = newDir("state");
      // a launch that Steam's Stop ended: no post-exit
      run("ubisoft-connect-start.ps1", options(file, state, newDir("run")));
      expect(fs.readFileSync(file, "utf8")).toContain(quit);

      const runDir = newDir("run");
      const start = run(
        "ubisoft-connect-start.ps1",
        options(file, state, runDir),
      );
      expect(start.output).toContain("left by an earlier launch");
      expect(markers(runDir)).toEqual([
        "ubisoft-connect-started",
        "ubisoft-setting-changed",
      ]);
      // (no -Mark: the game didn't start; Ubisoft Connect isn't running)
      const stop = run("ubisoft-connect-stop.ps1", [
        "-GameFolder",
        newDir("game"),
        ...options(file, state, runDir),
      ]);
      expect(stop.output).toContain("The game did not start");
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      expect(lasting(state)).toBe(false);
    }, 60000);

    it("a Ubisoft Connect this launch started stays open while the game hasn't started, and is closed after it; the setting is changed back once it's gone", () => {
      const file = settings();
      const state = newDir("state");
      const runDir = newDir("run");
      const opts = [
        "-GameFolder",
        newDir("game"),
        "-SettingsFile",
        file,
        "-StateDir",
        state,
        "-RunDir",
        runDir,
        "-ProcessName",
        "srmtestownupc",
      ];
      run("ubisoft-connect-start.ps1", opts);
      // the launch starts Ubisoft Connect...
      const upc = startProgram(
        newDir("Ubisoft Game Launcher"),
        "srmtestownupc",
      );
      // ...which hasn't started the game (yet)
      let stop = run("ubisoft-connect-stop.ps1", [
        "-GraceSeconds",
        "0",
        ...opts,
      ]);
      expect(stop.output).toContain("The game did not start");
      expect(stop.output).toContain("stays until a later launch");
      expect(running(upc)).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toContain(quit);
      expect(lasting(state)).toBe(true);

      run("ubisoft-connect-start.ps1", ["-Mark", ...opts]);
      stop = run("ubisoft-connect-stop.ps1", [
        "-GraceSeconds",
        "0",
        "-CloseSeconds",
        "5",
        ...opts,
      ]);
      expect(stop.output).toContain("Ending the launcher (1 programs)");
      expect(running(upc)).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      expect(lasting(state)).toBe(false);
    }, 60000);

    it("an open Ubisoft Connect is left alone, and its setting too", () => {
      const file = settings();
      const state = newDir("state");
      const runDir = newDir("run");
      const upc = startProgram(newDir("ubisoft"), "srmtestupc");
      const opts = [
        "-SettingsFile",
        file,
        "-StateDir",
        state,
        "-RunDir",
        runDir,
        "-ProcessName",
        "srmtestupc",
      ];
      expect(run("ubisoft-connect-start.ps1", opts).output).toContain(
        "Ubisoft Connect is open",
      );
      run("ubisoft-connect-start.ps1", ["-Mark", ...opts]);
      const stop = run("ubisoft-connect-stop.ps1", [
        "-GraceSeconds",
        "0",
        ...opts,
      ]);
      expect(stop.output).toContain("open before the launch");
      expect(running(upc)).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      expect(lasting(state)).toBe(false);
    }, 60000);
  });

  describe("closing a launcher this launch started", () => {
    it("only once the game started and has gone; every program in its folder but the EA app's service, none below it", () => {
      const folder = newDir("EA Desktop");
      const game = newDir("Game");
      const log = path.join(newDir("logs"), "EADesktop.log");
      fs.writeFileSync(log, "");
      const opts = (runDir: string) => [
        "-GameFolder",
        game,
        "-Log",
        log,
        "-SyncStartSeconds",
        "0",
        "-ProcessName",
        "srmtesteadesktop",
        "-CloseSeconds",
        "5",
        "-RunDir",
        runDir,
      ];
      const main = startProgram(folder, "srmtesteadesktop");
      const helper = startProgram(folder, "srmtesteahelper");
      const service = startProgram(folder, "EABackgroundService");
      const below = startProgram(path.join(folder, "games", "X"), "srmtestx");

      // the EA app was open: left open
      let runDir = newDir("run");
      expect(run("ea-app-start.ps1", opts(runDir)).output).toContain(
        "The EA app is open",
      );
      run("ea-app-start.ps1", ["-Mark", ...opts(runDir)]);
      run("ea-app-stop.ps1", opts(runDir));
      expect(running(main)).toBe(true);

      // started by this launch, but the game never started: left open
      runDir = newDir("run");
      fs.writeFileSync(path.join(runDir, "ea-app-started"), "");
      expect(run("ea-app-stop.ps1", opts(runDir)).output).toContain(
        "The game did not start",
      );
      expect(running(main)).toBe(true);

      // the game runs (again): left open
      fs.writeFileSync(path.join(runDir, "ea-game-started"), "");
      const gameProgram = startProgram(path.join(game, "bin"), "srmtestgame");
      expect(run("ea-app-stop.ps1", opts(runDir)).output).toContain(
        "The game runs again",
      );
      expect(running(main)).toBe(true);

      // the game has gone: closed
      gameProgram.kill();
      const stop = run("ea-app-stop.ps1", opts(runDir));
      // (the close request works: no window titled "EA" to ask)
      expect(stop.output).not.toContain("Could not ask");
      expect(stop.output).toContain("Ending the launcher (2 programs)");
      expect(running(main)).toBe(false);
      expect(running(helper)).toBe(false);
      expect(running(service)).toBe(true);
      expect(running(below)).toBe(true);
    }, 90000);

    it("asks the launcher's windows to close, hidden ones too, and doesn't end a launcher that quits", async () => {
      // A launcher with a hidden window: Windows PowerShell (copied under
      // a made-up name) showing a form, then hiding it.
      const folder = newDir("Launcher");
      const exe = path.join(folder, "srmtestwindowapp.exe");
      fs.copyFileSync(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        exe,
      );
      const ready = path.join(folder, "ready");
      const form = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$form = New-Object Windows.Forms.Form",
        "$form.Text = 'SRM test window'",
        "$form.ShowInTaskbar = $False",
        `$form.Add_Shown({ $form.Hide(); [IO.File]::WriteAllText('${ready}', '') })`,
        "[Windows.Forms.Application]::Run($form)",
      ].join("; ");
      const launcher = spawn(exe, ["-NoProfile", "-Command", form], {
        stdio: "ignore",
        windowsHide: true,
      });
      programs.push(launcher);
      for (let i = 0; i < 100 && !fs.existsSync(ready); i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(fs.existsSync(ready)).toBe(true);

      const runDir = newDir("run");
      for (const marker of ["ea-app-started", "ea-game-started"]) {
        fs.writeFileSync(path.join(runDir, marker), "");
      }
      const stop = run("ea-app-stop.ps1", [
        "-GameFolder",
        newDir("game"),
        "-Log",
        path.join(folder, "no-such.log"),
        "-SyncStartSeconds",
        "0",
        "-ProcessName",
        "srmtestwindowapp",
        "-WindowTitle",
        "SRM test window",
        "-RunDir",
        runDir,
      ]);
      expect(stop.output).toContain(
        "Asking the launcher to close (1 windows titled 'SRM test window')",
      );
      expect(stop.output).toContain("The launcher closed");
      expect(stop.output).not.toContain("Ending the launcher");
      expect(running(launcher)).toBe(false);
    }, 90000);

    it("with -Restart, an open launcher is closed before the launch, unless the game already runs", () => {
      const folder = newDir("Ubisoft Game Launcher");
      const game = newDir("Game");
      const file = path.join(newDir("settings"), "settings.yaml");
      fs.writeFileSync(file, `misc:\n  ${hide}\n`);
      const opts = (runDir: string) => [
        "-GameFolder",
        game,
        "-Restart",
        "-SettingsFile",
        file,
        "-StateDir",
        newDir("state"),
        "-ProcessName",
        "srmtestrestartupc",
        "-CloseSeconds",
        "5",
        "-RunDir",
        runDir,
      ];
      const upc = startProgram(folder, "srmtestrestartupc");
      const gameProgram = startProgram(game, "srmtestgame");
      let runDir = newDir("run");
      expect(run("ubisoft-connect-start.ps1", opts(runDir)).output).toContain(
        "The game already runs",
      );
      expect(running(upc)).toBe(true);
      expect(markers(runDir)).toEqual([]);

      gameProgram.kill();
      runDir = newDir("run");
      const start = run("ubisoft-connect-start.ps1", opts(runDir));
      expect(start.output).toContain("Ending the launcher (1 programs)");
      expect(running(upc)).toBe(false);
      expect(markers(runDir)).toEqual([
        "ubisoft-connect-started",
        "ubisoft-setting-changed",
      ]);
      expect(fs.readFileSync(file, "utf8")).toBe(`misc:\n  ${quit}\n`);
    }, 90000);

    it("with -Restart, an open EA app is closed before the launch (never its service), unless the game already runs", () => {
      const folder = newDir("EA Desktop");
      const game = newDir("Game");
      const opts = (runDir: string) => [
        "-GameFolder",
        game,
        "-ExeName",
        "srmtestrestarteagame.exe",
        "-Restart",
        "-Log",
        path.join(folder, "no-such.log"),
        "-ProcessName",
        "srmtestrestartea",
        "-CloseSeconds",
        "5",
        "-RunDir",
        runDir,
      ];
      const main = startProgram(folder, "srmtestrestartea");
      const helper = startProgram(folder, "srmtestrestarteahelper");
      // (in the same folder: ended too, were it not spared by its name)
      const service = startProgram(folder, "EABackgroundService");
      const gameProgram = startProgram(
        path.join(game, "bin"),
        "srmtestrestarteagame",
      );
      let runDir = newDir("run");
      expect(run("ea-app-start.ps1", opts(runDir)).output).toContain(
        "The game already runs",
      );
      expect(running(main)).toBe(true);
      expect(running(helper)).toBe(true);
      expect(running(service)).toBe(true);
      expect(markers(runDir)).toEqual([]);

      gameProgram.kill();
      runDir = newDir("run");
      const start = run("ea-app-start.ps1", opts(runDir));
      expect(start.output).not.toContain("Could not ask");
      expect(start.output).toContain("Ending the launcher (2 programs)");
      expect(start.output).toContain("This launch starts the EA app");
      expect(running(main)).toBe(false);
      expect(running(helper)).toBe(false);
      expect(running(service)).toBe(true);
      expect(markers(runDir)).toEqual(["ea-app-started"]);
    }, 90000);

    describe("a launcher that another game it started still needs", () => {
      it("the EA app: left open after the game, and not restarted before it", async () => {
        const folder = newDir("busy-ea");
        const launcher = startLauncherWithChild(
          folder,
          "srmtestbusyea",
          newDir("other-game"),
          "srmtestbusyeagame",
        );
        await started("srmtestbusyeagame");
        const game = newDir("game");
        const opts = (runDir: string) => [
          "-GameFolder",
          game,
          "-Log",
          path.join(folder, "no-such.log"),
          "-ProcessName",
          "srmtestbusyea",
          "-CloseSeconds",
          "2",
          "-RunDir",
          runDir,
        ];

        let runDir = newDir("run");
        for (const marker of ["ea-app-started", "ea-game-started"]) {
          fs.writeFileSync(path.join(runDir, marker), "");
        }
        fs.writeFileSync(path.join(runDir, "ea-log-length"), "0");
        const stop = run("ea-app-stop.ps1", [
          "-SyncStartSeconds",
          "0.5",
          ...opts(runDir),
        ]);
        expect(stop.output).toContain(
          "Another game the EA app started still runs: leaving the EA app open",
        );
        expect(stop.output).not.toContain("Ending the launcher");
        expect(running(launcher)).toBe(true);
        expect(count("srmtestbusyeagame")).toBe(1);

        runDir = newDir("run");
        const start = run("ea-app-start.ps1", ["-Restart", ...opts(runDir)]);
        expect(start.output).toContain(
          "Another game the EA app started runs: leaving the EA app open",
        );
        expect(running(launcher)).toBe(true);
        expect(markers(runDir)).toEqual([]);
      }, 90000);

      it("not the EA app's own programs (in its folder or below it): it's closed", async () => {
        const folder = newDir("own-ea");
        const launcher = startLauncherWithChild(
          folder,
          "srmtestownea",
          path.join(folder, "legacyPM"),
          "srmtestowneahelper",
        );
        await started("srmtestowneahelper");
        const runDir = newDir("run");
        for (const marker of ["ea-app-started", "ea-game-started"]) {
          fs.writeFileSync(path.join(runDir, marker), "");
        }
        const stop = run("ea-app-stop.ps1", [
          "-GameFolder",
          newDir("game"),
          "-Log",
          path.join(folder, "no-such.log"),
          "-SyncStartSeconds",
          "0",
          "-ProcessName",
          "srmtestownea",
          "-CloseSeconds",
          "5",
          "-RunDir",
          runDir,
        ]);
        expect(stop.output).not.toContain("Another game");
        expect(stop.output).toContain("Ending the launcher (1 programs)");
        expect(running(launcher)).toBe(false);
      }, 90000);

      it("Ubisoft Connect (a game in its games folder): left open after the game, and not restarted before it", async () => {
        const folder = newDir("busy-ubisoft");
        const launcher = startLauncherWithChild(
          folder,
          "srmtestbusyupc",
          path.join(folder, "games", "Other Game"),
          "srmtestbusyubigame",
        );
        await started("srmtestbusyubigame");
        const file = path.join(newDir("settings"), "settings.yaml");
        fs.writeFileSync(file, `misc:\r\n  ${quit}\r\n`);
        const opts = (runDir: string) => [
          "-GameFolder",
          newDir("game"),
          "-SettingsFile",
          file,
          "-StateDir",
          newDir("state"),
          "-ProcessName",
          "srmtestbusyupc",
          "-CloseSeconds",
          "2",
          "-RunDir",
          runDir,
        ];

        let runDir = newDir("run");
        for (const marker of [
          "ubisoft-connect-started",
          "ubisoft-game-started",
        ]) {
          fs.writeFileSync(path.join(runDir, marker), "");
        }
        const stop = run("ubisoft-connect-stop.ps1", [
          "-GraceSeconds",
          "0",
          ...opts(runDir),
        ]);
        expect(stop.output).toContain(
          "Another game Ubisoft Connect started still runs: leaving Ubisoft Connect open",
        );
        expect(stop.output).not.toContain("Ending the launcher");
        expect(running(launcher)).toBe(true);
        expect(count("srmtestbusyubigame")).toBe(1);

        runDir = newDir("run");
        const start = run("ubisoft-connect-start.ps1", [
          "-Restart",
          ...opts(runDir),
        ]);
        expect(start.output).toContain(
          "Another game Ubisoft Connect started runs: leaving Ubisoft Connect open",
        );
        expect(running(launcher)).toBe(true);
        expect(markers(runDir)).toEqual([]);
      }, 90000);
    });
  });

  it("only counts programs of this Windows session (not another signed-in user's)", () => {
    // A program that runs only in other sessions (services.exe, in session
    // 0, when the tests run in a user's session). Looked at only: never
    // closed.
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        [
          `. '${parserScript("launcher-helpers.ps1")}'`,
          "$me = [Diagnostics.Process]::GetCurrentProcess().SessionId",
          "$other = @(Get-Process | Group-Object ProcessName | Where-Object { !@($_.Group | Where-Object { $_.SessionId -eq $me }).Count } | ForEach-Object { $_.Name })",
          "$name = If ($other -contains 'services') { 'services' } Else { $other | Select-Object -First 1 }",
          "If (!$name) { 'none' } Else { '{0} {1} {2}' -f $name, (Test-LauncherRunning $name), @(Get-LauncherProcesses $name @() @()).Count }",
        ].join("; "),
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const out = result.stdout.trim();
    // (none on a machine with a single session: nothing to show then)
    if (out !== "none") expect(out).toMatch(/^\S+ False 0$/);
  }, 60000);

  describe("the EA app's cloud sync after the game", () => {
    const oldLines = [
      "INFO (ProcessCoordinator::FsmHost::doSyncSaveDataBeforeGameOpen) Cloud Sync entry point pre game launch",
      "INFO (ProcessCoordinator::handleCloudSyncStatusUpdate) Cloud sync completed successfully",
      "INFO (ProcessCoordinator::FsmHost::doSyncSaveDataAfterGameClose) Cloud Sync entry point post game termination",
      "INFO (ProcessCoordinator::handleTerminalCloudSyncStatus) Post game cloud sync completed successfully",
      "",
    ].join("\r\n");
    const syncStarted =
      "INFO (ProcessCoordinator::FsmHost::doSyncSaveDataAfterGameClose) Cloud Sync entry point post game termination\r\n";
    const syncDone =
      "INFO (ProcessCoordinator::handleTerminalCloudSyncStatus) Post game cloud sync completed successfully\r\n";

    // A launch that started the EA app and the game, with the log as it
    // was when the game started.
    function launch() {
      const log = path.join(newDir("logs"), "EADesktop.log");
      fs.writeFileSync(log, oldLines);
      const runDir = newDir("run");
      const opts = [
        "-GameFolder",
        newDir("game"),
        "-Log",
        log,
        "-ProcessName",
        noLauncher,
        "-RunDir",
        runDir,
      ];
      run("ea-app-start.ps1", opts);
      run("ea-app-start.ps1", ["-Mark", ...opts]);
      expect(markers(runDir)).toEqual([
        "ea-app-folders",
        "ea-app-started",
        "ea-game-started",
        "ea-log-length",
      ]);
      return { log, opts };
    }

    it("no sync after the game (lines from before it don't count): stops waiting after the start wait", () => {
      const { opts } = launch();
      const stop = run("ea-app-stop.ps1", [
        ...opts,
        "-SyncStartSeconds",
        "2",
        "-SyncSeconds",
        "30",
      ]);
      expect(stop.output).toContain("No cloud sync started within 2 seconds");
      expect(stop.seconds).toBeGreaterThanOrEqual(2);
      expect(stop.seconds).toBeLessThan(20);
    }, 60000);

    it("a sync that started gets longer, but not forever", () => {
      const { log, opts } = launch();
      fs.appendFileSync(log, syncStarted);
      const stop = run("ea-app-stop.ps1", [
        ...opts,
        "-SyncStartSeconds",
        "1",
        "-SyncSeconds",
        "3",
      ]);
      expect(stop.output).toContain("did not end within 3 seconds");
      expect(stop.seconds).toBeGreaterThanOrEqual(3);
    }, 60000);

    it("returns once the log says the sync is done", async () => {
      const { log, opts } = launch();
      const stopping = runAsync("ea-app-stop.ps1", [
        ...opts,
        "-SyncStartSeconds",
        "30",
        "-SyncSeconds",
        "60",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      fs.appendFileSync(log, syncStarted);
      fs.appendFileSync(log, syncDone);
      const stop = await stopping;
      expect(stop.output).toContain("The EA app's cloud sync is done");
      expect(stop.output).toContain("The launcher is not running");
      expect(stop.seconds).toBeLessThan(20);
    }, 60000);

    it("a log that started over is read from its start", () => {
      const { log, opts } = launch();
      fs.writeFileSync(log, syncDone);
      const stop = run("ea-app-stop.ps1", [...opts, "-SyncStartSeconds", "30"]);
      expect(stop.output).toContain("The EA app's cloud sync is done");
      expect(stop.seconds).toBeLessThan(20);
    }, 60000);
  });

  it("through SRM's launch script: a launcher the launch started is closed after the game", async () => {
    // The launch starts the "launcher", which starts the "game" (copies of
    // ping.exe; the game runs about 4 seconds).
    const ping = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "PING.EXE",
    );
    const launcherExe = path.join(newDir("EA Desktop"), "srmtestlaunchea.exe");
    const gameDir = newDir("Game Folder");
    const gameExe = path.join(gameDir, "srmtestlaunchgame.exe");
    fs.copyFileSync(ping, launcherExe);
    fs.copyFileSync(ping, gameExe);
    const launch = path.join(newDir("launch"), "launch.cmd");
    fs.writeFileSync(
      launch,
      `@echo off\r\nstart "" /b "${launcherExe}" -n 120 127.0.0.1 >nul\r\n` +
        `start "" /b "${gameExe}" -n 5 127.0.0.1 >nul\r\n`,
    );

    // The EA app's wrapper, its launch replaced and its scripts pointed
    // at the fake launcher.
    const parser = eaWaitForExitWrapper({
      contentId: "srm.test",
      folder: gameDir,
      exeName: "srmtestlaunchgame.exe",
    });
    const fake = (steps: LaunchScript[], ...more: string[]) =>
      steps.map((step) => ({
        ...step,
        args: [
          ...step.args,
          "-ProcessName",
          "srmtestlaunchea",
          "-Log",
          path.join(root, "no-such.log"),
          ...more,
        ],
      }));
    await installLaunchScripts();
    await writeWrapperFile("22222222", "456", {
      title: "EA Test Game",
      wrapper: makeLaunchWrapper('"C:\\unused.exe"', undefined, {
        ...parser,
        launch: { file: launch },
        preLaunch: fake(parser.preLaunch),
        postLaunch: fake(parser.postLaunch),
        postExit: fake(parser.postExit, "-SyncStartSeconds", "1"),
      }),
      launchOptions: "",
      startInDirectory: "",
    });
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        wrapperFile("22222222", "456"),
      ],
      { encoding: "utf8", timeout: 120000 },
    );
    expect(result.status, result.stderr).toBe(0);

    const log = fs
      .readFileSync(launchLog(), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("[EA Test Game]"))
      .join("\n");
    for (const step of [
      "This launch starts the EA app; it is closed after the game",
      "game started",
      "game exited",
      "No cloud sync started within 1 seconds",
      "Ending the launcher (1 programs)",
    ]) {
      expect(log).toContain(step);
    }
    expect(log).not.toContain("failed");
    const left = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "@(Get-Process srmtestlaunch* -ErrorAction SilentlyContinue).Count",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  }, 120000);

  it("through SRM's launch script: a game that never starts leaves the launcher open, and its wait is the parser's", async () => {
    // The launch starts only the "launcher" (a copy of ping.exe): nothing
    // ever runs from the game's folder.
    const launcherExe = copyProgram(
      "PING.EXE",
      newDir("Ubisoft Game Launcher"),
      "srmtestneverupc",
    );
    startedByOthers.push("srmtestneverupc");
    const gameDir = newDir("Game Folder");
    const launch = path.join(newDir("launch"), "launch.cmd");
    fs.writeFileSync(
      launch,
      `@echo off\r\nstart "" /b "${launcherExe}" -n 120 127.0.0.1 >nul\r\n`,
    );
    const file = path.join(newDir("settings"), "settings.yaml");
    fs.writeFileSync(file, `misc:\r\n  ${hide}\r\n`);
    const state = newDir("state");

    // Ubisoft Connect's wrapper, its launch replaced, its scripts pointed
    // at the fake launcher and temporary files, and its wait for the game
    // cut to 3 seconds.
    const parser = ubisoftWaitForExitWrapper("srm.test", gameDir);
    const fake = (steps: LaunchScript[], ...more: string[]) =>
      steps.map((step) => ({
        ...step,
        args: [
          ...step.args,
          "-SettingsFile",
          file,
          "-StateDir",
          state,
          "-ProcessName",
          "srmtestneverupc",
          ...more,
        ],
      }));
    await installLaunchScripts();
    await writeWrapperFile("33333333", "789", {
      title: "Ubisoft Never Game",
      wrapper: makeLaunchWrapper('"C:\\unused.exe"', undefined, {
        ...parser,
        launch: { file: launch },
        game: { ...parser.game, startTimeoutMinutes: 0.05 },
        preLaunch: fake(parser.preLaunch),
        postLaunch: fake(parser.postLaunch),
        postExit: fake(parser.postExit, "-GraceSeconds", "0"),
      }),
      launchOptions: "",
      startInDirectory: "",
    });
    const began = Date.now();
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        wrapperFile("33333333", "789"),
      ],
      // (the default wait, 3 minutes, would end it)
      { encoding: "utf8", timeout: 120000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect((Date.now() - began) / 1000).toBeLessThan(60);

    const log = fs
      .readFileSync(launchLog(), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("[Ubisoft Never Game]"))
      .join("\n");
    for (const step of [
      "This launch starts Ubisoft Connect; it is closed after the game",
      "the game didn't start; skipping post-launch scripts",
      "The game did not start: leaving Ubisoft Connect open",
      "stays until a later launch",
    ]) {
      expect(log).toContain(step);
    }
    expect(log).not.toContain("game started");
    expect(log).not.toContain("Ending the launcher");
    expect(log).not.toContain("failed");
    expect(count("srmtestneverupc")).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(`misc:\r\n  ${quit}\r\n`);
    expect(
      fs.existsSync(
        path.join(state, "ubisoft-connect-closebehavior-changed.txt"),
      ),
    ).toBe(true);
  }, 120000);

  it("does nothing when not run by SRM's launch script", () => {
    for (const script of [
      "ea-app-start.ps1",
      "ea-app-stop.ps1",
      "ubisoft-connect-start.ps1",
      "ubisoft-connect-stop.ps1",
    ]) {
      // (vitest's environment has no SRM_RUN_DIR)
      expect(run(script, ["-ProcessName", noLauncher]).output).toContain(
        "nothing to do",
      );
    }
  }, 60000);
});
