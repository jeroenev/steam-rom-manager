// The programs SRM's launcher-mode parsers start games with on Windows.
// Steam shortcut ids come from the program and the title, so the shortcut
// of a game a store account owns (src/lib/stores/targets.ts) uses the same
// program as the parser that later finds the game installed: its id, and
// with it the artwork and exceptions, then stays the same.
import * as path from "path";

export const POWERSHELL_EXE =
  "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

// (as the UWP parser's launcher mode)
export const EXPLORER_EXE = "C:\\WINDOWS\\explorer.exe";

// The Windows folder from SystemRoot. Wherever Windows is in C:\WINDOWS (in
// any case), or SystemRoot isn't set, the folder as SRM always wrote it: a
// shortcut's app id comes from its program's path (and title).
function windowsFolder(systemRoot: string | undefined) {
  const root = (systemRoot || "").replace(/[\\/]+$/, "");
  return root && root.toLowerCase() !== "c:\\windows" ? root : "C:\\WINDOWS";
}

// PowerShell where this Windows has it (the EA Desktop parser's launcher
// mode): POWERSHELL_EXE in C:\WINDOWS.
export function powershellPath(systemRoot: string | undefined): string {
  return path.win32.join(
    windowsFolder(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

// explorer.exe where this Windows has it: EXPLORER_EXE in C:\WINDOWS.
export function explorerPath(systemRoot: string | undefined): string {
  return path.win32.join(windowsFolder(systemRoot), "explorer.exe");
}

// PowerShell's arguments to open a link (a launcher's protocol) without
// showing a window. Epic and EA games start this way.
export function powershellOpen(link: string) {
  return `-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"${link}\\""`;
}
