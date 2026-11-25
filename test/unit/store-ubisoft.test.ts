// Ubisoft Connect accounts: its encrypted caches (a protobuf container,
// AES-256-GCM), the ownership list and the product configurations, and the
// store's sign-in and refresh against a fake Ubisoft Connect folder. Every
// fixture is made up here: no real CD key, user id or key. DPAPI is
// stubbed: the key file's content is the key.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  UbisoftCacheFormat,
  configurationRecords,
  decodeText,
  decryptVdat,
  protoFields,
  readVdat,
} from "../../src/lib/helpers/launchers/ubisoft";
import { readOnlyStoreHost, setStoreHost } from "../../src/lib/stores/host";
import { isLoginRejected } from "../../src/lib/stores/http";
import * as refresh from "../../src/lib/stores/refresh";
import * as storage from "../../src/lib/stores/storage";
import { ListContext } from "../../src/lib/stores/types";
import {
  OwnedProduct,
  ownedGames,
  parseOwnership,
  readProductConfig,
  setUbisoftEnvironment,
  ubisoftClient,
} from "../../src/lib/stores/ubisoft";
import { tempDir } from "../helpers/fixtures";
import { FakeStoreHost } from "../helpers/fake-store-host";

// ---- a protobuf writer, for the fixtures ----

function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

const num = (field: number, value: number) =>
  Buffer.concat([varint(field * 8), varint(value)]);
const bytes = (field: number, value: Buffer | string) => {
  const b = Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(b.length), b]);
};
const fixed64 = (field: number) =>
  Buffer.concat([varint(field * 8 + 1), Buffer.alloc(8, 7)]);
const fixed32 = (field: number) =>
  Buffer.concat([varint(field * 8 + 5), Buffer.alloc(4, 7)]);
const msg = (...parts: Buffer[]) => Buffer.concat(parts);

// Made up, in the shape of the real ones.
const CD_KEY = "TEST-CDKEY-0000-0000";
const APP_ID = "00000000-aaaa-bbbb-cccc-000000000000";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const KEY_ID = "0123456789abcdef0123456789abcdef";

interface Owned {
  type?: number;
  state?: number;
  platform?: number;
  partner?: number;
  activation?: number;
}

// An OwnedGame record, with a CD key and an app id that must never come out.
function ownedRecord(id: number, o: Owned = {}) {
  return msg(
    num(1, id),
    num(2, id + 100000),
    bytes(4, CD_KEY),
    ...(o.platform !== undefined ? [num(5, o.platform)] : []),
    num(6, o.type ?? 0),
    num(7, o.state ?? 3),
    num(8, id + 1),
    num(8, id + 2),
    fixed64(13),
    fixed32(14),
    ...(o.partner !== undefined ? [num(17, o.partner)] : []),
    ...(o.activation !== undefined ? [num(18, o.activation)] : []),
    bytes(19, APP_ID),
  );
}

function ownership(games: [number, Owned?][]) {
  return msg(
    ...games.map(([id, o]) => bytes(1, ownedRecord(id, o))),
    ...games.map(([id]) => num(2, id)),
  );
}

function configurations(configs: [number, string | Buffer][]) {
  return msg(
    ...configs.map(([id, yaml]) =>
      bytes(1, msg(num(1, id), num(2, 1), bytes(3, yaml))),
    ),
  );
}

// An encrypted cache file, as Ubisoft Connect writes them.
function vdat(plain: Buffer, key: Buffer, keyId = KEY_ID) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryption = msg(
    num(1, 1),
    bytes(2, keyId),
    bytes(3, nonce),
    bytes(4, tag),
  );
  return msg(
    bytes(
      1,
      msg(bytes(1, msg(num(1, 1), bytes(2, encryption))), bytes(2, data)),
    ),
  );
}

