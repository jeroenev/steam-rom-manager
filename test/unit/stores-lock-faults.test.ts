// The store locks when Windows answers with an error for a moment: a lock
// folder just removed is still delete-pending (mkdir: EPERM), or a scanner
// has the owner file open (rm: EBUSY).
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as storage from "../../src/lib/stores/storage";

// The error codes the next mkdirSync / rmSync calls on a lock folder throw.
const faults = vi.hoisted(() => ({
  mkdir: [] as string[],
  rm: [] as string[],
}));

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const fail = (code: string) =>
    Object.assign(new Error(`${code}: operation failed (test)`), { code });
  const isLock = (dir: unknown) => String(dir).endsWith(".lock");
  return {
    ...real,
    mkdirSync: (dir: fs.PathLike, ...rest: any[]) => {
      if (isLock(dir) && faults.mkdir.length) {
        throw fail(faults.mkdir.shift()!);
      }
      return (real.mkdirSync as any)(dir, ...rest);
    },
    rmSync: (dir: fs.PathLike, ...rest: any[]) => {
      if (isLock(dir) && faults.rm.length) {
        throw fail(faults.rm.shift()!);
      }
      return (real.rmSync as any)(dir, ...rest);
    },
  };
});

const lockDir = (name: string) =>
  path.join(storage.storesRoot(), ".locks", `${name}.lock`);

describe("store locks on Windows' passing errors", () => {
  afterEach(() => {
    faults.mkdir.length = 0;
    faults.rm.length = 0;
    fs.rmSync(lockDir("faulty"), { recursive: true, force: true });
    fs.rmSync(lockDir("gog"), { recursive: true, force: true });
  });

  it("a lock folder that is still delete-pending is waited for", async () => {
    faults.mkdir.push("EPERM", "EBUSY");
    const release = await storage.acquireLock("faulty", 1000);
    expect(release).toBeTruthy();
    expect(faults.mkdir).toEqual([]);
    release!();
    expect(fs.existsSync(lockDir("faulty"))).toBe(false);
  });

  it("a folder that really can't be made reports its own error", async () => {
    faults.mkdir.push(...Array(50).fill("EACCES"));
    await expect(storage.acquireLock("faulty", 100)).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("a release that can't remove the lock doesn't throw, and the lock goes stale", async () => {
    const release = await storage.acquireLock("faulty", 1000);
    faults.rm.push("EBUSY");
    expect(() => release!()).not.toThrow();
    // Left behind, and still fresh: busy.
    expect(fs.existsSync(lockDir("faulty"))).toBe(true);
    expect(await storage.acquireLock("faulty", 100)).toBeNull();
    // Nobody touches it any more: taken over.
    const old = new Date(Date.now() - storage.LOCK_STALE_MS - 1000);
    fs.utimesSync(lockDir("faulty"), old, old);
    const next = await storage.acquireLock("faulty", 100);
    expect(next).toBeTruthy();
    next!();
  });

  it("work under the account lock keeps its result when the release fails", async () => {
    faults.rm.push("EBUSY");
    await expect(storage.withAccountLock("gog", () => 42)).resolves.toBe(42);
  });

  it("waits past the time a lock left behind takes to go stale", () => {
    expect(storage.ACCOUNT_LOCK_WAIT_MS).toBeGreaterThan(storage.LOCK_STALE_MS);
  });
});
