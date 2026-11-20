// Where store accounts are kept, and the locks around them (ported from
// BoilR's storage.rs tests).
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as paths from "../../src/paths";
import * as storage from "../../src/lib/stores/storage";
import { ownedGame, OwnedLibrary } from "../../src/lib/stores/types";
import { FakeStoreHost } from "../helpers/fake-store-host";

const host = new FakeStoreHost();

describe("store storage", () => {
  afterEach(() => {
    storage.deleteAccount("gog");
  });

  it("lives in SRM's data folder", () => {
    expect(storage.storesRoot()).toBe(paths.storesDir);
    expect(paths.storesDir).toBe(path.join(paths.userDataDir, "stores"));
    expect(storage.sessionFile("gog")).toBe(
      path.join(paths.storesDir, "gog", "session.json"),
    );
  });

  it("round-trips a session, keeping its data encrypted on disk", () => {
    expect(storage.loadSession("gog", host)).toBeNull();
    expect(storage.readSessionInfo("gog")).toBeNull();
    const rev = storage.saveSession(
      "gog",
      { accountName: "player", data: { refreshToken: "abc" } },
      host,
    );
    expect(storage.loadSession("gog", host)).toEqual({
      rev,
      session: { accountName: "player", data: { refreshToken: "abc" } },
    });
    expect(storage.readSessionInfo("gog")).toEqual({
      rev,
      accountName: "player",
    });
    const onDisk = fs.readFileSync(storage.sessionFile("gog"), "utf8");
    expect(onDisk).not.toContain("abc");
    expect(onDisk).toContain("player");
    // Every save is a new rev.
    expect(
      storage.saveSession("gog", { accountName: "player", data: {} }, host),
    ).not.toBe(rev);
  });

  it("a session this host can't decrypt asks for a new sign-in", () => {
    storage.saveSession("gog", { accountName: null, data: { a: 1 } }, host);
    const other = new FakeStoreHost();
    other.unprotect = () => {
      throw new Error("another machine's key");
    };
    expect(() => storage.loadSession("gog", other)).toThrow(
      /can't be read.*Sign in again/,
    );
    // What the status needs is still there.
    expect(storage.readSessionInfo("gog")).not.toBeNull();
  });

  it("round-trips a library, and writers at the same time never mix their bytes", async () => {
    const library: OwnedLibrary = {
      accountName: null,
      fetchedAt: 1,
      games: [ownedGame("gog", "1207658924", "Unreal Gold")],
      partial: false,
    };
    storage.saveLibrary("gog", library);
    expect(storage.loadLibrary("gog")).toEqual(library);

    if (process.platform !== "win32") {
      for (const file of [storage.libraryFile("gog")]) {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    }

    // Writers at the same time take the account lock, as every caller does.
    await Promise.all(
      Array.from({ length: 8 }, (_, count) =>
        storage.withAccountLock("gog", async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          storage.saveLibrary("gog", {
            ...library,
            fetchedAt: count,
            games: Array(200).fill(ownedGame("gog", "1", "Game")),
          });
        }),
      ),
    );
    expect(storage.loadLibrary("gog")?.games).toHaveLength(200);
    const leftovers = fs
      .readdirSync(storage.storeFolder("gog"))
      .filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);

    storage.deleteAccount("gog");
    expect(storage.loadLibrary("gog")).toBeNull();
  });

  it("an unreadable library is an error, not an empty one", () => {
    fs.mkdirSync(storage.storeFolder("gog"), { recursive: true });
    fs.writeFileSync(storage.libraryFile("gog"), '{"games": 3}');
    expect(() => storage.loadLibrary("gog")).toThrow();
  });

  it("failure records come and go, and outlive a sign-out", () => {
    storage.saveFailure("gog", { at: 5, message: "down", needsSignIn: false });
    storage.deleteAccount("gog");
    expect(storage.loadFailure("gog")).toEqual({
      at: 5,
      message: "down",
      needsSignIn: false,
    });
    storage.saveFailure("gog", null);
    expect(storage.loadFailure("gog")).toBeNull();
    // A damaged record counts as none.
    fs.writeFileSync(storage.failureFile("gog"), "{");
    expect(storage.loadFailure("gog")).toBeNull();
    storage.saveFailure("gog", null);
  });

  it("locks: one holder at a time, and a crashed holder's lock goes stale", async () => {
    const release = await storage.acquireLock("test", 1000);
    expect(release).toBeTruthy();
    // Taken: a short wait gives up.
    expect(await storage.acquireLock("test", 100)).toBeNull();
    release!();
    const again = await storage.acquireLock("test", 100);
    expect(again).toBeTruthy();

    // A holder that stopped touching its lock (it crashed): taken over. No
    // PIDs involved.
    const dir = path.join(storage.storesRoot(), ".locks", "test.lock");
    const old = new Date(Date.now() - storage.LOCK_STALE_MS - 1000);
    fs.utimesSync(dir, old, old);
    const takenOver = await storage.acquireLock("test", 100);
    expect(takenOver).toBeTruthy();
    // The stuck holder's release leaves its successor's lock alone.
    again!();
    expect(fs.existsSync(dir)).toBe(true);
    takenOver!();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("a refresh lock waits for the one before", async () => {
    const first = await storage.lockRefresh("gog", 1000);
    const second = storage.lockRefresh("gog", 2000);
    setTimeout(() => first!(), 100);
    const got = await second;
    expect(got).toBeTruthy();
    got!();
  });
});
