// Battle.net accounts (ported from BoilR's battlenet.rs tests, plus a
// sign-in and refreshes against a fake Battle.net).
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import * as battlenet from "../../src/lib/stores/battlenet";
import { readOnlyStoreHost, setStoreHost } from "../../src/lib/stores/host";
import {
  BROWSER_USER_AGENT,
  HttpStatus,
  StoreHttp,
  domainMatches,
  isLoginRejected,
  isTransient,
  statusOf,
  transient,
} from "../../src/lib/stores/http";
import * as refresh from "../../src/lib/stores/refresh";
import {
  registerStoreClient,
  storeClient,
  unregisterStoreClient,
} from "../../src/lib/stores/registry";
import * as storage from "../../src/lib/stores/storage";
import {
  ListContext,
  OwnedGame,
  StoreCookie,
  StoreSession,
} from "../../src/lib/stores/types";
import {
  FakeAnswer,
  FakeRequest,
  FakeStoreHost,
  storeFixture,
} from "../helpers/fake-store-host";

const ANONYMOUS = storeFixture("battlenet", "api_status_anonymous.json");
const AUTHENTICATED = storeFixture(
  "battlenet",
  "api_status_authenticated.json",
);
const GAMES = storeFixture("battlenet", "games_and_subs.json");
const CLASSIC = storeFixture("battlenet", "classic_games.json");
const DETAILS = storeFixture("battlenet", "details.json");

const cookie = (name: string, value: string, domain: string): StoreCookie => ({
  name,
  value,
  domain,
});

const ids = (games: readonly OwnedGame[]) => games.map((g) => g.id);

const accounts = (json: string) =>
  battlenet.ownedGames(battlenet.parseGamesAndSubs(JSON.parse(json)));

const fromFixtures = (withClassic = true) =>
  battlenet.ownedGames(
    battlenet.parseGamesAndSubs(JSON.parse(GAMES)),
    withClassic ? battlenet.parseClassicGames(JSON.parse(CLASSIC)) : [],
  );

// The error `work` throws, or undefined.
function thrown(work: () => unknown): any {
  try {
    work();
  } catch (err) {
    return err;
  }
  return undefined;
}

const refused = (err: unknown) => err !== undefined && isLoginRejected(err);
const outage = (err: unknown) =>
  err !== undefined && isTransient(err) && !isLoginRejected(err);
const unexpected = (err: unknown) =>
  err !== undefined && !isTransient(err) && !isLoginRejected(err);

