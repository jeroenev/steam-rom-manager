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
});
