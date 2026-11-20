// GOG accounts (ported from BoilR's gog.rs tests, plus a sign-in and a
// refresh against a fake GOG).
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnlyStoreHost, setStoreHost } from "../../src/lib/stores/host";
import {
  HttpStatus,
  isLoginRejected,
  isTransient,
  statusOf,
  transient,
} from "../../src/lib/stores/http";
import * as gog from "../../src/lib/stores/gog";
import * as refresh from "../../src/lib/stores/refresh";
import * as storage from "../../src/lib/stores/storage";
import { LoginCapture } from "../../src/lib/stores/types";
import { FakeStoreHost, storeFixture } from "../helpers/fake-store-host";

const TOKEN = storeFixture("gog", "token.json");
const PAGE_1 = storeFixture("gog", "products_page1.json");
const PAGE_2 = storeFixture("gog", "products_page2.json");
const USER = storeFixture("gog", "user.json");

const captureUrl = (url: string): LoginCapture => ({ finalUrl: url });
const capturePaste = (text: string): LoginCapture => ({ pasted: text });
// Where a library request ends up when GOG answers it without a redirect.
const LIBRARY_URL = `${gog.PRODUCTS_URL}?mediaType=1&page=1`;

const status = (code: number) =>
  new HttpStatus(code, gog.TOKEN_URL, '{"error":"invalid_grant"}');

