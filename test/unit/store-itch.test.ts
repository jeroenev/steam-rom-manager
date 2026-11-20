// itch.io accounts (ported from BoilR's itch.rs tests, plus a sign-in and a
// refresh against a fake itch.io).
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyStoreHost, setStoreHost } from "../../src/lib/stores/host";
import { isLoginRejected, isTransient } from "../../src/lib/stores/http";
import * as itch from "../../src/lib/stores/itch";
import * as refresh from "../../src/lib/stores/refresh";
import { sessionData } from "../../src/lib/stores/storage";
import { OwnedGame } from "../../src/lib/stores/types";
import { FakeStoreHost, storeFixture } from "../helpers/fake-store-host";

const PROFILE = storeFixture("itch", "profile.json");
const OWNED_KEYS = storeFixture("itch", "owned_keys_page1.json");
const OWNED_KEYS_EMPTY = storeFixture("itch", "owned_keys_empty.json");
const INVALID_KEY = storeFixture("itch", "invalid_key.json");

const keys = (text: string) => itch.parseOwnedKeys(text) || [];
const ids = (games: OwnedGame[]) => games.map((g) => g.id);

// A page of keys with these key ids, each for the game with the same id.
const pageOf = (keyIds: number[]) =>
  JSON.stringify({
    owned_keys: keyIds.map((id) => ({
      id,
      game_id: id,
      game: { id, title: `Game ${id}` },
    })),
  });