// A product configuration, as in configurations.vdat.
function config(
  root: Record<string, string>,
  localizations = "",
  startGame = true,
) {
  const lines = ["version: 2.0", "root:"];
  for (const [key, value] of Object.entries(root)) {
    lines.push(`  ${key}: ${value}`);
  }
  if (startGame) {
    lines.push(
      "  start_game:",
      "    online:",
      "      executables:",
      "        - path:",
      "            relative: game.exe",
    );
  }
  return lines.join("\n") + "\n" + localizations;
}

const games = (products: OwnedProduct[], configs: [number, string][]) =>
  ownedGames(products, new Map(configs));

describe("Ubisoft Connect's caches", () => {
  it("reads protobuf fields, skipping fixed-size ones", () => {
    const fields = protoFields(
      msg(num(1, 300), fixed64(2), bytes(3, "abc"), fixed32(4), num(5, 0)),
    );
    expect(fields.map((f) => [f.number, f.value, f.bytes?.toString()])).toEqual(
      [
        [1, 300, undefined],
        [3, undefined, "abc"],
        [5, 0, undefined],
      ],
    );
    // (a 64-bit number: as near as a JavaScript number gets)
    expect(protoFields(num(1, 2 ** 40))[0].value).toBe(2 ** 40);
  });

  it("refuses what isn't protobuf", () => {
    for (const bad of [
      Buffer.from([0x0a, 0x05, 0x61]), // cut short
      Buffer.from([0x08]), // a number cut short
      Buffer.from([0x0b]), // a group (wire type 3)
      Buffer.from([0x00, 0x01]), // field 0
      Buffer.alloc(11, 0xff), // a number too long
    ]) {
      expect(() => protoFields(bad)).toThrow(UbisoftCacheFormat);
    }
  });

  it("decrypts a cache file with its key", () => {
    const key = crypto.randomBytes(32);
    const plain = Buffer.from("the plain text");
    const file = readVdat(vdat(plain, key));
    expect(file.keyId).toBe(KEY_ID);
    expect(file.nonce).toHaveLength(12);
    expect(file.tag).toHaveLength(16);
    expect(decryptVdat(file, key).toString()).toBe("the plain text");
  });

  it("a wrong key, a damaged file or another layout is a format it doesn't know", () => {
    const key = crypto.randomBytes(32);
    const file = vdat(Buffer.from("secret"), key);
    expect(() => decryptVdat(readVdat(file), crypto.randomBytes(32))).toThrow(
      "doesn't decrypt with its key",
    );
    expect(() => decryptVdat(readVdat(file), key.subarray(0, 16))).toThrow(
      "16 bytes, not 32",
    );
    const damaged = Buffer.from(file);
    damaged[damaged.length - 1] ^= 1;
    expect(() => decryptVdat(readVdat(damaged), key)).toThrow(
      UbisoftCacheFormat,
    );
    // (the 2023 plain files)
    expect(() => readVdat(Buffer.from("version: 2.0\nroot:\n"))).toThrow(
      UbisoftCacheFormat,
    );
    expect(() => readVdat(msg(bytes(1, msg(num(1, 1)))))).toThrow("no header");
    // A key id names a file: only plain names.
    expect(() => readVdat(vdat(Buffer.from("x"), key, "..\\..\\user"))).toThrow(
      "key id isn't a plain name",
    );
  });

  it("reads the owned products, never the CD key or the app id", () => {
    const plain = ownership([
      [46],
      [7015, { platform: 3 }],
      [274, { partner: 1, activation: 0 }],
    ]);
    const products = parseOwnership(plain);
    expect(products).toEqual([
      {
        productId: 46,
        platform: undefined,
        productType: 0,
        state: 3,
        targetPartner: undefined,
        activationType: undefined,
      },
      {
        productId: 7015,
        platform: 3,
        productType: 0,
        state: 3,
        targetPartner: undefined,
        activationType: undefined,
      },
      {
        productId: 274,
        platform: undefined,
        productType: 0,
        state: 3,
        targetPartner: 1,
        activationType: 0,
      },
    ]);
    expect(JSON.stringify(products)).not.toContain(CD_KEY);
    expect(JSON.stringify(products)).not.toContain(APP_ID);
  });

  it("reads the configurations' records, in UTF-8 or Windows-1252", () => {
    const records = configurationRecords(
      configurations([
        [46, "root:\n  name: Far Cry® 3\n"],
        // (’ and ® in Windows-1252)
        [54, Buffer.from([...Buffer.from("root:\n  name: A"), 0x92, 0xae])],
      ]),
    );
    expect(records.get(46)).toBe("root:\n  name: Far Cry® 3\n");
    expect(records.get(54)).toBe("root:\n  name: A’®");
    expect(decodeText(Buffer.from("Assassin’s Creed®"))).toBe(
      "Assassin’s Creed®",
    );
  });
});

