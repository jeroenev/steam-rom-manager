// Ubisoft Connect's local data, shared by the owned-games code
// (src/lib/stores/ubisoft.ts) and, later, the UPlay parser: its encrypted
// caches (.vdat files), its product configurations, and the games it has
// installed. Windows only. Ported from BoilR's platforms/uplay/catalogue.rs.
//
// Ubisoft Connect keeps its caches under %LOCALAPPDATA%\Ubisoft Game
// Launcher\cache, each file a protobuf container:
//   {1: {1: header {1: 1, 2: {1: 1, 2: key id, 3: nonce (12 bytes),
//                             4: tag (16 bytes)}},
//        2: ciphertext}}
// encrypted with AES-256-GCM. The key is store\<key id>.bin next to the
// cache folder, protected with DPAPI for the current Windows user (no
// entropy). Node has no DPAPI, so Windows PowerShell unprotects the key;
// Node's crypto decrypts.
//
// The same key opens user.vdat and ConnectSecureStorage.dat, which hold the
// user's Ubisoft sign-in. Nothing here reads them, and nothing may: only the
// caches SRM needs are opened (see the store's module).

import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import Registry from "winreg";
import { powershellPath } from "./windows";

// Where Ubisoft Connect keeps its data for the current Windows user.
export function ubisoftDataDir(
  localAppData: string | undefined = process.env.LOCALAPPDATA,
): string | undefined {
  return localAppData
    ? path.join(localAppData, "Ubisoft Game Launcher")
    : undefined;
}

// The product configurations (YAML), of every product the account owns and
// more.
export function ubisoftConfigurationsFile(dataDir: string) {
  return path.join(dataDir, "cache", "configuration", "configurations.vdat");
}

// The folder of the ownership caches: one <user id>.vdat per account that
// signed in on this PC.
export function ubisoftOwnershipDir(dataDir: string) {
  return path.join(dataDir, "cache", "ownership");
}

// The cache isn't laid out as SRM knows it: Ubisoft Connect may have changed
// it (it did in 2023, from plain files to .vdat).
export class UbisoftCacheFormat extends Error {
  name = "UbisoftCacheFormat";
}

function unknownFormat(detail: string) {
  return new UbisoftCacheFormat(
    `Ubisoft Connect's cache isn't in a format SRM knows (${detail}). Ubisoft Connect may have changed it.`,
  );
}

// ---- protobuf ----

// One field of a protobuf message: varints (wire type 0) and
// length-delimited values (wire type 2); fixed-size ones are skipped.
export interface ProtoField {
  number: number;
  value?: number;
  bytes?: Buffer;
}

// The fields of a protobuf message, in order. Throws when `bytes` isn't
// one. A varint above 2^53 loses precision: none that SRM reads can be.
export function protoFields(bytes: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let at = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    for (let read = 0; read < 10; read++) {
      if (at >= bytes.length) {
        throw unknownFormat("a number is cut short");
      }
      const byte = bytes[at++];
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        return value;
      }
      scale *= 128;
    }
    throw unknownFormat("a number is too long");
  };
  const skip = (length: number) => {
    if (at + length > bytes.length) {
      throw unknownFormat("a field is cut short");
    }
    at += length;
  };
  while (at < bytes.length) {
    const tag = varint();
    const number = Math.floor(tag / 8);
    if (number === 0) {
      throw unknownFormat("a field has no number");
    }
    switch (tag % 8) {
      case 0:
        fields.push({ number, value: varint() });
        break;
      case 1:
        skip(8);
        break;
      case 2: {
        const length = varint();
        const start = at;
        skip(length);
        fields.push({ number, bytes: bytes.subarray(start, at) });
        break;
      }
      case 5:
        skip(4);
        break;
      default:
        throw unknownFormat(`a field has wire type ${tag % 8}`);
    }
  }
  return fields;
}

// The first length-delimited field `number`.
export function protoBytes(
  fields: readonly ProtoField[],
  number: number,
): Buffer | undefined {
  return fields.find((f) => f.number === number && f.bytes !== undefined)
    ?.bytes;
}

// The first varint field `number`.
export function protoNumber(
  fields: readonly ProtoField[],
  number: number,
): number | undefined {
  return fields.find((f) => f.number === number && f.value !== undefined)
    ?.value;
}

// ---- the .vdat container ----

export interface VdatFile {
  // Names the key file, store\<keyId>.bin.
  keyId: string;
  nonce: Buffer;
  tag: Buffer;
  data: Buffer;
}

// A key id names a file: only plain names.
const PLAIN_KEY_ID = /^[A-Za-z0-9]+$/;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// The parts of an encrypted cache file. Throws UbisoftCacheFormat when it
// isn't laid out as one.
export function readVdat(file: Buffer): VdatFile {
  const part = (
    fields: readonly ProtoField[],
    number: number,
    what: string,
  ): Buffer => {
    const bytes = protoBytes(fields, number);
    if (!bytes) {
      throw unknownFormat(`no ${what}`);
    }
    return bytes;
  };
  const outer = protoFields(part(protoFields(file), 1, "container"));
  const header = protoFields(part(outer, 1, "header"));
  const encryption = protoFields(part(header, 2, "encryption header"));
  const keyId = part(encryption, 2, "key id").toString("latin1");
  const nonce = part(encryption, 3, "nonce");
  const tag = part(encryption, 4, "tag");
  if (!PLAIN_KEY_ID.test(keyId)) {
    throw unknownFormat("its key id isn't a plain name");
  }
  if (nonce.length !== NONCE_LENGTH || tag.length !== TAG_LENGTH) {
    throw unknownFormat("its nonce or tag has an unexpected length");
  }
  return { keyId, nonce, tag, data: part(outer, 2, "encrypted data") };
}