describe("itch.io", () => {
  it("has no login window", () => {
    const pending = itch.beginLogin();
    expect(pending.doneUrlPrefixes).toEqual([]);
    expect(pending.manual.kind).toBe("paste");
  });

  it("reads the profile", () => {
    expect(itch.accountName(itch.parseProfile(PROFILE))).toBe("leafo");
  });

  it("an invalid key is a readable error", () => {
    let err: unknown;
    try {
      itch.parseProfile(INVALID_KEY);
    } catch (e) {
      err = e;
    }
    expect(isLoginRejected(err)).toBe(true);
    expect((err as Error).message).toContain("rejected the API key");
  });

  it("an unreadable session asks for a new sign-in", () => {
    expect(() =>
      sessionData(
        "itch",
        { accountName: null, data: { userId: 3423 } },
        (d) => typeof d.apiKey === "string",
      ),
    ).toThrow(/Sign in again/);
  });

  it("an answer with an error field is an error whatever its shape", () => {
    const errorOf = (text: string) => {
      try {
        keys(text);
        return undefined;
      } catch (err) {
        return err as Error;
      }
    };
    // A text instead of a list, and the singular name.
    expect(errorOf('{"errors": "rate limited"}')?.message).toContain(
      "rate limited",
    );
    expect(errorOf('{"error": "server busy"}')?.message).toContain(
      "server busy",
    );
    // An object, a list of objects, an empty list.
    expect(errorOf('{"errors": {"code": 500}}')?.message).toContain("500");
    expect(errorOf('{"errors": [{"message": "broken"}]}')?.message).toContain(
      "broken",
    );
    expect(errorOf('{"errors": []}')?.message).toContain("no details");
    expect(errorOf('{"error": true}')).toBeDefined();
    // Also next to a list of keys: an answer doesn't get to be both.
    expect(errorOf('{"errors": ["failed"], "owned_keys": []}')).toBeDefined();

    // These say nothing about the API key.
    expect(isLoginRejected(errorOf('{"errors": "rate limited"}'))).toBe(false);
    // This one does.
    expect(isLoginRejected(errorOf('{"error": "invalid key"}'))).toBe(true);
    // An error of an unknown shape isn't taken for a refused key, whatever
    // its fields are called.
    const odd = errorOf(
      '{"errors": {"api_key": "x", "reason": "maintenance"}}',
    );
    expect(odd).toBeDefined();
    expect(isLoginRejected(odd)).toBe(false);

    // A null field is no error.
    expect(errorOf('{"errors": null, "owned_keys": []}')).toBeUndefined();
  });

  it("lists games and tools and skips other classifications", () => {
    const games = itch.ownedGames(keys(OWNED_KEYS));
    // 999 is a second key for 284880, 555 an asset pack, 556 a soundtrack,
    // 557 has no game.
    expect(ids(games)).toEqual(["284880", "123456", "777"]);
    const [pikuniku, tool, web] = games;
    expect(pikuniku.title).toBe("Pikuniku");
    // Only the extra the install target reads.
    expect(pikuniku.extra).toEqual({
      url: "https://sectordub.itch.io/pikuniku",
    });
    expect(tool.title).toBe("Pixel Tool");
    // A browser game names no platform and stays.
    expect(web.title).toBe("Browser Jam Game");
    expect(games.every((g) => g.store === "itch")).toBe(true);
  });

  it("skips games for other platforms only", () => {
    expect(itch.runsHere(["p_windows"])).toBe(true);
    expect(itch.runsHere(["p_linux", "has_demo"])).toBe(true);
    expect(itch.runsHere(["p_osx", "p_android", "p_windows"])).toBe(true);
    expect(itch.runsHere(["p_android"])).toBe(false);
    expect(itch.runsHere(["p_osx", "can_be_bought"])).toBe(false);
    expect(itch.runsHere(["p_osx", "p_android"])).toBe(false);
    // No platform named: a browser game, or an upload nobody tagged.
    expect(itch.runsHere([])).toBe(true);
    expect(itch.runsHere(["can_be_bought", "has_demo"])).toBe(true);

    const games = itch.ownedGames(
      keys(`{"owned_keys": [
        {"id": 1, "game_id": 1, "game": {"id": 1, "title": "Phone Game", "traits": ["p_android"]}},
        {"id": 2, "game_id": 2, "game": {"id": 2, "title": "Mac Game", "traits": ["p_osx"]}},
        {"id": 3, "game_id": 3, "game": {"id": 3, "title": "Penguin Game", "traits": ["p_linux"]}},
        {"id": 4, "game_id": 4, "game": {"id": 4, "title": "Untagged", "traits": {}}},
        {"id": 5, "game_id": 5, "game": {"id": 5, "title": "No Traits"}}
      ]}`),
    );
    expect(ids(games)).toEqual(["3", "4", "5"]);
  });

  it("reads lists the way Lua writes them", () => {
    // Lua sends an empty list as an empty object.
    expect(keys('{"page": 3, "owned_keys": {}}')).toEqual([]);
    expect(itch.parseOwnedKeys('{"page": 3, "owned_keys": {}}')).toBeDefined();
    expect(itch.parseOwnedKeys('{"page": 3, "per_page": 50}')).toBeUndefined();
    expect(itch.parseOwnedKeys('{"owned_keys": null}')).toBeUndefined();
    const read = keys(`{"owned_keys": {
      "2": {"game_id": 2, "game": {"id": 2, "title": "B", "traits": {}}},
      "1": {"game_id": 1, "game": {"id": 1, "title": "A", "traits": ["p_windows"]}}}}`);
    expect(read.map((k) => k.game_id)).toEqual([1, 2]);
    expect(read[1].game?.traits).toEqual([]);
    expect(() => keys('{"owned_keys": 3}')).toThrow("expected a list");
  });

  it("only an empty page ends the paging", () => {
    const first = itch.firstPage();
    expect(first.number).toBe(1);

    // A page with keys is followed by the next number, however short.
    const [one, second] = itch.readPage(pageOf([1]), first);
    expect(one).toHaveLength(1);
    expect(second?.number).toBe(2);

    // An empty list ends it: as a list, as Lua's empty object, as the
    // fixture.
    for (const empty of [
      '{"owned_keys": []}',
      '{"owned_keys": {}}',
      OWNED_KEYS_EMPTY,
    ]) {
      expect(itch.readPage(empty, second!)).toEqual([[], null]);
    }
    // An account without keys.
    expect(itch.readPage('{"owned_keys": []}', first)).toEqual([[], null]);
    // A later page without a list ends it too.
    expect(itch.readPage('{"page": 2, "per_page": 500}', second!)).toEqual([
      [],
      null,
    ]);
  });

  it("an answer that is no page of keys fails the list", () => {
    const first = itch.firstPage();
    const [, second] = itch.readPage(pageOf([1, 2]), first);

    // The first page must hold a list: an answer without one isn't an empty
    // account.
    expect(() => itch.readPage('{"page": 1, "per_page": 500}', first)).toThrow(
      "no list of keys",
    );
    expect(() => itch.readPage("{}", first)).toThrow();

    // An error in the middle of the list isn't its end.
    for (const answer of [
      '{"error": "server busy"}',
      '{"errors": "rate limited"}',
      '{"errors": ["something broke"]}',
    ]) {
      expect(() => itch.readPage(answer, second!)).toThrow();
      expect(() => itch.readPage(answer, first)).toThrow();
    }
    expect(() => itch.readPage("<html>Bad gateway</html>", second!)).toThrow();
  });

  it("a page that repeats the one before fails the list", () => {
    const [, second] = itch.readPage(pageOf([1, 2]), itch.firstPage());
    // A server that ignores `page` answers every number with the first page.
    expect(() => itch.readPage(pageOf([1, 2]), second!)).toThrow(
      /page 2.*page 1.*incomplete/,
    );
    // Other keys are another page, also when it starts with the same key.
    const [read, next] = itch.readPage(pageOf([1, 3]), second!);
    expect(read).toHaveLength(2);
    expect(next?.number).toBe(3);
  });

  it("reads a pasted key", () => {
    expect(itch.parsePastedKey("  AbC123xyz \n")).toBe("AbC123xyz");
    expect(itch.parsePastedKey("")).toBeUndefined();
    expect(itch.parsePastedKey("not a key")).toBeUndefined();
  });
});