describe("GOG", () => {
  it("starts the login window outside the done prefix", () => {
    const pending = gog.beginLogin();
    expect(pending.startUrl.startsWith("https://auth.gog.com/auth?")).toBe(
      true,
    );
    expect(pending.startUrl).toContain("client_id=46899977096215655");
    expect(pending.startUrl).toContain(
      "redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient",
    );
    for (const prefix of pending.doneUrlPrefixes) {
      expect(pending.startUrl.startsWith(prefix)).toBe(false);
      expect("https://login.gog.com/login".startsWith(prefix)).toBe(false);
      expect(
        "https://embed.gog.com/on_login_success?origin=client".startsWith(
          prefix,
        ),
      ).toBe(true);
    }
    expect(pending.manual.kind).toBe("paste");
  });

  it("reads the code from the redirect", () => {
    const url =
      "https://embed.gog.com/on_login_success?origin=client&code=AbC-123_x";
    expect(gog.codeFromCapture(captureUrl(url))).toBe("AbC-123_x");
    expect(gog.codeFromCapture(capturePaste(`  ${url}\n`))).toBe("AbC-123_x");
    expect(gog.codeFromCapture(capturePaste("origin=client&code=XYZ"))).toBe(
      "XYZ",
    );
    expect(gog.codeFromCapture(capturePaste("XYZ123"))).toBe("XYZ123");
    expect(
      gog.codeFromCapture(
        capturePaste(
          "embed.gog.com/on_login_success?origin=client&code=Q#frag",
        ),
      ),
    ).toBe("Q");
  });

  it("rejects input without a code", () => {
    expect(() => gog.codeFromCapture({})).toThrow();
    expect(() =>
      gog.codeFromCapture(capturePaste("https://www.gog.com/en/")),
    ).toThrow();
    expect(() => gog.codeFromCapture(capturePaste("not a code"))).toThrow();
    expect(() =>
      gog.codeFromCapture(
        captureUrl(
          "https://embed.gog.com/on_login_success?origin=client&error=access_denied&error_description=User+cancelled",
        ),
      ),
    ).toThrow("User cancelled");
  });

  it("builds a session from the token answer", () => {
    const session = gog.sessionFromToken(
      gog.parseToken(JSON.parse(TOKEN)),
      1_000_000,
    );
    expect(session).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      userId: "48628349957132247",
      expiresAt: 4_600_000,
    });
    expect(gog.needsRefresh(session, 1_000_000)).toBe(false);
    expect(gog.needsRefresh(session, 4_500_000)).toBe(true);
    expect(gog.needsRefresh(session, 5_000_000)).toBe(true);
  });

  it("takes a numeric user id, and refuses an answer without tokens", () => {
    expect(
      gog.parseToken({
        access_token: "a",
        refresh_token: "r",
        user_id: 42,
        expires_in: 3600,
      }).user_id,
    ).toBe("42");
    expect(() =>
      gog.parseToken({ error: "invalid_grant", refresh_token: "SECRET" }),
    ).toThrow(/no tokens/);
    try {
      gog.parseToken({ access_token: "SECRET" });
    } catch (err) {
      expect((err as Error).message).not.toContain("SECRET");
    }
  });

  it("an unreadable session asks to sign in again", async () => {
    const host = new FakeStoreHost();
    setStoreHost(host);
    try {
      storage.saveSession(
        "gog",
        { accountName: null, data: { cookies: [] } },
        host,
      );
      await expect(refresh.refreshLibrary("gog")).rejects.toSatisfy(
        (err: Error) =>
          isLoginRejected(err) && err.message.includes("Sign in again"),
      );
      expect(host.requests).toEqual([]);
    } finally {
      await refresh.deleteAccount("gog");
      setStoreHost(readOnlyStoreHost);
    }
  });

  it("only a refused refresh token is a refused login", () => {
    // GOG answers a refresh token it no longer takes with 400 invalid_grant.
    expect(gog.refreshWasRefused(400)).toBe(true);
    expect(gog.refreshWasRefused(401)).toBe(true);
    // Blocked, rate limited, down, or no answer: the login may be fine.
    for (const other of [403, 404, 408, 429, 500, 502, 503]) {
      expect(gog.refreshWasRefused(other)).toBe(false);
    }
    expect(gog.refreshWasRefused(undefined)).toBe(false);
  });

  it("a failed refresh keeps its kind", () => {
    for (const refused of [400, 401]) {
      const err = gog.refreshFailure(status(refused));
      expect(isLoginRejected(err)).toBe(true);
      expect(err.message).toContain("Sign in again");
    }
    // An outage stays an outage, with the status still there to read.
    const outage = gog.refreshFailure(status(503));
    expect(isLoginRejected(outage)).toBe(false);
    expect(isTransient(outage)).toBe(true);
    expect(statusOf(outage)).toBe(503);
    expect(outage.message).toContain("Could not renew the GOG login");
    // No connection: transient, and no reason to sign in again.
    const offline = gog.refreshFailure(transient("no connection"));
    expect(isTransient(offline) && !isLoginRejected(offline)).toBe(true);
    // A bot block is neither.
    const blocked = gog.refreshFailure(status(403));
    expect(isLoginRejected(blocked) || isTransient(blocked)).toBe(false);
  });

  it("reads the username", () => {
    expect(gog.parseUsername(JSON.parse(USER))).toBe("player_one");
    expect(gog.parseUsername({ username: "  " })).toBeNull();
  });

  it("keeps games and skips movies, DLC and goodies", () => {
    const games = gog.gamesFromPage(gog.parseProductsPage(LIBRARY_URL, PAGE_1));
    expect(games.map((g) => g.id)).toEqual([
      "1207658924",
      "1207664663",
      "1423049311",
    ]);
    const unreal = games.find((g) => g.id === "1207658924");
    expect(unreal?.title).toBe("Unreal Gold");
    expect(unreal?.extra).toEqual({ slug: "unreal_gold" });
    expect(games.every((g) => g.store === "gog")).toBe(true);
    // No slug in the answer: no slug.
    expect(games.find((g) => g.id === "1423049311")?.extra).toEqual({});
  });

  it("titles lose trademark signs and extra spaces", () => {
    const games = gog.gamesFromPage(
      gog.parseProductsPage(
        LIBRARY_URL,
        `{"totalPages":1,"products":[
          {"id":1,"title":"  The Witcher\\u00ae 3:  Wild Hunt\\u2122 "},
          {"id":2,"title":" \\u2122 "}
        ]}`,
      ),
    );
    // A title that's only a sign is no title.
    expect(games.map((g) => g.title)).toEqual(["The Witcher 3: Wild Hunt"]);
    const witcher = gog
      .gamesFromPage(gog.parseProductsPage(LIBRARY_URL, PAGE_1))
      .find((g) => g.id === "1207664663");
    expect(witcher?.title).toBe("The Witcher: Enhanced Edition");
  });

  it("follows pages until the last", () => {
    const first = gog.parseProductsPage(LIBRARY_URL, PAGE_1);
    const second = gog.parseProductsPage(LIBRARY_URL, PAGE_2);
    expect(gog.nextPage(first, 1)).toBe(2);
    expect(gog.nextPage(second, 2)).toBeNull();
    expect(gog.gamesFromPage(second)).toHaveLength(1);

    const empty = gog.parseProductsPage(
      LIBRARY_URL,
      '{"page":1,"totalPages":0,"products":[]}',
    );
    expect(gog.nextPage(empty, 1)).toBeNull();
    expect(gog.gamesFromPage(empty)).toEqual([]);
    // A page that claims more pages but is empty stops the loop.
    const stuck = gog.parseProductsPage(
      LIBRARY_URL,
      '{"page":3,"totalPages":9,"products":[]}',
    );
    expect(gog.nextPage(stuck, 3)).toBeNull();
  });

  it("asks for more pages while GOG doesn't say how many there are", () => {
    // No totalPages, or 0, on a page with products: not the end of the list.
    const unknown = gog.parseProductsPage(
      LIBRARY_URL,
      '{"products":[{"id":1,"title":"A"}]}',
    );
    expect(gog.nextPage(unknown, 1)).toBe(2);
    expect(gog.nextPage(unknown, 7)).toBe(8);
    const zero = gog.parseProductsPage(
      LIBRARY_URL,
      '{"totalPages":0,"products":[{"id":1,"title":"A"}]}',
    );
    expect(gog.nextPage(zero, 3)).toBe(4);
    // The empty page that follows is the end.
    expect(
      gog.nextPage(gog.parseProductsPage(LIBRARY_URL, '{"products":[]}'), 2),
    ).toBeNull();
    // The page asked for decides, also when it's past what GOG reports.
    const first = gog.parseProductsPage(LIBRARY_URL, PAGE_1);
    expect(gog.nextPage(first, 2)).toBeNull();
    expect(gog.nextPage(first, 4294967295)).toBeNull();
    expect(gog.nextPage(unknown, 4294967295)).toBe(4294967295);
  });

  it("an answer without products is not an empty library", () => {
    for (const body of [
      "{}",
      '{"page":1,"totalPages":3}',
      '{"error":"temporarily unavailable"}',
      '{"products": 3}',
      '{"products": null}',
      "[]",
      "",
    ]) {
      let err: unknown;
      try {
        gog.parseProductsPage(LIBRARY_URL, body);
      } catch (e) {
        err = e;
      }
      expect((err as Error)?.message, body).toContain("Unexpected answer");
      expect(isLoginRejected(err) || isTransient(err), body).toBe(false);
    }
  });

  it("only GOG's sign-in page asks to sign in again", () => {
    const page = "<!DOCTYPE html>\n<html><body>Something else</body></html>";
    const rejected = (url: string, body: string) => {
      try {
        gog.parseProductsPage(url, body);
      } catch (err) {
        return isLoginRejected(err);
      }
      throw new Error("a web page was read as a library page");
    };

    // The request was sent on to GOG's login.
    for (const url of [
      "https://login.gog.com/auth?client_id=1&redirect_uri=x",
      "https://auth.gog.com/auth?client_id=1",
      "https://www.gog.com/en/login?next=x",
      "https://www.gog.com/##openlogin",
      "https://www.gog.com/en##openlogin",
    ]) {
      expect(rejected(url, page), url).toBe(true);
    }
    // GOG answered with a page that opens its login.
    const opensLogin =
      '<!DOCTYPE html>\n<html><head><meta http-equiv="refresh" content="0;url=\'/en##openlogin\'" /></head></html>';
    expect(rejected(LIBRARY_URL, opensLogin)).toBe(true);

    // Any other page says nothing about the login: a maintenance page of
    // GOG's, a captive portal, a proxy's error page, also one that mentions
    // a login.
    expect(rejected(LIBRARY_URL, page)).toBe(false);
    expect(rejected("https://www.gog.com/en/maintenance", page)).toBe(false);
    const mentionsLogin =
      "<html><script>if (hash == 'openlogin') show()</script>Down for maintenance</html>";
    expect(rejected("https://www.gog.com/en/maintenance", mentionsLogin)).toBe(
      false,
    );
    for (const url of [
      "http://hotel-wifi.example/login",
      "https://portal.example/login?next=https://embed.gog.com/",
      "https://notgog.com/login",
      "https://gog.com.example/login",
      "http://login.gog.com/login",
    ]) {
      expect(rejected(url, page), url).toBe(false);
      expect(rejected(url, opensLogin), url).toBe(false);
    }
    let message = "";
    try {
      gog.parseProductsPage("https://portal.example/a?token=SECRET", page);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Unexpected answer");
    expect(message).toContain("https://portal.example/a");
    expect(message).not.toContain("SECRET");
  });
});