describe("Ubisoft Connect's games", () => {
  it("titles: the name, or the localized text it is a key of, cleaned", () => {
    const title = (yaml: string) => readProductConfig(yaml)?.title;
    expect(title(config({ name: "Far Cry® 3" }))).toBe("Far Cry 3");
    for (const key of ["l1", "NAME", "GAMENAME"]) {
      expect(
        title(
          config(
            { name: key },
            `localizations:\n  default:\n    ${key}: "Assassin’s Creed® III"\n  fr-FR:\n    ${key}: "Assassin’s Creed® III (FR)"\n`,
          ),
        ),
      ).toBe("Assassin’s Creed III");
    }
    // A key that isn't there is taken as the title.
    expect(
      title(config({ name: "Rayman Origins" }, "localizations: {}\n")),
    ).toBe("Rayman Origins");
    // No name: display_name, then the installer's game_identifier.
    expect(title(config({ display_name: '"Watch Dogs"' }))).toBe("Watch Dogs");
    expect(
      title(
        "root:\n  installer:\n    game_identifier: Trials Rising\n  start_game: {}\n",
      ),
    ).toBe("Trials Rising");
    expect(title("root:\n  name: '   '\n")).toBeUndefined();
  });

  it("reads space_id, another store's copies and whether it starts", () => {
    expect(
      readProductConfig(
        config({
          name: "STEEP",
          space_id: "11111111-2222-3333-4444-555555555555",
        }),
      ),
    ).toEqual({
      title: "STEEP",
      spaceId: "11111111-2222-3333-4444-555555555555",
      thirdPartyPlatform: false,
      startGame: true,
    });
    expect(
      readProductConfig(
        "root:\n  name: Trackmania\n  third_party_platform:\n    name: Steam\n  space_id: '../x'\n",
      ),
    ).toEqual({
      title: "Trackmania",
      spaceId: undefined,
      thirdPartyPlatform: true,
      startGame: false,
    });
    expect(readProductConfig("root: [unclosed")).toBeUndefined();
    expect(readProductConfig("localizations: {}\n")).toBeUndefined();
  });

  it("lists the games the account can play and that Ubisoft Connect installs", () => {
    const product = (productId: number, o: Partial<OwnedProduct> = {}) => ({
      productId,
      productType: 0,
      state: 3,
      ...o,
    });
    const { games: listed, unreadable } = games(
      [
        product(46),
        product(46),
        product(54),
        product(80),
        product(274, { targetPartner: 1 }),
        product(1000, { productType: 1 }), // an add-on
        product(1001, { state: 1 }), // not playable
        product(7015, { platform: 3 }), // bought on Steam
        product(5000), // third_party_platform
        product(1002, { activationType: 2 }), // Ubisoft+
        product(1003), // no start_game
        product(1004), // no configuration
        product(1005), // a configuration that isn't YAML
        product(1006, { productType: 1 }), // an add-on without one
      ],
      [
        [46, config({ name: "Far Cry® 3", space_id: "aaaa-1" })],
        [
          54,
          config(
            { name: "l1", space_id: "aaaa-2" },
            "localizations:\n  default:\n    l1: Assassin's Creed® III\n",
          ),
        ],
        [80, config({ name: "Rayman Origins" })],
        [274, config({ name: "Watch_Dogs", space_id: "aaaa-3" })],
        [1000, config({ name: "DLC" })],
        [1001, config({ name: "Not playable" })],
        [7015, config({ name: "Trackmania" })],
        [
          5000,
          config({ name: "Another store's" }) +
            "  third_party_platform:\n    name: Steam\n",
        ],
        [1002, config({ name: "Ubisoft+" })],
        [1003, config({ name: "No start" }, "", false)],
        [1005, "root: [unclosed"],
      ],
    );
    expect(listed).toEqual([
      {
        store: "ubisoft",
        id: "46",
        title: "Far Cry 3",
        extra: { space_id: "aaaa-1" },
      },
      {
        store: "ubisoft",
        id: "54",
        title: "Assassin's Creed III",
        extra: { space_id: "aaaa-2" },
      },
      { store: "ubisoft", id: "80", title: "Rayman Origins", extra: {} },
      {
        store: "ubisoft",
        id: "274",
        title: "Watch_Dogs",
        extra: { space_id: "aaaa-3", partner: "epic" },
      },
    ]);
    expect(unreadable).toBe(2);
  });
});

