// The programs SRM's launcher-mode parsers start games with on Windows.
// Steam shortcut ids come from the program and the title, so the shortcut
// of a game a store account owns (src/lib/stores/targets.ts) uses the same
// program as the parser that later finds the game installed: its id, and
// with it the artwork and exceptions, then stays the same.

export const POWERSHELL_EXE =
  "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

// (as the UWP parser's launcher mode)
export const EXPLORER_EXE = "C:\\WINDOWS\\explorer.exe";

// PowerShell's arguments to open a link (a launcher's protocol) without
// showing a window. Epic and EA games start this way.
export function powershellOpen(link: string) {
  return `-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"${link}\\""`;
}
