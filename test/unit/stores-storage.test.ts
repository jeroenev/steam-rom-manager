// Where store accounts are kept, and the locks around them (ported from
// BoilR's storage.rs tests).
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import * as paths from "../../src/paths";
import * as storage from "../../src/lib/stores/storage";
import {
  ownedGame,
  OwnedLibrary,
  SavedCookie,
} from "../../src/lib/stores/types";
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
      cookiesRev: null,
    });
    const onDisk = fs.readFileSync(storage.sessionFile("gog"), "utf8");
    expect(onDisk).not.toContain("abc");
    expect(onDisk).toContain("player");
    // Every save is a new rev.
    expect(
      storage.saveSession("gog", { accountName: "player", data: {} }, host),
    ).not.toBe(rev);
  });

  it("keeps a cookie store's cookies with the session, encrypted, and their own rev", () => {
    const cookie: SavedCookie = {
      name: "sid",
      value: "cookie-secret",
      domain: ".ea.com",
      hostOnly: false,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    };
    const session = { accountName: "player", data: { signedInAt: 1 } };
    const rev = storage.saveSession("gog", session, host, [cookie]);
    const first = storage.loadSessionCookies("gog", host)!;
    expect(first).toMatchObject({ rev, cookies: [cookie] });
    expect(first.cookiesRev).toEqual(expect.any(String));
    expect(fs.readFileSync(storage.sessionFile("gog"), "utf8")).not.toContain(
      "cookie-secret",
    );

    // Renewed cookies alone: the same login, so the same rev.
    const renewed = { ...cookie, value: "renewed", expirationDate: 2e9 };
    const cookiesRev = storage.saveSessionCookies("gog", [renewed], host);
    expect(storage.readSessionInfo("gog")).toEqual({
      rev,
      accountName: "player",
      cookiesRev,
    });
    expect(storage.loadSessionCookies("gog", host)?.cookies).toEqual([renewed]);

    // The session saved without cookies keeps the saved ones.
    const again = storage.saveSession("gog", session, host);
    expect(storage.loadSessionCookies("gog", host)).toEqual({
      rev: again,
      cookiesRev,
      cookies: [renewed],
    });
    // A new list replaces them; one that isn't a cookie is left out.
    storage.saveSession("gog", session, host, [
      cookie,
      { name: "broken" } as any,
    ]);
    expect(storage.loadSessionCookies("gog", host)?.cookies).toEqual([cookie]);

    // Cookies another key encrypted need a new sign-in, as the session does.
    const other = new FakeStoreHost();
    other.unprotect = () => {
      throw new Error("another machine's key");
    };
    expect(() => storage.loadSessionCookies("gog", other)).toThrow(
      /can't be read.*Sign in again/,
    );

    storage.deleteAccount("gog");
    expect(storage.loadSessionCookies("gog", host)).toBeNull();
    expect(() => storage.saveSessionCookies("gog", [cookie], host)).toThrow(
      "Not signed in",
    );
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

  it("round-trips a library; writers in one process queue on the account lock and leave no temporary files", async () => {
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

  it("another process reading the library while it's written never sees half a file", async () => {
    storage.saveLibrary("gog", {
      accountName: null,
      fetchedAt: 0,
      games: [],
      partial: false,
    });
    // A reader in another process (as the command line reading what the
    // app writes), reading over and over until told to stop. Plain Node: the
    // code under test is the writer, here.
    const reader = `
      const fs = require("fs");
      const file = process.argv[1];
      let ok = 0, bad = 0, done = false;
      process.stdin.on("data", () => {});
      process.stdin.on("end", () => { done = true; });
      process.stdout.write("ready\\n");
      const pause = new Int32Array(new SharedArrayBuffer(4));
      (function loop() {
        if (done) {
          process.stdout.write(JSON.stringify({ ok, bad }) + "\\n");
          return;
        }
        try {
          JSON.parse(fs.readFileSync(file, "utf8"));
          ok++;
        } catch (e) {
          // (Windows: the file is being replaced at that moment)
          if (!["ENOENT", "EPERM", "EBUSY", "EACCES"].includes(e.code)) bad++;
        }
        // (a short pause: Windows can't replace a file that's always open)
        Atomics.wait(pause, 0, 0, 1);
        setImmediate(loop);
      })();
    `;
    const child = spawn(
      process.execPath,
      ["-e", reader, storage.libraryFile("gog")],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let output = "";
    const lines = new Promise<string[]>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("ready\n")) {
          resolve(output.split("\n"));
        }
      });
      child.on("error", reject);
    });
    await lines;
    const big = (n: number) =>
      Array.from({ length: 20000 }, (_, i) =>
        ownedGame("gog", `${n}-${i}`, `Game number ${i} of write ${n}`),
      );
    for (let n = 0; n < 30; n++) {
      storage.saveLibrary("gog", {
        accountName: null,
        fetchedAt: n,
        games: big(n),
        partial: false,
      });
      await new Promise((resolve) => setImmediate(resolve));
    }
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.stdin.end();
    await exited;
    const counts = JSON.parse(output.trim().split("\n").pop()!);
    expect(counts.bad).toBe(0);
    expect(counts.ok).toBeGreaterThan(0);
  }, 60000);

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