// The key file of a cache file's key id.
export function ubisoftKeyFile(dataDir: string, keyId: string) {
  if (!PLAIN_KEY_ID.test(keyId)) {
    throw unknownFormat("its key id isn't a plain name");
  }
  return path.join(dataDir, "store", `${keyId}.bin`);
}

// The plain text of a cache file, with its (unprotected) key. Secret, like
// the key: never log either.
export function decryptVdat(vdat: VdatFile, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw unknownFormat(`its key is ${key.length} bytes, not ${KEY_LENGTH}`);
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, vdat.nonce, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAuthTag(vdat.tag);
    return Buffer.concat([decipher.update(vdat.data), decipher.final()]);
  } catch {
    // (Node's message says nothing more; never the key)
    throw unknownFormat("it doesn't decrypt with its key");
  }
}

// What a key file holds once Windows has unprotected it. Secret.
export type Unprotect = (keyFile: string) => Promise<Buffer>;

// Reads and decrypts a cache file; `keys` keeps the keys unprotected so far
// (by key id), so a key is unprotected once for several files. The caller
// clears them (fill(0)) when done.
export async function readVdatFile(
  file: string,
  dataDir: string,
  unprotect: Unprotect,
  keys: Map<string, Buffer> = new Map(),
): Promise<Buffer> {
  const vdat = readVdat(await fs.promises.readFile(file));
  let key = keys.get(vdat.keyId);
  if (!key) {
    key = await unprotect(ubisoftKeyFile(dataDir, vdat.keyId));
    keys.set(vdat.keyId, key);
  }
  return decryptVdat(vdat, key);
}

// ---- DPAPI, through Windows PowerShell ----

// Unprotects the key file named by SRM_UBISOFT_KEY_FILE for the current
// Windows user and writes "OK:" and the key in base64, or "ERR:" and why it
// couldn't. (On stdout: Windows PowerShell can write its own records to
// stderr when its output isn't a console.)
const UNPROTECT_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Security
  $blob = [IO.File]::ReadAllBytes($env:SRM_UBISOFT_KEY_FILE)
  $key = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write('OK:' + [Convert]::ToBase64String($key))
} catch {
  [Console]::Out.Write('ERR:' + $_.Exception.Message)
  exit 1
}`;

// A key file unprotected with DPAPI for the current Windows user, through
// Windows PowerShell 5.1 (System.Security's ProtectedData). The key comes
// back over the child's stdout: never log it, nor what PowerShell wrote.
export const unprotectForCurrentUser: Unprotect = (keyFile) =>
  new Promise((resolve, reject) => {
    execFile(
      powershellPath(process.env.SystemRoot),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(UNPROTECT_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, SRM_UBISOFT_KEY_FILE: keyFile },
      },
      (error, stdout) => {
        const out = String(stdout ?? "").trim();
        if (out.startsWith("OK:") && !error) {
          resolve(Buffer.from(out.slice(3), "base64"));
          return;
        }
        const why = out.startsWith("ERR:")
          ? out.slice(4).trim()
          : // (execFile's message holds only the command line and stderr)
            (error?.message.split(/\r?\n/)[0] ?? "no answer from PowerShell");
        reject(
          new Error(`Windows couldn't unlock Ubisoft Connect's key: ${why}`),
        );
      },
    );
  });

// ---- product configurations ----

// The configurations' records by product id: {1: {1: product id, 3: YAML}},
// field 1 repeated. The YAML as text: UTF-8, or Windows-1252 where it isn't
// valid UTF-8.
export function configurationRecords(plain: Buffer): Map<number, string> {
  const records = new Map<number, string>();
  for (const field of protoFields(plain)) {
    if (field.number !== 1 || !field.bytes) {
      continue;
    }
    const record = protoFields(field.bytes);
    const id = protoNumber(record, 1);
    const yaml = protoBytes(record, 3);
    if (id !== undefined && yaml) {
      records.set(id, decodeText(yaml));
    }
  }
  return records;
}

export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch {
      // (a Node without full ICU)
      return Buffer.from(bytes).toString("latin1");
    }
  }
}

// ---- installed games ----

// Ubisoft Connect's installs (HKLM\SOFTWARE\Ubisoft\Launcher\Installs, in
// the 32-bit view, as the UPlay parser reads them): product id and install
// folder, for each install that has a folder.
export function readUbisoftInstalls(): Promise<
  { id: string; installDir: string }[]
> {
  return new Promise((resolve, reject) => {
    const reg = new Registry({
      hive: Registry.HKLM,
      arch: "x86",
      key: "\\SOFTWARE\\Ubisoft\\Launcher\\Installs",
    });
    reg.keys((err: Error, keys: Registry.Registry[]) => {
      if (err) {
        return reject(err);
      }
      Promise.all(
        (keys || []).map(
          (key) =>
            new Promise<{ id: string; installDir: string }>((done) => {
              key.get("InstallDir", (_err: Error, item) =>
                done({
                  id: path.win32.basename(key.key),
                  installDir: item?.value ?? "",
                }),
              );
            }),
        ),
      )
        .then((installs) =>
          resolve(installs.filter((install) => install.installDir !== "")),
        )
        .catch(reject);
    });
  });
}