describe("GOG account", () => {
  // A fake GOG: tokens rotate on every refresh, as GOG's do.
  let issued = 0;
  let validToken = "";
  let expiresIn = 3600;
  const tokenAnswer = () => {
    issued++;
    validToken = `access-${issued}`;
    return {
      body: {
        access_token: validToken,
        refresh_token: `refresh-${issued}`,
        user_id: "48628349957132247",
        expires_in: expiresIn,
      },
    };
  };
  const host = new FakeStoreHost(({ url, init }) => {
    const u = new URL(url);
    if (u.host === "auth.gog.com" && u.pathname === "/token") {
      const grant = u.searchParams.get("grant_type");
      if (grant === "authorization_code") {
        return u.searchParams.get("code") === "good-code"
          ? tokenAnswer()
          : { status: 400, body: { error: "invalid_grant" } };
      }
      if (u.searchParams.get("refresh_token") !== `refresh-${issued}`) {
        return { status: 400, body: { error: "invalid_grant" } };
      }
      return tokenAnswer();
    }
    if (init.headers?.Authorization !== `Bearer ${validToken}`) {
      // A dead token: GOG sends its sign-in page.
      return {
        url: "https://www.gog.com/en##openlogin",
        body: "<!DOCTYPE html><html></html>",
      };
    }
    if (u.host === "users.gog.com") {
      return { body: USER };
    }
    if (u.pathname === "/account/getFilteredProducts") {
      return { body: u.searchParams.get("page") === "1" ? PAGE_1 : PAGE_2 };
    }
    return { status: 404 };
  });
  beforeEach(() => {
    issued = 0;
    validToken = "";
    expiresIn = 3600;
    setStoreHost(host);
  });
  afterEach(() => refresh.deleteAccount("gog"));
  afterAll(() => setStoreHost(readOnlyStoreHost));

  const signIn = () =>
    refresh.completeLogin(refresh.pendingLogin("gog"), {
      finalUrl:
        "https://embed.gog.com/on_login_success?origin=client&code=good-code",
    });

  it("signs in from the window's redirect and lists the games", async () => {
    await expect(
      refresh.completeLogin(refresh.pendingLogin("gog"), {
        pasted: "bad-code",
      }),
    ).rejects.toThrow("Could not finish the GOG sign-in");
    expect(await signIn()).toBe("player_one");
    const library = await refresh.refreshLibrary("gog");
    expect(library.games.map((g) => g.id)).toEqual([
      "1207658924",
      "1207664663",
      "1207665503",
      "1423049311",
    ]);
    expect(library.accountName).toBe("player_one");
    // Nothing secret left in what's on disk in the clear.
    const info = JSON.stringify(storage.readSessionInfo("gog"));
    expect(info).not.toContain("refresh-1");
  });

  it("renews a token about to expire, and saves the new one", async () => {
    expiresIn = 60; // (within the renewal margin)
    await signIn();
    await refresh.refreshLibrary("gog");
    // The rotated refresh token is the one kept.
    const saved = storage.loadSession("gog", host)!.session.data;
    expect(saved).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
  });

  it("a token GOG ended early is renewed once", async () => {
    await signIn();
    validToken = "ended-early";
    // (the renewal makes access-2 the valid one)
    const library = await refresh.refreshLibrary("gog");
    expect(library.games).toHaveLength(4);
    expect(storage.loadSession("gog", host)!.session.data.refreshToken).toBe(
      "refresh-2",
    );
  });

  it("a refused refresh token asks to sign in again", async () => {
    expiresIn = 60;
    await signIn();
    // Someone else used the refresh token (it rotated away).
    issued = 5;
    const err = await refresh.refreshLibrary("gog").catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    expect(refresh.accountStatus("gog").needsSignIn).toBe(true);
    expect(refresh.accountStatus("gog").lastError).not.toContain("refresh-");
  });
});