describe("Battle.net", () => {
  it("login URLs do not finish early", () => {
    const pending = battlenet.beginLogin();
    const done = (url: string) =>
      pending.doneUrlPrefixes.some((prefix) => url.startsWith(prefix));
    expect(done(pending.startUrl)).toBe(false);
    // The pages the sign-in goes through (seen 2026-11-08).
    expect(
      done(
        "https://oauth.battle.net/authorize?response_type=code&client_id=x&redirect_uri=https://account.battle.net/callback/oauth2/code/account-settings",
      ),
    ).toBe(false);
    expect(
      done(
        "https://eu.account.battle.net/login/en-us/?ref=https://oauth.battle.net/authorize?redirect_uri%3Dhttps://account.battle.net/callback/oauth2/code/account-settings&app=bas",
      ),
    ).toBe(false);
    expect(done("https://account.battle.net/overview")).toBe(false);
    expect(
      done(
        "https://account.battle.net/callback/oauth2/code/account-settings?code=abc&state=x",
      ),
    ).toBe(true);
    // Nothing to read on the done page, and nothing to paste.
    expect(pending.pageTextUrlPrefixes).toEqual([]);
    expect(pending.manual.kind).toBe("unsupported");
    expect(pending.store).toBe("battlenet");
  });

  it("the login window is asked for the cookies of every host in the sign-in", () => {
    const pending = battlenet.beginLogin();
    for (const host of [
      "account.battle.net",
      "oauth.battle.net",
      "eu.account.battle.net",
    ]) {
      expect(pending.cookieUrls).toContain(`https://${host}/`);
    }
    expect(pending.cookieUrls).toHaveLength(battlenet.SESSION_HOSTS.length);
    // The sign-in is replayed under the user agent it was made with.
    expect(pending.userAgent).toBe(BROWSER_USER_AGENT);
  });

  it("only cookies a browser would send during the sign-in count", () => {
    // Domains as a login window reports them: `.battle.net` may come as
    // `battle.net`.
    const captured = [
      cookie("site", "1", "battle.net"),
      cookie("oauth", "2", "oauth.battle.net"),
      cookie("region", "3", "eu.battle.net"),
      cookie("session", "4", "account.battle.net"),
      cookie("login", "5", "eu.account.battle.net"),
      cookie("shop", "6", "shop.battle.net"),
      cookie("tracker", "7", "example.com"),
      cookie("lookalike", "8", "notbattle.net"),
      cookie("dotted", "9", ".battle.net"),
      cookie("nowhere", "10", "."),
    ];
    const kept = battlenet.sessionCookies(captured);
    // `eu.battle.net` is not `eu.account.battle.net`: no host of the sign-in
    // gets it.
    expect(kept.map((c) => c.name)).toEqual([
      "site",
      "oauth",
      "session",
      "login",
      "dotted",
    ]);
    // The site-wide cookie reaches the OAuth service, where the sign-in is
    // replayed.
    const sentToOauth = kept
      .filter((c) => domainMatches(c.domain, "oauth.battle.net"))
      .map((c) => c.name)
      .sort();
    expect(sentToOauth).toEqual(["dotted", "oauth", "site"]);
  });

  it("reads the sign-in status", () => {
    expect(battlenet.parseApiStatus(ANONYMOUS)).toBe(false);
    expect(battlenet.parseApiStatus(AUTHENTICATED)).toBe(true);
    expect(battlenet.parseApiStatus("<!doctype html>")).toBeUndefined();
    // An error object says nothing about the sign-in.
    expect(
      battlenet.parseApiStatus('{"error":"Internal Server Error"}'),
    ).toBeUndefined();
    expect(battlenet.parseApiStatus('{"authenticated":"yes"}')).toBeUndefined();
    expect(battlenet.parseApiStatus("[]")).toBeUndefined();
  });

  it("only a missing sign-in asks to sign in again", () => {
    const errorObject =
      '{"timestamp":1,"status":500,"error":"Internal Server Error"}';
    const check = (status: number, body: string) =>
      thrown(() => battlenet.checkSignedIn(status, body));

    expect(check(200, AUTHENTICATED)).toBeUndefined();
    // Without a sign-in the API answers 401 and `authenticated: false`.
    expect(refused(check(401, ANONYMOUS))).toBe(true);
    expect(refused(check(200, ANONYMOUS))).toBe(true);
    expect(refused(check(401, ""))).toBe(true);
    expect(check(401, "").message).toContain("Sign in again");

    expect(outage(check(500, errorObject))).toBe(true);
    expect(outage(check(503, "<html>Service Unavailable</html>"))).toBe(true);
    expect(outage(check(429, ""))).toBe(true);
    // An outage that also reports no sign-in is still an outage.
    expect(outage(check(502, ANONYMOUS))).toBe(true);
    expect(statusOf(check(503, ""))).toBe(503);

    // A bot block, and JSON that is not the status.
    expect(unexpected(check(403, "<html>Access Denied</html>"))).toBe(true);
    expect(unexpected(check(403, ANONYMOUS))).toBe(true);
    expect(unexpected(check(200, "{}"))).toBe(true);
    expect(unexpected(check(200, "<!doctype html>"))).toBe(true);
    expect(unexpected(check(404, errorObject))).toBe(true);
    const message: string = check(403, "<html>Access Denied</html>").message;
    expect(message).toContain("403");
    expect(message).toContain("Access Denied");
    expect(message.toLowerCase()).not.toContain("sign in again");
  });

  it("a refusal after a failed replay reports the replay", () => {
    const replay = (status: number) =>
      new HttpStatus(status, battlenet.SIGN_IN_URL, "");
    const refuse = () => {
      throw battlenet.signInRefused();
    };
    const after = (failed: Error | undefined, check: () => void) =>
      thrown(() => battlenet.afterReplay(failed, check));

    // The OAuth service was down or blocked SRM: no session, whatever the
    // sign-in is worth.
    expect(outage(after(replay(503), refuse))).toBe(true);
    expect(after(replay(503), refuse).message).toContain(
      "The Battle.net sign-in could not be renewed",
    );
    expect(unexpected(after(replay(403), refuse))).toBe(true);

    // A replay that went through leaves the check as it is.
    expect(refused(after(undefined, refuse))).toBe(true);
    expect(after(undefined, () => undefined)).toBeUndefined();
    // And a sign-in that is there is fine, whatever the replay's last page
    // answered.
    expect(after(replay(404), () => undefined)).toBeUndefined();
    const other = after(replay(404), () => {
      throw transient("timed out");
    });
    expect(isTransient(other)).toBe(true);
  });

  it("maps game accounts and classic keys to products", () => {
    const owned = fromFixtures();
    // Two WoW accounts are one game; the game the table lacks is listed
    // too; two Warcraft III keys are the game and its expansion.
    expect(ids(owned)).toEqual([
      "WoW",
      "Pro",
      "WTCG",
      "Fen",
      "title-987654321",
      "W3C",
      "W3CX",
      "D2",
    ]);
    const overwatch = owned[1];
    expect(overwatch.store).toBe("battlenet");
    expect(overwatch.title).toBe("Overwatch 2");
    expect(overwatch.extra).toEqual({ internal_id: "prometheus" });

    // Without an internal id, a shortcut opens the download page.
    const war3 = owned[5];
    expect(war3.title).toBe("Warcraft III: Reign of Chaos");
    expect(war3.extra).toEqual({});
  });

  it("names a game SRM's Battle.net parser knows as the parser does", () => {
    // The parser's ids and names (BNET_GAMES), so an installed copy and the
    // owned entry are one game.
    const byCode = (code: string) =>
      battlenet.toOwnedGame(battlenet.product(code)!);
    expect(byCode("S1").title).toBe("Starcraft Remastered");
    expect(byCode("S2").title).toBe("Starcraft 2");
    expect(byCode("W3").title).toBe("Warcraft 3: Reforged");
    expect(byCode("WTCG")).toEqual({
      store: "battlenet",
      id: "WTCG",
      title: "Hearthstone",
      extra: { internal_id: "hs_beta" },
    });
    // Games the parser doesn't know keep the table's name.
    expect(byCode("GRY").title).toBe("Warcraft Rumble");
    expect(byCode("PNTA").title).toBe("Call of Duty: Modern Warfare III");
    expect(battlenet.srmName("fen")).toBe("Diablo IV");
    expect(battlenet.srmName("W3C")).toBeUndefined();
  });

  it("a game the table lacks is listed under the account site's name", () => {
    const owned = fromFixtures(false);
    const unknown = owned[4];
    // 987654321 spells no code.
    expect(unknown.id).toBe("title-987654321");
    expect(unknown.title).toBe("A Game SRM Does Not Know");
    expect(unknown.extra).toEqual({});

    // 1094861636 is "ABCD": the code a new game most likely has in the
    // launcher.
    const logs: string[] = [];
    const fresh = battlenet.ownedGames(
      battlenet.parseGamesAndSubs(
        JSON.parse(`{"gameAccounts":[
          {"titleId":1094861636,"localizedGameName":"  Brand New\\u00ae Game\\u2122 "},
          {"titleId":1094861636,"localizedGameName":"Brand New\\u00ae Game\\u2122"},
          {"titleId":1094861637,"localizedGameName":null},
          {"titleId":1094861638,"localizedGameName":" \\u00ae "},
          {"titleId":1094861639}
        ]}`),
      ),
      [],
      (message) => logs.push(message),
    );
    // The second account of the same game adds nothing; without a name
    // there is nothing to list a game under.
    expect(ids(fresh)).toEqual(["ABCD"]);
    expect(fresh[0].title).toBe("Brand New Game");
    expect(logs.filter((l) => l.includes("is skipped"))).toHaveLength(3);
    expect(logs.filter((l) => l.includes("download page"))).toHaveLength(1);

    // A code the table knows is that product, also under a title id it
    // does not list: 1347310657 is "PNTA".
    const byCode = accounts('{"gameAccounts":[{"titleId":1347310657}]}');
    expect(ids(byCode)).toEqual(["PNTA"]);
    expect(byCode[0].extra.internal_id).toBe("pinta");
    // But never a classic game's: 17458 is "D2", which here is some other
    // game.
    const notClassic = accounts(
      '{"gameAccounts":[{"titleId":17458,"localizedGameName":"Something Else"}]}',
    );
    expect(ids(notClassic)).toEqual(["title-17458"]);
  });

  it("title ids spell product codes", () => {
    expect(battlenet.codeOfTitle(5272175)).toBe("Pro");
    expect(battlenet.codeOfTitle(1096108883)).toBe("AUKS");
    expect(battlenet.codeOfTitle(17459)).toBe("D3");
    expect(battlenet.codeOfTitle(987654321)).toBeUndefined();
    expect(battlenet.codeOfTitle(0)).toBeUndefined();
    // "A B" and "A,B": only letters and digits make a code.
    expect(battlenet.codeOfTitle(0x412042)).toBeUndefined();
    expect(battlenet.codeOfTitle(0x412c42)).toBeUndefined();
    // (no number past 2^53 is exact: BoilR's u64::MAX)
    expect(battlenet.codeOfTitle(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(battlenet.codeOfTitle(2 ** 64)).toBeUndefined();
    expect(battlenet.codeOfTitle(-5272175)).toBeUndefined();
    expect(battlenet.codeOfTitle(5272175.5)).toBeUndefined();
  });

  it("the account site's name chooses among products that share a title id", () => {
    const code = (name?: string) =>
      battlenet.productForTitle(1096108883, name)?.code;
    expect(code("Call of Duty®: Modern Warfare® III")).toBe("PNTA");
    expect(code("Call of Duty®: Modern Warfare® II")).toBe("AUKS");
    expect(code("CALL OF DUTY: MODERN WARFARE III - Vault Edition")).toBe(
      "PNTA",
    );
    // A name that does not help: the first one, as Playnite does.
    expect(code("Call of Duty®")).toBe("AUKS");
    expect(code("")).toBe("AUKS");
    expect(code(undefined)).toBe("AUKS");
    // Nothing to choose where a title id has one product.
    expect(battlenet.productForTitle(5272175, "Something else")?.code).toBe(
      "Pro",
    );
    expect(battlenet.productForTitle(987654321, "Overwatch 2")).toBeUndefined();

    // An account with only Modern Warfare III gets that game, one with both
    // gets both.
    const mw3 = accounts(`{"gameAccounts":[
      {"titleId":1096108883,"localizedGameName":"Call of Duty®: Modern Warfare® III"}
    ]}`);
    expect(ids(mw3)).toEqual(["PNTA"]);
    expect(mw3[0].title).toBe("Call of Duty: Modern Warfare III");
    const both = accounts(`{"gameAccounts":[
      {"titleId":1096108883,"localizedGameName":"Call of Duty®: Modern Warfare® III"},
      {"titleId":1096108883,"localizedGameName":"Call of Duty®: Modern Warfare® II"}
    ]}`);
    expect(ids(both)).toEqual(["PNTA", "AUKS"]);
  });

  it("a failed classic list keeps the classic games from before", () => {
    // A list saved by an earlier version marks classic games with an extra.
    const before = fromFixtures().map((game) =>
      game.id === "D2" ? { ...game, extra: { launcher: "false" } } : game,
    );
    const now = battlenet.withPreviousClassicGames(fromFixtures(false), before);
    expect(ids(now)).toEqual([
      "WoW",
      "Pro",
      "WTCG",
      "Fen",
      "title-987654321",
      "W3C",
      "W3CX",
      "D2",
    ]);
    // Classic games come back as this version lists them.
    expect(now.slice(5).every((g) => Object.keys(g.extra).length === 0)).toBe(
      true,
    );
    // Only classic games are carried over: a game no longer listed is gone.
    const gone = battlenet.withPreviousClassicGames(
      [],
      [battlenet.toOwnedGame(battlenet.product("Pro")!)],
    );
    expect(gone).toEqual([]);
  });

  it("empty lists give no games", () => {
    expect(accounts('{"gameAccounts":[]}')).toEqual([]);
    const nullAccounts = battlenet.parseGamesAndSubs({ gameAccounts: null });
    expect(
      battlenet.ownedGames(
        nullAccounts,
        battlenet.parseClassicGames({ classicGames: null }),
      ),
    ).toEqual([]);
    expect(
      battlenet.ownedGames(nullAccounts, battlenet.parseClassicGames({})),
    ).toEqual([]);
  });

  it("an answer without the game list is not an empty library", () => {
    // Another shape, or an error object: not "no games".
    for (const body of [
      "{}",
      '{"games":[{"titleId":5272175}]}',
      '{"timestamp":1,"status":500,"error":"Internal Server Error"}',
      '{"gameAccounts":{"titleId":5272175}}',
      "[]",
      "null",
    ]) {
      const err = thrown(() => battlenet.parseGamesAndSubs(JSON.parse(body)));
      expect(err?.message, body).toContain("Unexpected answer");
      expect(unexpected(err), body).toBe(true);
    }
    // Entries that carry nothing SRM knows them by.
    const renamed = thrown(() =>
      accounts('{"gameAccounts":[{"programId":5272175},{"programId":17459}]}'),
    );
    expect(renamed?.message).toContain("Unexpected answer");
    // One entry without a title id among good ones is passed over.
    expect(
      ids(
        accounts(
          '{"gameAccounts":[{"titleId":5272175},{"gameAccountName":"x"},7]}',
        ),
      ),
    ).toEqual(["Pro"]);
    // A title id sent as text is still that title id.
    expect(ids(accounts('{"gameAccounts":[{"titleId":"5272175"}]}'))).toEqual([
      "Pro",
    ]);
  });

  it("an unexpected classic list never shows the CD keys", () => {
    const keys = '{"classicGames":{"cdKeys":["SECRET-CD-KEY"]}}';
    const err = thrown(() => battlenet.parseClassicGames(JSON.parse(keys)));
    expect(err?.message).toContain("Unexpected answer");
    expect(err?.message).not.toContain("SECRET-CD-KEY");
    expect(thrown(() => battlenet.parseClassicGames([]))?.message).toContain(
      "not an object",
    );
    // A key without an icon is no game.
    expect(
      battlenet.ownedGames(
        [],
        battlenet.parseClassicGames({
          classicGames: [{ cdKeys: ["X"] }, null],
        }),
      ),
    ).toEqual([]);
  });

  it("reads the BattleTag", () => {
    expect(battlenet.parseBattleTag(JSON.parse(DETAILS))).toBe("Player#2187");
    expect(battlenet.parseBattleTag({ battleTag: "  " })).toBeNull();
    expect(battlenet.parseBattleTag({})).toBeNull();
    expect(battlenet.parseBattleTag(null)).toBeNull();
  });

  it("franchise icons do not overlap", () => {
    expect(battlenet.isFranchise("diablo-ii.png", "diablo-ii")).toBe(true);
    expect(battlenet.isFranchise("D2-Diablo-II-LoD.png", "diablo-ii")).toBe(
      true,
    );
    expect(battlenet.isFranchise("diablo-iii.png", "diablo-ii")).toBe(false);
    expect(
      battlenet.isFranchise("warcraft-iii-frozen-throne.png", "warcraft-iii"),
    ).toBe(true);
  });

  it("the product table is consistent", () => {
    battlenet.PRODUCTS.forEach((p, i) => {
      expect(
        battlenet.PRODUCTS.slice(i + 1).some((q) => q.code === p.code),
        `duplicate code ${p.code}`,
      ).toBe(false);
      // The launcher knows a game, by its internal id, exactly when it is
      // not classic.
      expect(p.internalId === undefined, p.code).toBe(battlenet.isClassic(p));
    });
    expect(battlenet.product("pro")?.internalId).toBe("prometheus");
    expect(battlenet.isClassic(battlenet.product("W3C")!)).toBe(true);
    // Title ids spell the product code, but for a few games whose account
    // entry goes by another name (Diablo is "DRTL") and for Modern Warfare
    // III.
    const spelledOtherwise = battlenet.PRODUCTS.filter(
      (p) =>
        p.titleId !== undefined && battlenet.codeOfTitle(p.titleId) !== p.code,
    ).map((p) => p.code);
    expect(spelledOtherwise).toEqual(["D1", "W1", "W2", "PNTA"]);
  });

  it("reads the XSRF token from the account site's cookies", () => {
    expect(
      battlenet.xsrfFrom([
        cookie("SESSION", "s", "account.battle.net"),
        cookie("XSRF-TOKEN", "x-1", "account.battle.net"),
      ]),
    ).toBe("x-1");
    // A cookie for the whole site reaches the account site too.
    expect(
      battlenet.xsrfFrom([cookie("XSRF-TOKEN", "x-2", ".battle.net")]),
    ).toBe("x-2");
    // Another site's, an empty one, or none.
    expect(
      battlenet.xsrfFrom([cookie("XSRF-TOKEN", "x-3", "shop.battle.net")]),
    ).toBeUndefined();
    expect(
      battlenet.xsrfFrom([cookie("XSRF-TOKEN", "", "account.battle.net")]),
    ).toBeUndefined();
    expect(battlenet.xsrfFrom([])).toBeUndefined();
    expect(battlenet.xsrfFrom(undefined)).toBeUndefined();
  });

  it("an unreadable session asks to sign in again", async () => {
    const host = new FakeStoreHost();
    const ctx = listContext(host);
    for (const data of [{}, { cookies: [] }, { signedInAt: "yesterday" }]) {
      await expect(
        battlenet.battlenetClient.listLibrary({ accountName: null, data }, ctx),
      ).rejects.toSatisfy(
        (err: Error) =>
          isLoginRejected(err) && err.message.includes("Sign in again"),
      );
    }
    expect(host.requests).toEqual([]);
  });
});

// A fake Battle.net. The store's browser partition is the state here: the
// long-lived sign-in cookies, and the account site's session and XSRF token
// that each replay of the OAuth sign-in renews.
class FakeBattleNet {
  // Battle.net's sign-in cookies are in the partition.
  signedIn = true;
  // The account site's session (about 30 minutes at Battle.net).
  accountSession: string | null = null;
  xsrf: string | null = null;
  sessions = 0;
  // An answer for the replay instead of the sign-in (an outage, a block).
  replayAnswer?: FakeAnswer;
  classicAnswer?: FakeAnswer;
  // Refuses account API calls without the X-XSRF-TOKEN header.
  requireXsrf = false;

  reset() {
    this.signedIn = true;
    this.accountSession = null;
    this.xsrf = null;
    this.sessions = 0;
    this.replayAnswer = undefined;
    this.classicAnswer = undefined;
    this.requireXsrf = false;
  }

  handle = ({ url, init }: FakeRequest): FakeAnswer => {
    if (url === battlenet.SIGN_IN_URL) {
      if (this.replayAnswer) {
        return this.replayAnswer;
      }
      if (!this.signedIn) {
        return {
          url: "https://eu.account.battle.net/login/en/?ref=https://oauth.battle.net/authorize",
          body: "<!doctype html><title>Battle.net Login</title>",
        };
      }
      this.sessions++;
      this.accountSession = `account-session-secret-${this.sessions}`;
      this.xsrf = `xsrf-secret-${this.sessions}`;
      return {
        url: "https://account.battle.net/",
        body: "<!doctype html><title>Account</title>",
      };
    }
    if (url === battlenet.API_STATUS_URL) {
      return this.accountSession
        ? { body: AUTHENTICATED }
        : { status: 401, body: ANONYMOUS };
    }
    if (!this.accountSession) {
      return { status: 401, body: ANONYMOUS };
    }
    const sent = init.headers?.["X-XSRF-TOKEN"];
    if ((sent !== undefined || this.requireXsrf) && sent !== this.xsrf) {
      return { status: 403, body: '{"error":"Forbidden"}' };
    }
    switch (url) {
      case battlenet.DETAILS_URL:
        return { body: DETAILS };
      case battlenet.GAMES_URL:
        return { body: GAMES };
      case battlenet.CLASSIC_GAMES_URL:
        return this.classicAnswer ?? { body: CLASSIC };
    }
    return { status: 404 };
  };

  // The cookies the partition sends to `url` (what the host reads).
  cookies = async (url: string): Promise<StoreCookie[]> => {
    const jar: StoreCookie[] = [];
    if (this.signedIn) {
      jar.push(cookie("BA-tassadar", "sign-in-secret", "battle.net"));
    }
    if (this.accountSession) {
      jar.push(cookie("SESSION", this.accountSession, "account.battle.net"));
      jar.push(cookie("XSRF-TOKEN", this.xsrf, "account.battle.net"));
    }
    const host = new URL(url).hostname;
    return jar.filter((c) => domainMatches(c.domain, host));
  };
}

// What the login window hands over: the partition's cookies of the hosts
// the sign-in passed through.
const WINDOW_CAPTURE = {
  finalUrl:
    "https://account.battle.net/callback/oauth2/code/account-settings?code=code-secret&state=s",
  cookies: [
    cookie("BA-tassadar", "sign-in-secret", "battle.net"),
    cookie("web.id", "web-secret", "eu.account.battle.net"),
  ],
};

// A store context as the refresh makes one, plus the host's cookie read.
function listContext(
  host: FakeStoreHost,
  extra: Partial<ListContext> = {},
): ListContext {
  return {
    http: new StoreHttp(host.fetchFor("battlenet")),
    now: () => 1_000_000,
    log: (message) => host.logs.push(message),
    previous: [],
    checkpoint: async () => undefined,
    ...extra,
  };
}

const SIGNED_IN: StoreSession = {
  accountName: null,
  data: { signedInAt: 1 },
};

describe("Battle.net account, the module", () => {
  const fake = new FakeBattleNet();
  const host = new FakeStoreHost(fake.handle);
  const withCookies = () => listContext(host, { cookies: fake.cookies });
  const urls = () => host.requests.map((r) => r.url);
  const xsrfSent = (url: string) =>
    host.requests
      .filter((r) => r.url === url)
      .map((r) => r.init.headers?.["X-XSRF-TOKEN"]);

  beforeEach(() => {
    fake.reset();
    host.requests.length = 0;
    host.logs.length = 0;
  });

  it("signs in through the partition, and keeps no cookie", async () => {
    const session = await battlenet.battlenetClient.completeLogin(
      battlenet.beginLogin(),
      WINDOW_CAPTURE,
      withCookies(),
    );
    expect(session).toEqual({
      accountName: "Player#2187",
      data: { signedInAt: 1_000_000 },
    });
    // The OAuth sign-in is replayed first: the window stopped before the
    // account site got its code.
    expect(urls()).toEqual([
      battlenet.SIGN_IN_URL,
      battlenet.API_STATUS_URL,
      battlenet.DETAILS_URL,
    ]);
    // The account API gets the account site's XSRF token, as its page sends
    // it.
    expect(xsrfSent(battlenet.DETAILS_URL)).toEqual(["xsrf-secret-1"]);
    expect(JSON.stringify(session)).not.toContain("secret");
  });

  it("every refresh renews the account site's session first", async () => {
    fake.requireXsrf = true;
    const ctx = withCookies();
    const first = { ...SIGNED_IN, data: { ...SIGNED_IN.data } };
    const result = await battlenet.battlenetClient.listLibrary(first, ctx);
    expect(ids(result.games)).toEqual([
      "WoW",
      "Pro",
      "WTCG",
      "Fen",
      "title-987654321",
      "W3C",
      "W3CX",
      "D2",
    ]);
    expect(result.partial).toBeFalsy();
    expect(first.accountName).toBe("Player#2187");
    expect(first.data).toEqual({ signedInAt: 1 });
    expect(urls()[0]).toBe(battlenet.SIGN_IN_URL);
    expect(xsrfSent(battlenet.GAMES_URL)).toEqual(["xsrf-secret-1"]);

    // Half an hour later the account site's session is gone: the replay
    // gives a new one, with a new token.
    fake.accountSession = null;
    host.requests.length = 0;
    await battlenet.battlenetClient.listLibrary(first, ctx);
    expect(fake.sessions).toBe(2);
    expect(xsrfSent(battlenet.GAMES_URL)).toEqual(["xsrf-secret-2"]);
    expect(xsrfSent(battlenet.CLASSIC_GAMES_URL)).toEqual(["xsrf-secret-2"]);
    // The unknown game is reported, no secret is.
    expect(host.logs.join("\n")).toContain("A Game SRM Does Not Know");
    expect(host.logs.join("\n")).not.toContain("secret");
  });

  it("without the host's cookie read, the API is called without the token", async () => {
    const result = await battlenet.battlenetClient.listLibrary(
      { ...SIGNED_IN },
      listContext(host),
    );
    expect(result.games).toHaveLength(8);
    expect(xsrfSent(battlenet.GAMES_URL)).toEqual([undefined]);
    // A cookie read that fails is no reason to fail either.
    host.requests.length = 0;
    await battlenet.battlenetClient.listLibrary(
      { ...SIGNED_IN },
      listContext(host, {
        cookies: async () => {
          throw new Error("no partition");
        },
      }),
    );
    expect(xsrfSent(battlenet.GAMES_URL)).toEqual([undefined]);
  });

  it("only the sign-in window signs in", async () => {
    const pending = battlenet.beginLogin();
    await expect(
      battlenet.battlenetClient.completeLogin(
        pending,
        { pasted: "BA-tassadar=x" },
        withCookies(),
      ),
    ).rejects.toThrow("only be signed in to with SRM's sign-in window");
    // A window that handed over no battle.net cookies didn't sign in.
    await expect(
      battlenet.battlenetClient.completeLogin(
        pending,
        {
          finalUrl: WINDOW_CAPTURE.finalUrl,
          cookies: [cookie("tracker", "1", "example.com")],
        },
        withCookies(),
      ),
    ).rejects.toThrow("handed over no battle.net cookies");
    expect(host.requests).toEqual([]);

    // The account site sees nobody: the sign-in didn't take.
    fake.signedIn = false;
    const err = await battlenet.battlenetClient
      .completeLogin(pending, WINDOW_CAPTURE, withCookies())
      .catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    expect(err.message).toContain("Try signing in again");
  });

  it("a sign-in the OAuth service couldn't renew is not a refused login", async () => {
    // The replay ends on the callback, with the code in its address, and
    // the account site fails there.
    fake.replayAnswer = {
      status: 500,
      url: "https://account.battle.net/callback/oauth2/code/account-settings?code=code-secret&state=state-secret",
      body: '{"error":"Internal Server Error","access_token":"token-secret"}',
    };
    const err = await battlenet.battlenetClient
      .listLibrary({ ...SIGNED_IN }, withCookies())
      .catch((e) => e);
    expect(outage(err)).toBe(true);
    expect(err.message).toContain("could not be renewed");
    expect(err.message).toContain(
      "https://account.battle.net/callback/oauth2/code/account-settings",
    );
    expect(err.message).not.toContain("code-secret");
    expect(err.message).not.toContain("state-secret");
    expect(err.message).not.toContain("token-secret");
    // Blocked by a bot check: neither.
    fake.replayAnswer = { status: 403, body: "<html>Access Denied</html>" };
    const blocked = await battlenet.battlenetClient
      .listLibrary({ ...SIGNED_IN }, withCookies())
      .catch((e) => e);
    expect(unexpected(blocked)).toBe(true);
    // No connection at all: transient.
    const offline = new FakeStoreHost(() => new Error("getaddrinfo ENOTFOUND"));
    const noNetwork = await battlenet.battlenetClient
      .listLibrary({ ...SIGNED_IN }, listContext(offline))
      .catch((e) => e);
    expect(outage(noNetwork)).toBe(true);
  });

  it("the game list failing fails the refresh, the classic list only marks it partial", async () => {
    const before = [
      battlenet.toOwnedGame(battlenet.product("W3C")!),
      battlenet.toOwnedGame(battlenet.product("D2X")!),
    ];
    fake.classicAnswer = { status: 503, body: "<html>Down</html>" };
    const result = await battlenet.battlenetClient.listLibrary(
      { ...SIGNED_IN },
      listContext(host, { cookies: fake.cookies, previous: before }),
    );
    expect(result.partial).toBe(true);
    expect(ids(result.games)).toEqual([
      "WoW",
      "Pro",
      "WTCG",
      "Fen",
      "title-987654321",
      "W3C",
      "D2X",
    ]);
    expect(host.logs.join("\n")).toContain(
      "Could not list the Battle.net classic games, keeping the ones from before",
    );

    // A refused sign-in on the classic list is a refused sign-in.
    fake.classicAnswer = { status: 401, body: ANONYMOUS };
    const refusedClassic = await battlenet.battlenetClient
      .listLibrary({ ...SIGNED_IN }, withCookies())
      .catch((e) => e);
    expect(isLoginRejected(refusedClassic)).toBe(true);

    // The game list: an outage, and an answer that isn't the list.
    fake.classicAnswer = undefined;
    const games = new FakeStoreHost((request) =>
      request.url === battlenet.GAMES_URL
        ? { status: 502, body: "Bad Gateway" }
        : fake.handle(request),
    );
    const down = await battlenet.battlenetClient
      .listLibrary({ ...SIGNED_IN }, listContext(games))
      .catch((e) => e);
    expect(outage(down)).toBe(true);
    expect(down.message).toContain("Could not list the Battle.net games");
    const page = new FakeStoreHost((request) =>
      request.url === battlenet.GAMES_URL
        ? { body: "<!doctype html><title>Account</title>" }
        : fake.handle(request),
    );
    const notTheList = await battlenet.battlenetClient
      .listLibrary({ ...SIGNED_IN }, listContext(page))
      .catch((e) => e);
    expect(unexpected(notTheList)).toBe(true);
  });
});

describe("Battle.net account", () => {
  const fake = new FakeBattleNet();
  const host = new FakeStoreHost(fake.handle);
  // The host's read of the store partition's cookies.
  host.cookies = async (_store, url) => fake.cookies(url);
  const registered = storeClient("battlenet");

  beforeAll(() => registerStoreClient(battlenet.battlenetClient));
  beforeEach(() => {
    fake.reset();
    host.requests.length = 0;
    host.logs.length = 0;
    setStoreHost(host);
  });
  afterEach(() => refresh.deleteAccount("battlenet"));
  afterAll(() => {
    setStoreHost(readOnlyStoreHost);
    if (registered) {
      registerStoreClient(registered);
    } else {
      unregisterStoreClient("battlenet");
    }
  });

  const signIn = () =>
    refresh.completeLogin(refresh.pendingLogin("battlenet"), WINDOW_CAPTURE);

  it("signs in from the window and lists the games", async () => {
    expect(await signIn()).toBe("Player#2187");
    const library = await refresh.refreshLibrary("battlenet");
    expect(library.accountName).toBe("Player#2187");
    expect(library.partial).toBe(false);
    expect(ids(library.games).sort()).toEqual(
      [
        "D2",
        "Fen",
        "Pro",
        "W3C",
        "W3CX",
        "WTCG",
        "WoW",
        "title-987654321",
      ].sort(),
    );
    expect(library.games.find((g) => g.id === "WoW")?.extra).toEqual({
      internal_id: "wow",
    });
    // What's saved is no cookie, and the session file holds none in the
    // clear.
    expect(storage.loadSession("battlenet", host)!.session.data).toEqual({
      signedInAt: expect.any(Number),
    });
    expect(JSON.stringify(storage.readSessionInfo("battlenet"))).not.toContain(
      "secret",
    );
  });

  it("an account site session that ran out is renewed by the refresh", async () => {
    await signIn();
    fake.accountSession = null;
    const library = await refresh.refreshLibrary("battlenet");
    expect(library.games).toHaveLength(8);
    expect(fake.sessions).toBe(2);
    expect(refresh.accountStatus("battlenet").needsSignIn).toBe(false);
  });

  it("a sign-in Battle.net ended asks to sign in again", async () => {
    await signIn();
    await refresh.refreshLibrary("battlenet");
    fake.signedIn = false;
    fake.accountSession = null;
    const err = await refresh.refreshLibrary("battlenet").catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    const status = refresh.accountStatus("battlenet");
    expect(status.needsSignIn).toBe(true);
    expect(status.lastError).toContain("Sign in again");
    expect(status.lastError).not.toContain("secret");
    // The games from before are kept.
    expect(refresh.cachedLibrary("battlenet")?.games).toHaveLength(8);
  });

  it("Battle.net being down is no reason to sign in again", async () => {
    await signIn();
    fake.accountSession = null;
    fake.replayAnswer = {
      status: 503,
      url: "https://oauth.battle.net/authorize?client_id=x&state=state-secret",
      body: "<html>Service Unavailable</html>",
    };
    const err = await refresh.refreshLibrary("battlenet").catch((e) => e);
    expect(isTransient(err)).toBe(true);
    expect(isLoginRejected(err)).toBe(false);
    const status = refresh.accountStatus("battlenet");
    expect(status.needsSignIn).toBe(false);
    expect(status.lastError).toContain("https://oauth.battle.net/authorize");
    expect(status.lastError).not.toContain("state-secret");
  });

  it("a failed classic list keeps the classic games from before", async () => {
    await signIn();
    await refresh.refreshLibrary("battlenet");
    fake.classicAnswer = { status: 500, body: "{}" };
    const library = await refresh.refreshLibrary("battlenet");
    expect(library.partial).toBe(true);
    expect(ids(library.games)).toEqual(
      expect.arrayContaining(["W3C", "W3CX", "D2"]),
    );
    expect(library.games).toHaveLength(8);
    expect(host.logs.join("\n")).toContain("keeping the ones from before");
  });
});