describe("Ubisoft Connect account", () => {
  const host = new FakeStoreHost();
  const key = crypto.randomBytes(32);
  let dataDir: string;
  let unprotected: string[];
  let logged: string[];

  const ctx = () =>
    ({
      now: () => Date.now(),
      log: (message: string) => logged.push(message),
      previous: [],
      checkpoint: async (): Promise<void> => undefined,
    }) as unknown as ListContext;

  // Ubisoft Connect's folder: an ownership cache per user (written at
  // `mtime`, in seconds since 1970), the configurations and the key file.
  function writeCaches(users: [string, number][] = [[USER_ID, 1700000000]]) {
    const write = (file: string, data: Buffer, mtime?: number) => {
      const full = path.join(dataDir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, data);
      if (mtime !== undefined) {
        fs.utimesSync(full, mtime, mtime);
      }
    };
    for (const [user, mtime] of users) {
      write(
        path.join("cache", "ownership", `${user}.vdat`),
        vdat(
          ownership(
            user === USER_ID
              ? [[46], [54], [7015, { platform: 3 }], [1000, { type: 1 }]]
              : [[80]],
          ),
          key,
        ),
        mtime,
      );
    }
    write(
      path.join("cache", "configuration", "configurations.vdat"),
      vdat(
        configurations([
          [46, config({ name: "Far Cry® 3", space_id: "aaaa-1" })],
          [
            54,
            config(
              { name: "l1" },
              "localizations:\n  default:\n    l1: Assassin's Creed® III\n",
            ),
          ],
          [80, config({ name: "Rayman Origins" })],
          [7015, config({ name: "Trackmania" })],
          [1000, config({ name: "DLC" })],
        ]),
        key,
      ),
    );
    write(path.join("store", `${KEY_ID}.bin`), Buffer.from("protected"));
    // What SRM must never open: if it did, the stub would see it.
    write("user.vdat", Buffer.from("sign-in"));
  }

  beforeEach(() => {
    dataDir = tempDir("ubisoft");
    unprotected = [];
    logged = [];
    setUbisoftEnvironment({
      osType: "Windows_NT",
      dataDir,
      unprotect: async (keyFile) => {
        unprotected.push(path.relative(dataDir, keyFile));
        return Buffer.from(key);
      },
    });
    setStoreHost(host);
  });
  afterEach(async () => {
    await refresh.deleteAccount("ubisoft");
    setUbisoftEnvironment();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  afterAll(() => setStoreHost(readOnlyStoreHost));

  it("has no sign-in window: it uses Ubisoft Connect on this PC", () => {
    const pending = ubisoftClient.beginLogin();
    expect(pending.doneUrlPrefixes).toEqual([]);
    expect(pending.manual).toEqual({ kind: "local" });
    expect(pending.siteDomains).toBeUndefined();
  });

  it("signs in with the account Ubisoft Connect signed in to last, and lists its games", async () => {
    writeCaches([
      [OTHER_USER_ID, 1600000000],
      [USER_ID, 1700000000],
    ]);
    const pending = refresh.pendingLogin("ubisoft");
    expect(await refresh.completeLogin(pending, {})).toBeNull();
    // (the session: which account's cache, nothing else)
    expect(storage.loadSession("ubisoft", host)?.session).toEqual({
      accountName: null,
      data: { userId: USER_ID },
    });

    const library = await refresh.refreshLibrary("ubisoft");
    expect(library.games.map((g) => [g.id, g.title])).toEqual([
      ["46", "Far Cry 3"],
      ["54", "Assassin's Creed III"],
    ]);
    // The cache's date, not now's.
    expect(library.fetchedAt).toBe(1700000000 * 1000);
    expect(library.accountName).toBeNull();
    // One key for both files, and only the key file opened.
    expect(unprotected).toEqual([path.join("store", `${KEY_ID}.bin`)]);
    expect(refresh.accountStatus("ubisoft")).toMatchObject({
      signedIn: true,
      accountName: null,
      gameCount: 2,
      manual: { kind: "local" },
      webviewLogin: false,
    });
    // Nothing secret was saved or logged.
    const saved = fs
      .readdirSync(storage.storesRoot(), { recursive: true })
      .map(String)
      .filter((file) =>
        fs.statSync(path.join(storage.storesRoot(), file)).isFile(),
      )
      .map((file) =>
        fs.readFileSync(path.join(storage.storesRoot(), file), "utf8"),
      )
      .join("\n");
    for (const secret of [CD_KEY, APP_ID, key.toString("base64")]) {
      expect(saved).not.toContain(secret);
      expect(host.logs.join("\n")).not.toContain(secret);
    }
  });

  it("keeps listing its account when Ubisoft Connect signs in to another, and says so", async () => {
    writeCaches([[USER_ID, 1700000000]]);
    const session = await ubisoftClient.completeLogin(
      ubisoftClient.beginLogin(),
      {},
      ctx(),
    );
    writeCaches([
      [USER_ID, 1700000000],
      [OTHER_USER_ID, 1700000500],
    ]);
    const { games: listed } = await ubisoftClient.listLibrary(session, ctx());
    expect(listed.map((g) => g.id)).toEqual(["46", "54"]);
    expect(logged.join("\n")).toContain("signed in to another account");
  });

  it("a cache that's gone asks to sign in again", async () => {
    writeCaches();
    const session = await ubisoftClient.completeLogin(
      ubisoftClient.beginLogin(),
      {},
      ctx(),
    );
    fs.rmSync(path.join(dataDir, "cache", "ownership"), { recursive: true });
    const err = await ubisoftClient.listLibrary(session, ctx()).catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    expect(err.message).toContain("no longer has the cache");
  });

  it("says why it can't sign in", async () => {
    const signIn = () =>
      ubisoftClient.completeLogin(ubisoftClient.beginLogin(), {}, ctx());
    await expect(signIn()).rejects.toThrow("hasn't signed in on this PC yet");
    setUbisoftEnvironment({ osType: "Windows_NT", dataDir: undefined });
    await expect(signIn()).rejects.toThrow("isn't installed");
    setUbisoftEnvironment({ osType: "Linux", dataDir });
    await expect(signIn()).rejects.toThrow("only be read on Windows");
  });

  it("a cache it can't decrypt fails the refresh and keeps the games from before", async () => {
    writeCaches();
    await refresh.completeLogin(refresh.pendingLogin("ubisoft"), {});
    await refresh.refreshLibrary("ubisoft");
    setUbisoftEnvironment({
      osType: "Windows_NT",
      dataDir,
      unprotect: async () => {
        throw new Error(
          "Windows couldn't unlock Ubisoft Connect's key: Key not valid for use in specified state.",
        );
      },
    });
    await expect(refresh.refreshLibrary("ubisoft")).rejects.toThrow(
      "Could not read Ubisoft Connect's cache: Windows couldn't unlock",
    );
    expect(refresh.cachedLibrary("ubisoft")?.games).toHaveLength(2);
  });
});
