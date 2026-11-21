import { execFile } from "child_process";
import * as path from "path";

// Windows' lists of installed programs (Settings > Apps > Installed apps):
// the machine-wide list as 64-bit and as 32-bit programs see it, and the
// user's own.
export const uninstallLists: { key: string; flags: string[] }[] = [
  {
    key: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    flags: ["/reg:64"],
  },
  {
    key: "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    flags: [],
  },
  {
    key: "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    flags: [],
  },
];

// A registry value: the key it's in (as reg.exe prints it, e.g.
// HKEY_LOCAL_MACHINE\SOFTWARE\...) and its data.
export interface RegistryValue {
  key: string;
  data: string;
}

// The folders installed programs are in (their InstallLocation), from every
// list. One reg.exe per list: the lists hold hundreds of programs, and
// winreg starts a reg.exe for each key it reads. A list that can't be read
// adds nothing; this never rejects.
export async function installLocations(): Promise<string[]> {
  const lists = await Promise.all(
    uninstallLists.map(({ key, flags }) => queryInstallLocations(key, flags)),
  );
  return lists.flat();
}

// The `value` values of every installed program, from every list, with the
// program's key. Never rejects.
export async function installedProgramValues(
  value: string,
): Promise<RegistryValue[]> {
  const lists = await Promise.all(
    uninstallLists.map(({ key, flags }) =>
      queryRegistryValues(key, value, flags),
    ),
  );
  return lists.flat();
}

// The InstallLocation values under `key` (`flags` are reg.exe's, e.g.
// /reg:64). `key` and `flags` must not hold quotes, & or %: they go through
// cmd.exe.
export function queryInstallLocations(key: string, flags: string[]) {
  return queryRegistryValues(key, "InstallLocation", flags).then(
    installLocationsOf,
  );
}

// The `value` values in `key` and the keys below it, in reg.exe's order
// (`flags` are reg.exe's, e.g. /reg:32). None when the key can't be read;
// never rejects. `key`, `value` and `flags` must not hold quotes, & or %:
// they go through cmd.exe.
export function queryRegistryValues(
  key: string,
  value: string,
  flags: string[],
) {
  return new Promise<RegistryValue[]>((resolve) => {
    try {
      // reg.exe writes its console's code page, the system's OEM one in the
      // hidden console it gets, which loses every non-ASCII character of a
      // folder's name. chcp 65001 makes that console UTF-8 first.
      const query = ["query", key, "/s", "/v", value, ...flags]
        .map((arg) => `"${arg}"`)
        .join(" ");
      execFile(
        system32("cmd.exe"),
        [
          "/d",
          "/s",
          "/c",
          `"chcp 65001>nul & "${system32("reg.exe")}" ${query}"`,
        ],
        {
          windowsHide: true,
          windowsVerbatimArguments: true,
          maxBuffer: 64 * 1024 * 1024,
          timeout: 60000,
        },
        // (cmd exits with reg.exe's code, which is also 1 when no key has
        // the value)
        (error, stdout) =>
          resolve(error ? [] : parseRegQueryValues(stdout, value)),
      );
    } catch (e) {
      resolve([]);
    }
  });
}

function system32(exe: string) {
  return path.win32.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    exe,
  );
}

// `reg query <key> /s /v InstallLocation` prints each program's key, then
//     InstallLocation    REG_SZ    C:\Program Files\Game\
// Returns the values in order, without surrounding quotes or blank ones;
// REG_EXPAND_SZ values get their %VARIABLES% from `env`.
export function parseRegQueryOutput(
  stdout: string,
  env: { [name: string]: string | undefined } = process.env,
): string[] {
  return installLocationsOf(
    parseRegQueryValues(stdout, "InstallLocation", env),
  );
}

function installLocationsOf(values: RegistryValue[]) {
  return values
    .map(({ data }) => data.replace(/^"+|"+$/g, "").trim())
    .filter((location) => location);
}

// `reg query <key> /s /v <value>` prints each key that has the value, then
// the value:
//   HKEY_LOCAL_MACHINE\SOFTWARE\...\Installs\46
//       InstallDir    REG_SZ    D:/UplayLibrary/Far Cry 3/
// Returns the string values (trimmed) in order, each with its key;
// REG_EXPAND_SZ values get their %VARIABLES% from `env`.
export function parseRegQueryValues(
  stdout: string,
  value: string,
  env: { [name: string]: string | undefined } = process.env,
): RegistryValue[] {
  const name = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const valueLine = new RegExp(
    `^\\s+${name}\\s+(REG_SZ|REG_EXPAND_SZ)\\b(.*)$`,
    "i",
  );
  const values: RegistryValue[] = [];
  let key = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      key = line.trim();
      continue;
    }
    const match = line.match(valueLine);
    if (!match) continue;
    let data = match[2].trim();
    if (match[1].toUpperCase() === "REG_EXPAND_SZ") {
      data = expandVariables(data, env);
    }
    values.push({ key, data });
  }
  return values;
}

function expandVariables(
  value: string,
  env: { [name: string]: string | undefined },
) {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    // (Windows' variable names ignore case)
    const key = Object.keys(env).find(
      (k) => k.toLowerCase() === name.toLowerCase(),
    );
    return key !== undefined && env[key] !== undefined ? env[key] : whole;
  });
}