describe("itch.io account", () => {
  const host = new FakeStoreHost(({ url, init }) => {
    if (init.headers?.Authorization !== "Bearer AbC123") {
      return { status: 200, body: INVALID_KEY };
    }
    const u = new URL(url);
    if (u.pathname === "/profile") {
      return { body: PROFILE };
    }
    if (u.pathname === "/profile/owned-keys") {
      return {
        body:
          u.searchParams.get("page") === "1" ? OWNED_KEYS : OWNED_KEYS_EMPTY,
      };
    }
    return { status: 404 };
  });
  beforeEach(() => setStoreHost(host));
  afterEach(() => refresh.deleteAccount("itch"));
  afterAll(() => setStoreHost(readOnlyStoreHost));

  it("signs in with a pasted key and lists the games", async () => {
    const pending = refresh.pendingLogin("itch");
    await expect(
      refresh.completeLogin(pending, { pasted: "not a key" }),
    ).rejects.toThrow("not an itch.io API key");
    await expect(
      refresh.completeLogin(pending, { pasted: "Wrong123" }),
    ).rejects.toSatisfy(isLoginRejected);
    expect(await refresh.completeLogin(pending, { pasted: " AbC123 " })).toBe(
      "leafo",
    );

    const library = await refresh.refreshLibrary("itch");
    expect(ids(library.games)).toEqual(["123456", "284880", "777"]);
    expect(library.accountName).toBe("leafo");
    const pages = host.requests
      .filter((r) => r.url.includes("owned-keys"))
      .map((r) => new URL(r.url).searchParams.get("page"));
    expect(pages).toEqual(["1", "2"]);
    expect(refresh.accountStatus("itch")).toMatchObject({
      signedIn: true,
      accountName: "leafo",
      gameCount: 3,
    });
  });
});

describe("itch.io refusing a key", () => {
  // What api.itch.io answers a key it doesn't take (seen in 2026): 403 with
  // its error about the key.
  let keyWorks = true;
  const host = new FakeStoreHost(({ url, init }) => {
    if (!keyWorks || init.headers?.Authorization !== "Bearer AbC123") {
      return { status: 403, body: INVALID_KEY };
    }
    const u = new URL(url);
    if (u.pathname === "/profile") {
      return { body: PROFILE };
    }
    return {
      body: u.searchParams.get("page") === "1" ? OWNED_KEYS : OWNED_KEYS_EMPTY,
    };
  });
  beforeEach(() => {
    keyWorks = true;
    setStoreHost(host);
  });
  afterEach(() => refresh.deleteAccount("itch"));
  afterAll(() => setStoreHost(readOnlyStoreHost));

  it("a key refused with 403 is a refused login, at sign-in and refresh", async () => {
    const pending = refresh.pendingLogin("itch");
    const err = await refresh
      .completeLogin(pending, { pasted: "Wrong123" })
      .catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    expect(err.message).toContain("itch.io rejected the API key (invalid key)");

    await refresh.completeLogin(pending, { pasted: "AbC123" });
    await refresh.refreshLibrary("itch");
    // The key is revoked: the account asks for a new sign-in.
    keyWorks = false;
    await expect(refresh.refreshLibrary("itch")).rejects.toSatisfy(
      isLoginRejected,
    );
    expect(refresh.accountStatus("itch")).toMatchObject({
      needsSignIn: true,
      gameCount: 3,
    });
  });

  it("other failed answers keep their status", () => {
    const answer = (status: number) => ({
      ok: false,
      status,
      url: "https://api.itch.io/profile?x=1",
    });
    expect(() =>
      itch.checkAnswer(answer(503), "<html>Bad gateway</html>"),
    ).toThrow(/503 Service Unavailable from https:\/\/api\.itch\.io\/profile:/);
    let err: unknown;
    try {
      itch.checkAnswer(answer(429), '{"errors":["slow down"]}');
    } catch (e) {
      err = e;
    }
    expect(isTransient(err)).toBe(true);
    expect(isLoginRejected(err)).toBe(false);
    expect(() =>
      itch.checkAnswer({ ...answer(200), ok: true }, "{}"),
    ).not.toThrow();
  });
});
