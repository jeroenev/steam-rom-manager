// Signing in, refreshing and signing out of store accounts, and the guards
// that keep a bad answer from emptying a library (ported from BoilR's
// boilr-stores lib.rs tests, plus the flows around them).
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as _ from "lodash";
import { setStoreHost, readOnlyStoreHost } from "../../src/lib/stores/host";
import {
  isLoginRejected,
  isTransient,
  HttpStatus,
  loginRejected,
  transient,
  wrapErr,
} from "../../src/lib/stores/http";
import {
  registerStoreClient,
  storeClient,
  unregisterStoreClient,
} from "../../src/lib/stores/registry";
import * as refresh from "../../src/lib/stores/refresh";
import * as storage from "../../src/lib/stores/storage";
import {
  ListContext,
  OwnedLibrary,
  STORE_KEYS,
  StoreClient,
  StoreKey,
  StoreSession,
  isStoreKey,
  ownedGame,
} from "../../src/lib/stores/types";
import { FakeStoreHost } from "../helpers/fake-store-host";

const host = new FakeStoreHost();

function session(token: string, accountName: string | null = "player") {
  return { accountName, data: { token } };
}

function library(count: number, fetchedAt = 1): OwnedLibrary {
  return {
    accountName: "player",
    fetchedAt,
    games: _.range(count).map((i) => ownedGame("itch", String(i), "Game")),
    partial: false,
  };
}

function games(count: number) {
  return { games: library(count).games, partial: false };
}

// A store whose games the test hands over: `list` decides what a refresh
// gets.
function fakeClient(
  key: StoreKey,
  list: (
    session: StoreSession,
    ctx: ListContext,
  ) => Promise<{ games: any[]; partial?: boolean }>,
  extra: Partial<StoreClient> = {},
): StoreClient {
  return {
    key,
    beginLogin: () => ({
      store: key,
      startUrl: "https://store.example/login",
      doneUrlPrefixes: ["https://store.example/done"],
      pageTextUrlPrefixes: [],
      cookieUrls: [],
      manual: {
        kind: "paste",
        url: "https://store.example/login",
        instructions: "Paste it",
        placeholder: "code",
      },
      state: { verifier: Math.random().toString() },
    }),
    completeLogin: async (_pending, capture) => ({
      accountName: capture.pasted === "someone" ? "someone else" : "player",
      data: { token: capture.pasted },
    }),
    listLibrary: list,
    ...extra,
  };
}

// Commits a refresh that started with the session saved now.
async function commit(
  store: StoreKey,
  startedWith: StoreSession,
  startedRev: string,
  now: StoreSession,
  fetched: { games?: any[]; error?: unknown; partial?: boolean },
  asked: refresh.Asked = "explicitly",
) {
  return refresh.commitRefresh({
    store,
    startedRev,
    startedWith,
    session: now,
    fetched,
    asked,
  });
}

// The stores whose clients the tests replace with fakes; their real clients
// come back after each test.
const FAKE_STORES: StoreKey[] = ["epic", "amazon", "ea", "battlenet", "humble"];
const realClients = new Map(
  FAKE_STORES.map((store) => [store, storeClient(store)] as const),
);

describe("store accounts", () => {
  beforeEach(() => {
    setStoreHost(host);
    host.canRefresh = true;
  });
  afterEach(async () => {
    refresh.setStoreClock();
    for (const store of STORE_KEYS) {
      await refresh.deleteAccount(store);
    }
    for (const [store, client] of realClients) {
      if (client) {
        registerStoreClient(client);
      } else {
        unregisterStoreClient(store);
      }
    }
    delete host.cookies;
    delete host.setCookies;
    delete host.clearStoreData;
    host.handler = () => ({ status: 404 });
  });
  afterAll(() => setStoreHost(readOnlyStoreHost));

  it("stores are written by their key", () => {
    expect(STORE_KEYS).toEqual([
      "epic",
      "gog",
      "amazon",
      "ea",
      "battlenet",
      "humble",
      "itch",
    ]);
    expect(isStoreKey("battlenet")).toBe(true);
    expect(isStoreKey("battle_net")).toBe(false);
    expect(refresh.accountStatus("battlenet").store).toBe("battlenet");
  });

  it("a sign-in keeps its state until it ends", async () => {
    registerStoreClient(fakeClient("amazon", async () => games(1)));
    // The link the user opened and the login that finishes it share the
    // state (Amazon's PKCE verifier).
    const opened = refresh.pendingLogin("amazon");
    const finished = refresh.pendingLogin("amazon");
    expect(finished.state).toEqual(opened.state);
    refresh.endPendingLogin("amazon");
    expect(refresh.pendingLogin("amazon").state).not.toEqual(opened.state);

    // A finished login ends it.
    const pending = refresh.pendingLogin("amazon");
    expect(await refresh.completeLogin(pending, { pasted: "token-1" })).toBe(
      "player",
    );
    expect(refresh.pendingLogin("amazon").state).not.toEqual(pending.state);
    expect(storage.loadSession("amazon", host)?.session).toEqual(
      session("token-1"),
    );
  });

  it("reading a status starts no login", () => {
    let begun = 0;
    const client = fakeClient("amazon", async () => games(1));
    const begin = client.beginLogin;
    registerStoreClient({ ...client, beginLogin: () => (begun++, begin()) });
    const status = refresh.accountStatus("amazon");
    expect(status.webviewLogin).toBe(true);
    expect(status.manual.kind).toBe("paste");
    expect(status.available).toBe(true);
    // (that one was thrown away)
    const pending = refresh.pendingLogin("amazon");
    expect(begun).toBe(2);
    refresh.accountStatus("amazon");
    expect(begun).toBe(2);
    expect(refresh.pendingLogin("amazon")).toBe(pending);
  });

  it("a cookie store's module reaches its own browser partition, a token store's doesn't", async () => {
    const asked: string[] = [];
    host.cookies = async (store, url) => {
      asked.push(`read ${store} ${url}`);
      return [{ name: "XSRF-TOKEN", value: "x", domain: "account.example" }];
    };
    host.setCookies = async (store, cookies) => {
      asked.push(`set ${store} ${cookies.map((c) => c.name).join(",")}`);
    };
    const reached: Partial<Record<StoreKey, boolean>> = {};
    for (const store of ["battlenet", "epic"] as StoreKey[]) {
      registerStoreClient(
        fakeClient(store, async (_session, ctx) => {
          reached[store] = !!ctx.cookies || !!ctx.setCookies;
          if (ctx.cookies && ctx.setCookies) {
            expect(await ctx.cookies("https://account.example/")).toHaveLength(
              1,
            );
            await ctx.setCookies([
              { name: "pasted", value: "v", domain: ".example" },
            ]);
          }
          return games(1);
        }),
      );
      storage.saveSession(store, session("t"), host);
      await refresh.refreshLibrary(store);
    }
    expect(reached).toEqual({ battlenet: true, epic: false });
    expect(asked).toEqual([
      "read battlenet https://account.example/",
      "set battlenet pasted",
    ]);
  });

  it("stores SRM can't sign in to yet say so", async () => {
    unregisterStoreClient("humble");
    const status = refresh.accountStatus("humble");
    expect(status.available).toBe(false);
    expect(status.signedIn).toBe(false);
    expect(status.manual).toEqual({ kind: "unsupported" });
    expect(() => refresh.pendingLogin("humble")).toThrow(
      "comes with a later version",
    );
  });

  it("recent failures hold off retries and survive a restart", async () => {
    let asked = 0;
    registerStoreClient(
      fakeClient("humble", async () => {
        asked++;
        throw transient("no connection");
      }),
    );
    storage.saveSession("humble", session("t"), host);
    storage.saveLibrary("humble", library(3));
    // Old, and the refresh fails: the list from before is used.
    expect((await refresh.refreshIfStale("humble", 60_000)).games).toHaveLength(
      3,
    );
    expect(asked).toBe(1);
    // The record is a file, so it's there after a restart too.
    expect(storage.loadFailure("humble")?.needsSignIn).toBe(false);
    expect(refresh.accountStatus("humble").lastError).toContain(
      "no connection",
    );
    // Not tried again for a while.
    await refresh.refreshIfStale("humble", 60_000);
    expect(asked).toBe(1);
    // Later it is.
    const at = Date.now();
    refresh.setStoreClock(() => at + refresh.RETRY_AFTER_FAILURE_MS + 1000);
    await refresh.refreshIfStale("humble", 60_000);
    expect(asked).toBe(2);
  });

  it("only a refused login is recorded as needing a sign-in", () => {
    storage.saveSession("humble", session("t"), host);
    const needsSignIn = (err: unknown) => {
      refresh.recordFailure("humble", refresh.redacted(err));
      const failure = storage.loadFailure("humble");
      refresh.recordFailure("humble", null);
      return failure?.needsSignIn;
    };
    expect(needsSignIn(loginRejected("signed out"))).toBe(true);
    expect(needsSignIn(new HttpStatus(401, "https://store.example/", ""))).toBe(
      true,
    );
    // An outage, a bot block, and a message that merely says so don't.
    expect(needsSignIn(transient("no connection"))).toBe(false);
    expect(needsSignIn(new HttpStatus(403, "https://store.example/", ""))).toBe(
      false,
    );
    expect(needsSignIn(new Error("the store is down. Sign in again."))).toBe(
      false,
    );
  });

  it("redacted errors keep their kind and lose secrets", () => {
    const err = wrapErr(
      loginRejected("401 from https://a.com/x?refresh_token=SECRET"),
      "Could not load the library",
    );
    const clean = refresh.redacted(err);
    expect(isLoginRejected(clean)).toBe(true);
    expect(clean.message).toContain("Could not load the library");
    expect(clean.message).toContain("https://a.com/x");
    expect(clean.message).not.toContain("SECRET");

    const outage = refresh.redacted(
      wrapErr(transient("timed out"), "Could not load"),
    );
    expect(isTransient(outage) && !isLoginRejected(outage)).toBe(true);
    const plain = refresh.redacted(new Error("unexpected answer"));
    expect(isTransient(plain) || isLoginRejected(plain)).toBe(false);
  });

  it("unreadable session data asks for a new sign-in", () => {
    expect(() =>
      storage.sessionData(
        "gog",
        { accountName: null, data: { other: 1 } },
        (d) => typeof d.token === "string",
      ),
    ).toThrow(/Sign in again/);
    try {
      storage.sessionData("gog", { accountName: null, data: {} }, () => false);
    } catch (err) {
      expect(isLoginRejected(err)).toBe(true);
    }
  });

  it("a refresh never saves over a sign-out", async () => {
    const startedWith = session("old");
    const rev = storage.saveSession("itch", startedWith, host);
    await refresh.deleteAccount("itch");

    const result = commit(
      "itch",
      startedWith,
      rev,
      session("renewed"),
      games(2),
    );
    await expect(result).rejects.toSatisfy(refresh.isAccountChanged);
    expect(storage.loadSession("itch", host)).toBeNull();
    expect(refresh.cachedLibrary("itch")).toBeNull();
  });

  it("a refresh never saves over a new sign-in", async () => {
    const startedWith = session("old");
    const rev = storage.saveSession("battlenet", startedWith, host);
    await refresh.saveNewLogin("battlenet", session("new"));

    const result = commit(
      "battlenet",
      startedWith,
      rev,
      session("renewed"),
      games(2),
    );
    await expect(result).rejects.toSatisfy(refresh.isAccountChanged);
    expect(storage.loadSession("battlenet", host)?.session).toEqual(
      session("new"),
    );
  });

  it("a refresh saves renewed tokens even when listing fails", async () => {
    const startedWith = session("old");
    const rev = storage.saveSession("amazon", startedWith, host);

    const failed = commit("amazon", startedWith, rev, session("renewed"), {
      error: new Error("network down"),
    });
    await expect(failed).rejects.toThrow("network down");
    const saved = storage.loadSession("amazon", host)!;
    expect(saved.session).toEqual(session("renewed"));

    const renewed = session("renewed");
    const ok = await commit("amazon", renewed, saved.rev, renewed, games(2));
    expect(ok.games).toHaveLength(2);
    expect(refresh.cachedLibrary("amazon")?.games).toHaveLength(2);
  });

  it("renewed tokens are saved before the games are listed", async () => {
    let signOutMeanwhile = false;
    registerStoreClient(
      fakeClient("epic", async (s, ctx) => {
        s.data = { token: "renewed" };
        await ctx.checkpoint(s);
        expect(storage.loadSession("epic", host)?.session).toEqual(
          session("renewed"),
        );
        if (signOutMeanwhile) {
          await refresh.deleteAccount("epic");
          s.data = { token: "again" };
          // After a sign-out there's nothing to save over.
          await ctx.checkpoint(s);
        }
        return games(1);
      }),
    );
    storage.saveSession("epic", session("old"), host);
    expect((await refresh.refreshLibrary("epic")).games).toHaveLength(1);
    // The refresh went on from the saved session.
    expect(storage.loadSession("epic", host)?.session).toEqual(
      session("renewed"),
    );

    signOutMeanwhile = true;
    await expect(refresh.refreshLibrary("epic")).rejects.toSatisfy(
      refresh.isAccountChanged,
    );
    expect(storage.loadSession("epic", host)).toBeNull();
    // Not the new login's failure.
    expect(storage.loadFailure("epic")).toBeNull();
  });

  it("signing out during a refresh wins", async () => {
    let listing: () => void;
    const listed = new Promise<void>((resolve) => (listing = resolve));
    let started: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    registerStoreClient(
      fakeClient("ea", async (s) => {
        started();
        await listed;
        s.data = { token: "renewed" };
        return games(5);
      }),
    );
    storage.saveSession("ea", session("old"), host);
    const refreshing = refresh.refreshLibrary("ea");
    await begun;
    expect(refresh.accountStatus("ea").refreshing).toBe(true);
    expect(await refresh.signOut("ea")).toBeNull();
    listing!();
    await expect(refreshing).rejects.toSatisfy(refresh.isAccountChanged);
    expect(storage.loadSession("ea", host)).toBeNull();
    expect(refresh.cachedLibrary("ea")).toBeNull();
    expect(refresh.accountStatus("ea").refreshing).toBe(false);
  });

  it("signing out of a cookie store stops its refresh before it empties the partition", async () => {
    // (the store never answers: only the sign-out ends the request)
    host.handler = () => new Promise(() => undefined);
    let started: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    let requestStopped = false;
    registerStoreClient(
      fakeClient("ea", async (_session, ctx) => {
        started();
        try {
          await ctx.http.send("https://store.example/library");
        } catch (err) {
          requestStopped = true;
          throw err;
        }
        return games(1);
      }),
    );
    const cleared: { refreshing: boolean }[] = [];
    host.clearStoreData = async (store) => {
      cleared.push({ refreshing: refresh.accountStatus(store).refreshing });
    };
    storage.saveSession("ea", session("old"), host);
    const refreshing = refresh.refreshLibrary("ea");
    refreshing.catch(() => undefined);
    await begun;
    expect(await refresh.signOut("ea")).toBeNull();
    // The request was stopped, and the refresh over, before the partition
    // was emptied: no answer can put sign-in cookies back after it.
    expect(requestStopped).toBe(true);
    expect(cleared).toEqual([{ refreshing: false }]);
    await expect(refreshing).rejects.toSatisfy(refresh.isAccountChanged);
    // (no failure of the account's)
    expect(storage.loadFailure("ea")).toBeNull();
  });

  it("a cookie store's sign-in that fails leaves nothing in its partition, unless the account is signed in", async () => {
    const cleared: StoreKey[] = [];
    host.clearStoreData = async (store) => {
      cleared.push(store);
    };
    for (const store of ["battlenet", "amazon"] as StoreKey[]) {
      registerStoreClient(
        fakeClient(store, async () => games(1), {
          completeLogin: async () => {
            throw transient("The account site did not answer");
          },
        }),
      );
    }
    registerStoreClient(fakeClient("ea", async () => games(1)));
    const fail = (store: StoreKey) =>
      refresh.completeLogin(refresh.pendingLogin(store), { cookies: [] });
    // Not signed in: what the window stored goes.
    await expect(fail("battlenet")).rejects.toSatisfy(isTransient);
    expect(cleared).toEqual(["battlenet"]);
    // Signed in (signing in again): the account's cookies stay.
    storage.saveSession("battlenet", session("t"), host);
    await expect(fail("battlenet")).rejects.toSatisfy(isTransient);
    // A token store's sign-in partition is thrown away by the window itself.
    await expect(fail("amazon")).rejects.toThrow();
    expect(cleared).toEqual(["battlenet"]);
    // A sign-in that works clears nothing.
    await refresh.completeLogin(refresh.pendingLogin("ea"), { pasted: "x" });
    expect(cleared).toEqual(["battlenet"]);
    // Called for a cancelled window: the same rule.
    await refresh.forgetUnfinishedLogin("humble");
    await refresh.forgetUnfinishedLogin("ea");
    await refresh.forgetUnfinishedLogin("epic");
    expect(cleared).toEqual(["battlenet", "humble"]);
  });

  it("a partition that can't be emptied is logged, and the sign-in's own error stays", async () => {
    host.clearStoreData = async () => {
      throw new Error("disk full");
    };
    registerStoreClient(
      fakeClient("humble", async () => games(1), {
        completeLogin: async () => {
          throw loginRejected("Humble Bundle says you are signed out");
        },
      }),
    );
    host.logs.length = 0;
    await expect(
      refresh.completeLogin(refresh.pendingLogin("humble"), { pasted: "c" }),
    ).rejects.toSatisfy(isLoginRejected);
    expect(host.logs.join("\n")).toContain(
      "Could not clear the Humble Bundle sign-in data: disk full",
    );
  });

  it("an empty answer doesn't replace a library", async () => {
    const current = session("t");
    const rev = storage.saveSession("humble", current, host);
    storage.saveLibrary("humble", library(3));

    await expect(
      commit("humble", current, rev, current, games(0)),
    ).rejects.toThrow("listed no games");
    expect(refresh.cachedLibrary("humble")?.games).toHaveLength(3);

    // After signing out and in again there's no earlier list to protect.
    await refresh.deleteAccount("humble");
    const again = storage.saveSession("humble", current, host);
    expect(
      (await commit("humble", current, again, current, games(0))).games,
    ).toEqual([]);
  });

  it("a much shorter list is only taken when the user asked", async () => {
    const current = session("t");
    const rev = storage.saveSession("epic", current, host);
    storage.saveLibrary("epic", library(40));
    const automatic = (count: number) =>
      commit("epic", current, rev, current, games(count), "automatically");

    // Less than half of what was there looks like a list cut short.
    await expect(automatic(19)).rejects.toThrow("down from 40");
    expect(refresh.cachedLibrary("epic")?.games).toHaveLength(40);
    // Losing a few games is normal.
    expect((await automatic(30)).games).toHaveLength(30);
    // Asked for by the user, the short list is taken.
    expect(
      (await commit("epic", current, rev, current, games(5))).games,
    ).toHaveLength(5);
    // Short libraries aren't guarded.
    expect((await automatic(1)).games).toHaveLength(1);
  });

  it("a refresh drops games without an id or a title, and duplicates", async () => {
    const current = session("t");
    const rev = storage.saveSession("itch", current, host);
    const saved = await commit("itch", current, rev, current, {
      games: [
        ownedGame("itch", "2", "B"),
        ownedGame("itch", "", "No id"),
        ownedGame("itch", "3", "  "),
        ownedGame("itch", "1", "A"),
        ownedGame("itch", "2", "B again"),
      ],
      partial: true,
    });
    expect(saved.games.map((g) => [g.id, g.title])).toEqual([
      ["1", "A"],
      ["2", "B"],
    ]);
    expect(saved.partial).toBe(true);
    expect(saved.accountName).toBe("player");
  });

  it("signing in again keeps the library of the same account only", async () => {
    const fresh = { ...library(3), fetchedAt: Date.now() };
    storage.saveLibrary("epic", fresh);
    // The same account: its games stay, to be fetched again on next use.
    await refresh.saveNewLogin("epic", session("new"));
    expect(refresh.isStale(refresh.cachedLibrary("epic"), 60_000)).toBe(true);
    expect(refresh.cachedLibrary("epic")?.games).toHaveLength(3);

    // Another account, or one whose name isn't known: no games carried over.
    storage.saveLibrary("epic", fresh);
    const other = session("other", "someone else");
    await refresh.saveNewLogin("epic", other);
    expect(refresh.cachedLibrary("epic")).toBeNull();
    // So an account without games is taken as it is.
    const rev = storage.readSessionInfo("epic")!.rev;
    expect((await commit("epic", other, rev, other, games(0))).games).toEqual(
      [],
    );

    storage.saveLibrary("epic", fresh);
    await refresh.saveNewLogin("epic", session("unnamed", null));
    expect(refresh.cachedLibrary("epic")).toBeNull();
  });

  it("a new sign-in through completeLogin follows the same rule", async () => {
    registerStoreClient(fakeClient("amazon", async () => games(1)));
    storage.saveLibrary("amazon", library(3));
    await refresh.completeLogin(refresh.pendingLogin("amazon"), {
      pasted: "someone",
    });
    expect(refresh.cachedLibrary("amazon")).toBeNull();
    expect(refresh.accountStatus("amazon")).toMatchObject({
      signedIn: true,
      accountName: "someone else",
      gameCount: null,
    });
  });

  it("a partial library is fetched again sooner", () => {
    const now = Date.now();
    const complete = {
      ...library(1),
      fetchedAt: now - refresh.RETRY_AFTER_FAILURE_MS - 60_000,
    };
    const partial = { ...complete, partial: true };
    const sixHours = 6 * 60 * 60 * 1000;
    expect(refresh.isStale(complete, sixHours, now)).toBe(false);
    expect(refresh.isStale(partial, sixHours, now)).toBe(true);
    expect(refresh.isStale(null, sixHours, now)).toBe(true);
    expect(refresh.LIBRARY_MAX_AGE_MS).toBe(sixHours);
  });

  it("refreshes, and tells listeners about it", async () => {
    registerStoreClient(
      fakeClient("epic", async (_s, ctx) => {
        expect(ctx.previous).toHaveLength(0);
        return {
          games: [ownedGame("epic", "Fortnite", "Fortnite")],
          partial: true,
        };
      }),
    );
    const told: StoreKey[] = [];
    const stop = refresh.onStoresChanged((store) => told.push(store));
    storage.saveSession("epic", session("t"), host);
    const fetched = await refresh.refreshLibrary("epic");
    stop();
    expect(fetched).toMatchObject({ accountName: "player", partial: true });
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((store) => store === "epic")).toBe(true);
    expect(refresh.accountStatus("epic")).toMatchObject({
      signedIn: true,
      gameCount: 1,
      partial: true,
      lastError: null,
      needsSignIn: false,
      refreshing: false,
    });
  });

  it("a refused login shows on the account", async () => {
    registerStoreClient(
      fakeClient("epic", async () => {
        throw new HttpStatus(401, "https://store.example/library", "");
      }),
    );
    storage.saveSession("epic", session("t"), host);
    await expect(refresh.refreshLibrary("epic")).rejects.toSatisfy(
      isLoginRejected,
    );
    expect(refresh.accountStatus("epic")).toMatchObject({
      needsSignIn: true,
      lastError: expect.stringContaining("Sign in again"),
    });
  });

  it("a refresh that takes too long is stopped, and saves nothing after", async () => {
    let finish: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    registerStoreClient(
      fakeClient("epic", async () => {
        await finished;
        return games(7);
      }),
    );
    storage.saveSession("epic", session("t"), host);
    storage.saveLibrary("epic", library(3));
    const err = await refresh
      .refreshLibrary("epic", { deadlineMs: 100 })
      .catch((e) => e);
    expect(isTransient(err)).toBe(true);
    expect(err.message).toContain("took longer than");
    // The store answers after all: too late.
    finish!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(refresh.cachedLibrary("epic")?.games).toHaveLength(3);
  });

  it("a host that can't talk to the stores uses the cache", async () => {
    registerStoreClient(fakeClient("epic", async () => games(9)));
    storage.saveSession("epic", session("t"), host);
    host.canRefresh = false;
    await expect(refresh.refreshIfStale("epic")).rejects.toThrow(
      "hasn't been fetched yet",
    );
    storage.saveLibrary("epic", library(2));
    expect((await refresh.refreshIfStale("epic")).games).toHaveLength(2);
    await expect(refresh.refreshLibrary("epic")).rejects.toThrow(
      "can't talk to the stores",
    );
    await expect(
      refresh.completeLogin(refresh.pendingLogin("epic"), { pasted: "x" }),
    ).rejects.toThrow("can't talk to the stores");
  });

  it("a host that can't refresh one store uses its cache, records nothing", async () => {
    let asked = 0;
    registerStoreClient(
      fakeClient("epic", async () => {
        asked++;
        return games(9);
      }),
    );
    storage.saveSession("epic", session("t"), host);
    storage.saveLibrary("epic", library(2));
    host.refreshes = (store) => store !== "epic";
    try {
      expect((await refresh.refreshIfStale("epic")).games).toHaveLength(2);
      await expect(refresh.refreshLibrary("epic")).rejects.toThrow(
        "can't fetch the Epic Games Store library",
      );
      expect(asked).toBe(0);
      expect(refresh.accountStatus("epic").lastError).toBeNull();
    } finally {
      delete host.refreshes;
    }
  });

  it("offline: libraries aren't fetched by themselves, only when asked", async () => {
    let asked = 0;
    registerStoreClient(
      fakeClient("epic", async () => {
        asked++;
        return games(5);
      }),
    );
    storage.saveSession("epic", session("t"), host);
    storage.saveLibrary("epic", library(2));
    let offline = true;
    refresh.setStoresOffline(() => offline);
    try {
      expect((await refresh.refreshIfStale("epic")).games).toHaveLength(2);
      expect(asked).toBe(0);
      expect((await refresh.refreshLibrary("epic")).games).toHaveLength(5);
      // (the live setting: going online fetches an old library again)
      offline = false;
      refresh.setStoreClock(() => Date.now() + refresh.LIBRARY_MAX_AGE_MS * 2);
      await refresh.refreshIfStale("epic");
      expect(asked).toBe(2);
    } finally {
      refresh.setStoresOffline(false);
    }
  });

  it("callers wait for one refresh instead of each making their own", async () => {
    let asked = 0;
    registerStoreClient(
      fakeClient("epic", async () => {
        asked++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return games(4);
      }),
    );
    storage.saveSession("epic", session("t"), host);
    const all = await Promise.all([
      refresh.refreshIfStale("epic"),
      refresh.refreshIfStale("epic"),
      refresh.refreshIfStale("epic"),
    ]);
    expect(asked).toBe(1);
    expect(all.map((l) => l.games.length)).toEqual([4, 4, 4]);
  });

  it("signs out: tells the store where it can, and forgets the account", async () => {
    const told: string[] = [];
    registerStoreClient(
      fakeClient("amazon", async () => games(1), {
        signOut: async (s) => {
          told.push(s.data.token);
          throw transient(
            "no connection to https://api.example/x?token=SECRET",
          );
        },
      }),
    );
    storage.saveSession("amazon", session("t"), host);
    storage.saveLibrary("amazon", library(2));
    storage.saveFailure("amazon", { at: 1, message: "x", needsSignIn: true });
    const warning = await refresh.signOut("amazon");
    expect(told).toEqual(["t"]);
    expect(warning).toContain("may still list SRM's login");
    expect(warning).not.toContain("SECRET");
    expect(refresh.accountStatus("amazon")).toMatchObject({
      signedIn: false,
      gameCount: null,
      lastError: null,
    });
  });
});
