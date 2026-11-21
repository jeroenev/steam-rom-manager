// Epic Games Store accounts (ported from BoilR's epic.rs tests, plus a
// sign-in, refreshes and a sign-out against a fake Epic).
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import * as _ from "lodash";
import * as epic from "../../src/lib/stores/epic";
import { readOnlyStoreHost, setStoreHost } from "../../src/lib/stores/host";
import {
  HttpStatus,
  isLoginRejected,
  isTransient,
  queryParam,
  transient,
} from "../../src/lib/stores/http";
import * as refresh from "../../src/lib/stores/refresh";
import {
  registerStoreClient,
  storeClient,
  unregisterStoreClient,
} from "../../src/lib/stores/registry";
import * as storage from "../../src/lib/stores/storage";
import { epicInstallLink, storePage } from "../../src/lib/stores/targets";
import {
  LoginCapture,
  OwnedGame,
  StoreSession,
  ownedGame,
} from "../../src/lib/stores/types";
import {
  FakeAnswer,
  FakeStoreHost,
  storeFixture,
} from "../helpers/fake-store-host";

const TOKEN = storeFixture("epic", "token_response.json");
const TOKEN_CODE_USED = storeFixture("epic", "token_error_code_used.json");
const TOKEN_CORRECTIVE = storeFixture("epic", "token_error_corrective.json");
const REDIRECT_IN = storeFixture("epic", "redirect_signed_in.json");
const REDIRECT_OUT = storeFixture("epic", "redirect_signed_out.json");
const LIBRARY_1 = storeFixture("epic", "library_page1.json");
const LIBRARY_2 = storeFixture("epic", "library_page2.json");
const CATALOG = storeFixture("epic", "catalog_bulk.json");

const CODE = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const CLIENT = "34a02cf8f4414e29b15921876da36f9a";
const BASIC_AUTH = `Basic ${Buffer.from(
  `${CLIENT}:daafbccc737745039dffe53d94fc76cf`,
).toString("base64")}`;
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
// Where a library request ends up when Epic answers it without a redirect.
const LIBRARY_URL = epic.libraryUrl();

function entry(app: string, item: string): epic.LibraryEntry {
  return { appName: app, namespace: "ns", catalogItemId: item };
}

const key = (item: string) => epic.catalogKey("ns", item);

// A game as an earlier list holds it for entry(app, item).
function listedBefore(app: string, item: string, title: string): OwnedGame {
  return ownedGame("epic", app, title, {
    namespace: "ns",
    catalog_item_id: item,
  });
}

function gameItem(title: string): epic.CatalogItem {
  const item = epic.parseCatalogItem({
    title,
    categories: [{ path: "games" }, { path: "applications" }],
  });
  if (!item) {
    throw new Error("not a catalog item");
  }
  return item;
}

const status = (code: number) =>
  new HttpStatus(code, "https://catalog.example/bulk/items", "");

const titles = (games: OwnedGame[]) => games.map((g) => g.title);

// The error `fn` throws.
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("nothing was thrown");
}

// Both pages of the fixture library, filtered.
function library(): epic.LibraryEntry[] {
  const first = epic.parseLibraryPage(LIBRARY_URL, LIBRARY_1);
  const second = epic.parseLibraryPage(LIBRARY_URL, LIBRARY_2);
  expect(first.next).toBe("cursor-page-2");
  expect(second.next).toBeUndefined();
  return epic.libraryEntries([...first.records, ...second.records]);
}

describe("Epic login", () => {
  it("starts the login window outside the done prefixes", () => {
    const pending = epic.beginLogin();
    const manualUrl = pending.manual.kind === "paste" ? pending.manual.url : "";
    expect(manualUrl).not.toBe("");
    for (const url of [pending.startUrl, manualUrl]) {
      for (const prefix of pending.doneUrlPrefixes) {
        expect(url.startsWith(prefix)).toBe(false);
      }
    }
    expect(
      pending.startUrl.startsWith("https://www.epicgames.com/id/login?"),
    ).toBe(true);
    expect(queryParam(pending.startUrl, "redirectUrl")).toBe(
      epic.redirectUrl(),
    );
    expect(epic.redirectUrl().startsWith(epic.REDIRECT_URL)).toBe(true);
    expect(epic.redirectUrl()).toContain(`clientId=${CLIENT}`);
    expect(epic.redirectUrl()).toContain("responseType=code");
  });

  it("the login window loads the redirect page and nothing else", () => {
    const pending = epic.beginLogin();
    // The page with the code is loaded, so its text can be handed over.
    expect(
      pending.pageTextUrlPrefixes.some((p) => epic.redirectUrl().startsWith(p)),
    ).toBe(true);
    // (and the same page without www)
    expect(
      pending.pageTextUrlPrefixes.some((p) =>
        "https://epicgames.com/id/api/redirect?clientId=x".startsWith(p),
      ),
    ).toBe(true);
    // Only done pages are loaded for their text.
    for (const prefix of pending.pageTextUrlPrefixes) {
      expect(pending.doneUrlPrefixes).toContain(prefix);
      // The launcher's callback has the code in its URL and no page behind
      // it.
      expect(prefix).not.toContain("localhost");
    }
    expect(pending.doneUrlPrefixes.some((p) => p.includes("localhost"))).toBe(
      true,
    );
    expect(pending.cookieUrls).toEqual(["https://www.epicgames.com"]);
  });

  it("the login window and the cookie replay use a browser's user agent", () => {
    const pending = epic.beginLogin();
    // Not the launcher's: with it, Epic's sign-in stops after two-factor
    // authentication.
    expect(pending.userAgent).toBe(epic.LOGIN_USER_AGENT);
    expect(pending.userAgent).toMatch(/^Mozilla\/5\.0 .*Chrome\//);
    expect(pending.userAgent).not.toContain("EpicGamesLauncher");
    expect(pending.userAgent).not.toBe(epic.LAUNCHER_USER_AGENT);
    const request = epic.redirectPageRequest("a=1");
    expect(request.url).toBe(epic.redirectUrl());
    expect(request.init.headers?.["User-Agent"]).toBe(pending.userAgent);
    expect(request.init.headers?.Cookie).toBe("a=1");
  });

  it("replays only the cookies for www.epicgames.com", () => {
    const cookies = [
      { name: "a", value: "1", domain: ".epicgames.com" },
      { name: "b", value: "2", domain: "www.epicgames.com" },
      { name: "c", value: "3", domain: "epicgames.com" },
      { name: "d", value: "4", domain: "store.epicgames.com" },
      { name: "e", value: "5", domain: "example.com" },
      { name: "f", value: "6", domain: "notepicgames.com" },
    ];
    expect(epic.cookieHeader(cookies, "www.epicgames.com")).toBe(
      "a=1; b=2; c=3",
    );
    expect(epic.cookieHeader([], "www.epicgames.com")).toBe("");
  });

  it("reads the code from the redirect page", () => {
    expect(epic.parseRedirectResponse(REDIRECT_IN)).toBe(CODE);
    expect(
      thrown(() => epic.parseRedirectResponse(REDIRECT_OUT)).message,
    ).toContain("not signed in");
    expect(() => epic.parseRedirectResponse("<html>")).toThrow(
      "Epic did not return a login code",
    );
    // A webview that shows the JSON through a viewer of its own.
    const viewer = `redirectUrl\t"x"\nauthorizationCode\t"${CODE}"\nsid\tnull`;
    expect(epic.parseRedirectResponse(viewer)).toBe(CODE);
    // Chromium's JSON view with its pretty-print switch.
    expect(epic.parseRedirectResponse(`Pretty-print\n${REDIRECT_IN}`)).toBe(
      CODE,
    );
  });

  it("a login window hands over the code in the URL or in the page text", () => {
    const capture = (finalUrl: string, pageText?: string): LoginCapture => ({
      finalUrl,
      pageText,
      cookies: [],
    });
    // The launcher's callback: the code is in the URL.
    const callback = `https://localhost/launcher/authorized?code=${CODE}`;
    expect(epic.codeInCapture(capture(callback))).toBe(CODE);
    // The redirect page, loaded by the window.
    expect(epic.codeInCapture(capture(epic.redirectUrl(), REDIRECT_IN))).toBe(
      CODE,
    );
    // Loaded, but the window was not signed in: an error, not a second
    // request.
    expect(() =>
      epic.codeInCapture(capture(epic.redirectUrl(), REDIRECT_OUT)),
    ).toThrow("not signed in");
    // No text (a window that could not read the page): the cookies are
    // replayed.
    expect(epic.codeInCapture(capture(epic.redirectUrl()))).toBeUndefined();
    expect(
      epic.codeInCapture(capture(epic.redirectUrl(), "  ")),
    ).toBeUndefined();
    expect(epic.codeInCapture({})).toBeUndefined();
  });

  it("accepts every pasted form", () => {
    expect(epic.parsePastedCode(CODE)).toBe(CODE);
    expect(epic.parsePastedCode(`  "${CODE}"\n`)).toBe(CODE);
    expect(epic.parsePastedCode(REDIRECT_IN)).toBe(CODE);
    expect(epic.parsePastedCode(`"authorizationCode":"${CODE}",`)).toBe(CODE);
    expect(
      epic.parsePastedCode(
        `https://localhost/launcher/authorized?code=${CODE}`,
      ),
    ).toBe(CODE);
    expect(() => epic.parsePastedCode("not a code!")).toThrow();
    expect(() => epic.parsePastedCode("abc")).toThrow();
    expect(() => epic.parsePastedCode(REDIRECT_OUT)).toThrow("not signed in");
  });

  it("finds the pasted code whatever surrounds it", () => {
    // Firefox's JSON viewer copies a row as name, tab, quoted value.
    expect(epic.parsePastedCode(`authorizationCode\t"${CODE}"`)).toBe(CODE);
    // And the whole page as rows.
    const rows =
      'warning\t"Do not share this code with any 3rd party service."\n' +
      `redirectUrl\t"https://localhost/launcher/authorized?code=${CODE}"\n` +
      `authorizationCode\t"${CODE}"\nexchangeCode\tnull\nsid\tnull`;
    expect(epic.parsePastedCode(rows)).toBe(CODE);
    expect(epic.parsePastedCode(`authorizationCode: ${CODE}`)).toBe(CODE);
    // JSON cut off while selecting.
    expect(
      epic.parsePastedCode(`{"warning":"x","authorizationCode":"${CODE}`),
    ).toBe(CODE);
    // No name at all, but one thing that is a code.
    expect(epic.parsePastedCode(`the code is ${CODE}.`)).toBe(CODE);
    expect(
      epic.parsePastedCode(`see https://x.example/?a=1&code=${CODE}#top ok`),
    ).toBe(CODE);

    // The rows of a browser that is not signed in.
    expect(() =>
      epic.parsePastedCode('redirectUrl\t"x"\nauthorizationCode\tnull'),
    ).toThrow("not signed in");
    // Two different codes: no telling which one is meant.
    const other = "f".repeat(32);
    expect(() => epic.parsePastedCode(`${CODE} or ${other}`)).toThrow();
    // Epic's own instructions, without a code.
    expect(() =>
      epic.parsePastedCode(
        "a page of text containing authorizationCode. Copy it",
      ),
    ).toThrow();
  });
});

describe("Epic tokens", () => {
  it("asks for tokens as the launcher", () => {
    const { url, init } = epic.tokenRequest("refresh_token", {
      refresh_token: "r~1",
    });
    expect(url).toBe(epic.OAUTH_TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toBe(BASIC_AUTH);
    expect(init.headers?.["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(init.headers?.["User-Agent"]).toBe(epic.LAUNCHER_USER_AGENT);
    expect([...new URLSearchParams(init.body)]).toEqual([
      ["grant_type", "refresh_token"],
      ["refresh_token", "r~1"],
      ["token_type", "eg1"],
    ]);
    const code = epic.tokenRequest("authorization_code", { code: CODE });
    expect(Object.fromEntries(new URLSearchParams(code.init.body))).toEqual({
      grant_type: "authorization_code",
      code: CODE,
      token_type: "eg1",
    });
  });

  it("parses tokens into a session", () => {
    const tokens = epic.parseTokenResponse("authorization_code", 200, TOKEN);
    const session = epic.sessionFromToken(tokens, null, 1_000_000);
    expect(session).toEqual({
      accessToken: "eg1~access",
      refreshToken: "eg1~refresh",
      accountId: ACCOUNT_ID,
      expiresAt: 8_200_000,
      displayName: "Player One",
    });
    expect(epic.needsRefresh(session, 1_000_000)).toBe(false);
    expect(
      epic.needsRefresh(session, 8_200_000 - epic.REFRESH_MARGIN_MS - 1),
    ).toBe(false);
    expect(epic.needsRefresh(session, 8_200_000 - epic.REFRESH_MARGIN_MS)).toBe(
      true,
    );
    expect(epic.needsRefresh(session, 9_000_000)).toBe(true);

    // As saved and read back.
    const stored: StoreSession = {
      accountName: null,
      data: JSON.parse(JSON.stringify(session)),
    };
    expect(epic.readSession(stored)).toEqual(session);
  });

  it("takes an answer without the optional fields", () => {
    const tokens = epic.parseTokenResponse(
      "refresh_token",
      200,
      '{"access_token":"a","refresh_token":"r"}',
    );
    expect(tokens).toEqual({
      access_token: "a",
      refresh_token: "r",
      expires_in: 0,
      account_id: "",
      displayName: null,
    });
    // Epic didn't say how long it lasts: renewed on the next use.
    expect(epic.needsRefresh(epic.sessionFromToken(tokens, null, 5), 5)).toBe(
      true,
    );
  });

  it("sessions with more or fewer fields than this version writes still load", () => {
    const data = {
      accessToken: "eg1~access",
      refreshToken: "eg1~refresh",
      accountId: ACCOUNT_ID,
      expiresAt: 8_200_000,
    };
    const later = {
      accountName: "Player One",
      data: { ...data, displayName: "Player One", refreshExpiresAt: 1 },
    };
    expect(epic.readSession(later).refreshToken).toBe("eg1~refresh");
    expect(
      epic.readSession({ accountName: null, data }).displayName,
    ).toBeNull();

    for (const broken of [
      { accessToken: "only this" },
      { ...data, expiresAt: "soon" },
      { ...data, displayName: 5 },
    ]) {
      const err = thrown(() =>
        epic.readSession({ accountName: null, data: broken }),
      );
      expect(isLoginRejected(err)).toBe(true);
      expect(err.message).toContain("Sign in again");
    }
  });

  it("a renewal keeps the known name", () => {
    const tokens: epic.TokenResponse = {
      ...epic.parseTokenResponse("refresh_token", 200, TOKEN),
      displayName: null,
    };
    expect(epic.sessionFromToken(tokens, "Old Name", 0).displayName).toBe(
      "Old Name",
    );
    // (and an empty name is no name)
    expect(
      epic.sessionFromToken({ ...tokens, displayName: " " }, "Old Name", 0)
        .displayName,
    ).toBe("Old Name");
  });

  it("explains token errors", () => {
    const used = thrown(() =>
      epic.parseTokenResponse("authorization_code", 400, TOKEN_CODE_USED),
    );
    // About the code of this sign-in, not about a saved login.
    expect(used.message).toContain("expired or was already used");
    expect(isLoginRejected(used)).toBe(false);

    const corrective = thrown(() =>
      epic.parseTokenResponse("authorization_code", 400, TOKEN_CORRECTIVE),
    );
    expect(corrective.message).toContain(
      "https://www.epicgames.com/id/login/corrective?continuation=abc",
    );
    expect(corrective.message).toContain("sign in again");
    const later = thrown(() =>
      epic.parseTokenResponse("refresh_token", 400, TOKEN_CORRECTIVE),
    );
    expect(isLoginRejected(later)).toBe(false);
    expect(later.message).toContain("refresh the library again");
    // Without a continuation page: the account page.
    const bare = thrown(() =>
      epic.parseTokenResponse(
        "refresh_token",
        400,
        '{"errorCode":"errors.com.epicgames.oauth.corrective_action_required"}',
      ),
    );
    expect(bare.message).toContain("https://www.epicgames.com/account");
  });

  it("only a refused refresh token is a refused login", () => {
    const renewal = (code: number, body: string) =>
      thrown(() => epic.parseTokenResponse("refresh_token", code, body));
    // What Epic sends for a refresh token that expired or was ended.
    const dead = renewal(
      400,
      '{"errorCode":"errors.com.epicgames.account.auth_token.invalid_refresh_token","errorMessage":"Sorry the refresh token is invalid"}',
    );
    expect(isLoginRejected(dead)).toBe(true);
    expect(dead.message).toContain("Sign in again");
    // Another code of Epic's, with the OAuth name next to it.
    const invalidGrant = renewal(
      400,
      '{"errorCode":"errors.com.epicgames.account.oauth.something_else","error":"invalid_grant"}',
    );
    expect(isLoginRejected(invalidGrant)).toBe(true);
    // The same answer to a pasted code is about that code.
    const code = thrown(() =>
      epic.parseTokenResponse(
        "authorization_code",
        400,
        '{"errorCode":"errors.com.epicgames.account.oauth.something_else","error":"invalid_grant"}',
      ),
    );
    expect(isLoginRejected(code)).toBe(false);
    expect(code.message).toContain("expired or was already used");

    // An outage is neither, with or without Epic's error body.
    const outage = renewal(503, "<html>Service Unavailable</html>");
    expect(isTransient(outage) && !isLoginRejected(outage)).toBe(true);
    expect(outage.message).toContain("Epic sign-in failed");
    const busy = renewal(
      500,
      '{"errorCode":"errors.com.epicgames.common.server_error","errorMessage":"Try later"}',
    );
    expect(isTransient(busy) && !isLoginRejected(busy)).toBe(true);
    expect(busy.message).toContain("Try later");
    const limited = renewal(429, "");
    expect(isTransient(limited) && !isLoginRejected(limited)).toBe(true);
    // Something Epic doesn't like about the request says nothing about the
    // login.
    const other = renewal(
      400,
      '{"errorCode":"errors.com.epicgames.common.oauth.invalid_client","errorMessage":"No"}',
    );
    expect(isTransient(other) || isLoginRejected(other)).toBe(false);
    expect(isLoginRejected(renewal(403, "blocked"))).toBe(false);
  });

  it("an answer without tokens is an error that names no secret", () => {
    for (const [code, body] of [
      [200, '{"access_token":"SECRET-1"}'],
      [200, '{"access_token":"SECRET-1","refresh_token":5}'],
      [
        200,
        '{"access_token":"SECRET-1","refresh_token":"SECRET-2","expires_in":"x"}',
      ],
      [200, "[]"],
      [200, ""],
      [502, '{"access_token":"SECRET-1","refresh_token":"SECRET-2"}'],
    ] as const) {
      const err = thrown(() =>
        epic.parseTokenResponse("refresh_token", code, body),
      );
      expect(err.message, body).not.toContain("SECRET");
      expect(isLoginRejected(err), body).toBe(false);
    }
    expect(
      thrown(() => epic.parseTokenResponse("refresh_token", 200, "<html>"))
        .message,
    ).toContain("Unexpected answer from Epic's sign-in service");
  });

  it("reads the display name", () => {
    expect(epic.parseDisplayName({ displayName: "Player One" })).toBe(
      "Player One",
    );
    expect(epic.parseDisplayName({ displayName: "  " })).toBeNull();
    expect(epic.parseDisplayName({})).toBeNull();
    expect(epic.parseDisplayName(null)).toBeNull();
  });
});

describe("Epic sign-out", () => {
  it("a session Epic no longer knows counts as ended", () => {
    expect(epic.sessionEndFailure(204)).toBeUndefined();
    expect(epic.sessionEndFailure(200)).toBeUndefined();
    expect(epic.sessionEndFailure(401)).toBeUndefined();
    const down = epic.sessionEndFailure(503);
    expect(down && isTransient(down)).toBe(true);
    const refused = epic.sessionEndFailure(403);
    expect(refused && !isTransient(refused)).toBe(true);
    expect(refused?.message).toContain("403");
  });

  it("never names the access token, which is part of the URL", () => {
    const token = "eg1~a/b+c";
    const url = epic.sessionKillUrl(token);
    expect(url.startsWith(epic.SESSION_KILL_URL)).toBe(true);
    // (one path segment, whatever the token holds)
    expect(url.slice(epic.SESSION_KILL_URL.length)).not.toContain("/");

    const offline = epic.unreachable(
      transient(`connect ECONNREFUSED (${url}) ${token}`),
      token,
    );
    expect(offline.message).toContain("Epic could not be reached");
    expect(offline.message).not.toContain("a/b+c");
    expect(offline.message).not.toContain("a%2Fb%2Bc");
    expect(isTransient(offline)).toBe(true);
    // (and nothing of it is kept as a cause)
    expect(offline.cause).toBeUndefined();
    const odd = epic.unreachable(new Error(`bad ${token}`), token);
    expect(isTransient(odd)).toBe(false);
    expect(odd.message).not.toContain("a/b+c");
  });
});

describe("Epic library", () => {
  it("an empty cursor ends the library", () => {
    const page = epic.parseLibraryPage(
      LIBRARY_URL,
      '{"responseMetadata":{"nextCursor":""},"records":[{}]}',
    );
    expect(page.records).toHaveLength(1);
    expect(page.next).toBeUndefined();
    const bare = epic.parseLibraryPage(LIBRARY_URL, "{}");
    expect(bare).toEqual({ records: [], next: undefined });
    const nulls = epic.parseLibraryPage(
      LIBRARY_URL,
      '{"responseMetadata":{"nextCursor":null},"records":[{"appName":null}]}',
    );
    expect(nulls.next).toBeUndefined();
    expect(nulls.records).toEqual([{}]);
  });

  it("an answer that isn't a page of the library is an error, not an empty page", () => {
    for (const body of [
      "",
      "not json",
      "<html>Down for maintenance</html>",
      "[]",
      '{"records":null}',
      '{"records":{}}',
      '{"records":[5]}',
      '{"records":[{"appName":5}]}',
      '{"responseMetadata":[]}',
      '{"responseMetadata":{"nextCursor":5}}',
    ]) {
      const err = thrown(() =>
        epic.parseLibraryPage(`${LIBRARY_URL}&cursor=SECRET`, body),
      );
      expect(err.message, body).toContain(
        `Unexpected response from ${epic.LIBRARY_ITEMS_URL}`,
      );
      expect(err.message, body).not.toContain("SECRET");
      expect(isLoginRejected(err) || isTransient(err), body).toBe(false);
    }
  });

  it("asks for the library and the catalog as the launcher does", () => {
    expect(epic.libraryUrl()).toBe(
      `${epic.LIBRARY_ITEMS_URL}?includeMetadata=true&platform=Windows`,
    );
    expect(epic.libraryUrl("c+1")).toBe(
      `${epic.LIBRARY_ITEMS_URL}?includeMetadata=true&platform=Windows&cursor=c%2B1`,
    );
    expect(epic.catalogUrl({ namespace: "ns/x", ids: ["a", "b"] })).toBe(
      `${epic.CATALOG_URL}ns%2Fx/bulk/items?id=a&id=b&includeDLCDetails=false&includeMainGameDetails=true&country=US&locale=en-US`,
    );
  });

  it("filters library records", () => {
    expect(library().map((e) => e.appName)).toEqual([
      "Fortnite",
      "Calluna",
      "CallunaDLC1",
      "CallunaExpansionLauncher",
      "EAGame",
      "UbiGame",
      "Soundtrack",
      "EnginePlugin",
      "NotAnApplication",
    ]);
    // legendary's broken app name, an upper-case UE namespace, a private
    // sandbox in other case, and records without a catalog item.
    expect(
      epic.libraryEntries([
        { appName: "1", namespace: "ns", catalogItemId: "a" },
        { appName: "Asset", namespace: "UE", catalogItemId: "b" },
        {
          appName: "Dev",
          namespace: "ns",
          catalogItemId: "c",
          sandboxType: "private",
        },
        { appName: "NoItem", namespace: "ns" },
        { appName: "NoItem", namespace: "ns", catalogItemId: "" },
        { appName: "Game", namespace: "ns", catalogItemId: "d" },
      ]),
    ).toEqual([{ appName: "Game", namespace: "ns", catalogItemId: "d" }]);
  });

  it("batches catalog lookups per namespace", () => {
    const batches = epic.catalogBatches(library());
    expect(batches.find((b) => b.namespace === "ns-control")?.ids).toEqual([
      "cat-control",
      "cat-control-dlc",
      "cat-control-launchable",
    ]);
    expect(batches).toHaveLength(7);

    const many = _.range(120).map((i) => ({
      appName: `app${i}`,
      namespace: "ns",
      catalogItemId: `id${String(i).padStart(3, "0")}`,
    }));
    expect(epic.catalogBatches(many).map((b) => b.ids.length)).toEqual([
      50, 50, 20,
    ]);
    expect(epic.CATALOG_BATCH_SIZE).toBe(50);
    expect(epic.CATALOG_CONCURRENCY).toBe(8);
  });

  it("only entries the last list lacks are looked up", () => {
    const entries = [
      entry("Fortnite", "a"),
      entry("Rocket", "b"),
      entry("RocketDLC", "c"),
      entry("New", "d"),
      entry("Moved", "e"),
    ];
    const previous = [
      listedBefore("Fortnite", "a", "Fortnite"),
      listedBefore("Rocket", "b", "Rocket League"),
      // The same app, but under another catalog item than the library names
      // now.
      listedBefore("Moved", "old", "Moved"),
      // No longer in the library.
      listedBefore("Gone", "z", "Gone"),
    ];
    const apps = (before: OwnedGame[]) =>
      epic.entriesToLookUp(entries, before).map((e) => e.appName);
    // DLC is in no list, so it's asked about each time, like a new game.
    expect(apps(previous)).toEqual(["RocketDLC", "New", "Moved"]);
    // A first fetch looks up everything.
    expect(apps([])).toHaveLength(entries.length);
    // And the requests are made for those entries only.
    expect(
      epic.catalogBatches(epic.entriesToLookUp(entries, previous)),
    ).toEqual([{ namespace: "ns", ids: ["c", "d", "e"] }]);
  });

  it("known games are taken over, and failed lookups are rescued or counted", () => {
    const entries = [
      entry("Fortnite", "a"),
      entry("Moved", "b"),
      entry("New", "c"),
      entry("Lost", "d"),
      entry("Dlc", "e"),
      entry("Unknown", "f"),
    ];
    const fortnite = listedBefore(
      "Fortnite",
      "a",
      "Fortnite (as listed before)",
    );
    fortnite.extra.kept = "1";
    const previous = [
      // Listed before with a title and an extra of its own: taken over
      // untouched.
      fortnite,
      listedBefore("Moved", "old", "Moved"),
    ];
    const lookup = new epic.CatalogLookup();
    // Even an answer for a known game changes nothing: it wasn't asked for.
    lookup.found.set(key("a"), gameItem("Fortnite"));
    lookup.found.set(key("c"), gameItem("New Game™"));
    const dlc = epic.parseCatalogItem({
      title: "Some DLC",
      categories: [{ path: "addons" }, { path: "applications" }],
      mainGameItem: { id: "c" },
    });
    lookup.found.set(key("e"), dlc!);
    lookup.failed.add(key("b"));
    lookup.failed.add(key("d"));

    const listed = epic.listGames(entries, previous, lookup);
    expect(titles(listed.games)).toEqual([
      "Fortnite (as listed before)",
      "Moved",
      "New Game",
    ]);
    expect(listed.games[0].extra.kept).toBe("1");
    // "Moved" failed but was listed before under its app name; "Lost" was
    // not. The catalog answered without "Unknown", which is no failure.
    expect(listed.missing).toBe(1);

    // Nothing failed: nothing is missing.
    lookup.failed.clear();
    expect(epic.listGames(entries, previous, lookup).missing).toBe(0);
  });

  it("failed requests count their ids as failed", () => {
    const batch = (...ids: string[]): epic.Batch => ({ namespace: "ns", ids });
    const lookup = new epic.CatalogLookup();
    lookup.record(batch("a", "b"), {
      items: new Map([["a", gameItem("A")]]),
    });
    // An outage: every id of the request failed, and asking again wouldn't
    // help.
    lookup.record(batch("c", "d"), { error: status(503) });
    // A single id the service refuses.
    lookup.record(batch("e"), { error: status(404) });
    // A request for several ids the service refuses: maybe one of them is
    // bad.
    lookup.record(batch("f", "g"), { error: status(400) });
    // A request that ended without an answer.
    lookup.fail(batch("h", "i"), new Error("stopped"));

    expect([...lookup.found.keys()]).toEqual([key("a")]);
    expect([...lookup.failed].sort()).toEqual(
      [key("c"), key("d"), key("e"), key("h"), key("i")].sort(),
    );
    // The first error is the one reported.
    expect(isTransient(lookup.error)).toBe(true);

    // Asked one by one: what a batch of several left open. Never a single id
    // again, and never what an outage took.
    const batches = [
      batch("a", "b"),
      batch("c", "d"),
      batch("e"),
      batch("f", "g"),
      batch("h", "i"),
      batch("unanswered"),
    ];
    expect(epic.singleLookups(batches, lookup)).toEqual([
      batch("b"),
      batch("f"),
      batch("g"),
    ]);
  });

  it("only a refused request for several ids is split", () => {
    expect(epic.worthAskingOneByOne(2, status(400))).toBe(true);
    expect(epic.worthAskingOneByOne(50, status(404))).toBe(true);
    expect(epic.worthAskingOneByOne(1, status(400))).toBe(false);
    expect(epic.worthAskingOneByOne(2, status(503))).toBe(false);
    expect(epic.worthAskingOneByOne(2, status(429))).toBe(false);
    expect(epic.worthAskingOneByOne(2, status(401))).toBe(false);
    expect(epic.worthAskingOneByOne(2, transient("timed out"))).toBe(false);
  });

  it("runs at most so many catalog requests at once", async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    await epic.runLimited(_.range(20), 8, async (i) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      done.push(i);
    });
    expect(most).toBe(8);
    expect(_.sortBy(done)).toEqual(_.range(20));
    await expect(epic.runLimited([], 8, async () => {})).resolves.toBe(
      undefined,
    );
  });

  it("turns catalog items into games", () => {
    const items = epic.parseCatalogText(
      `${epic.CATALOG_URL}ns/bulk/items`,
      CATALOG,
    );
    expect(items.has("cat-fortnite")).toBe(true);
    // One odd item doesn't hide the others.
    expect(items.has("cat-broken")).toBe(false);

    const entries = library();
    const lookup = new epic.CatalogLookup();
    for (const e of entries) {
      const item = items.get(e.catalogItemId);
      if (item) {
        lookup.found.set(epic.catalogKey(e.namespace, e.catalogItemId), item);
      }
    }
    const listed = epic.listGames(entries, [], lookup);
    expect(listed.missing).toBe(0);
    const games = listed.games;
    expect(games.map((g) => [g.id, g.title, g.extra.product_slug])).toEqual([
      ["Fortnite", "Fortnite", "fortnite"],
      ["Calluna", "Control Ultimate Edition", "control"],
      ["CallunaExpansionLauncher", "Control Standalone Expansion", undefined],
      ["EAGame", "Star Wars Jedi: Fallen Order", undefined],
      ["UbiGame", "Assassin's Creed Valhalla", undefined],
    ]);

    const control = games.find((g) => g.id === "Calluna")!;
    // Only the extras the install target reads are written.
    expect(control.extra).toEqual({
      namespace: "ns-control",
      catalog_item_id: "cat-control",
      product_slug: "control",
    });
    expect(games.every((g) => g.store === "epic")).toBe(true);
    // What the install target and the store page make of them.
    expect(epicInstallLink(control)).toBe(
      "com.epicgames.launcher://apps/ns-control%3Acat-control%3ACalluna?action=launch&silent=true",
    );
    expect(storePage(control)).toBe("https://store.epicgames.com/p/control");

    // The next refresh finds every one of them in the list and looks up the
    // rest only.
    expect(epic.entriesToLookUp(entries, games).map((e) => e.appName)).toEqual([
      "CallunaDLC1",
      "Soundtrack",
      "EnginePlugin",
      "NotAnApplication",
    ]);
  });

  it("a catalog answer that isn't an object of items is an error", () => {
    for (const body of ["", "[]", "null", '"x"', "<html>"]) {
      const err = thrown(() =>
        epic.parseCatalogText(
          `${epic.CATALOG_URL}ns/bulk/items?id=SECRET`,
          body,
        ),
      );
      expect(err.message, body).toContain("Unexpected response from");
      expect(err.message, body).not.toContain("SECRET");
    }
    expect(epic.parseCatalogText(epic.CATALOG_URL, "{}").size).toBe(0);
  });

  it("a catalog item needs the catalog's shape", () => {
    const odd: unknown[] = [
      null,
      [],
      "x",
      { title: 5 },
      { categories: "games" },
      { categories: [5] },
      { categories: [{ path: null as unknown }] },
      { customAttributes: [] },
      { customAttributes: { a: "b" } },
      { customAttributes: { a: { value: 5 } } },
    ];
    for (const value of odd) {
      expect(
        epic.parseCatalogItem(value),
        JSON.stringify(value),
      ).toBeUndefined();
    }
    // A category without a path, a null main game, an attribute without a
    // value.
    expect(
      epic.parseCatalogItem({
        categories: [{}],
        mainGameItem: null,
        customAttributes: { a: { type: "STRING" } },
      }),
    ).toEqual({ categories: [""], customAttributes: { a: undefined } });
  });

  it("skips what isn't a game of its own", () => {
    const entryX = entry("X", "x");
    const game = (fields: object) =>
      epic.ownedGameFrom(entryX, epic.parseCatalogItem(fields)!);
    const apps = [{ path: "games" }, { path: "applications" }];
    expect(game({ title: "X", categories: apps })?.title).toBe("X");
    // Categories in other case.
    expect(
      game({ title: "X", categories: [{ path: "Applications" }] }),
    ).toBeDefined();
    expect(
      game({ title: "X", categories: [{ path: "games" }] }),
    ).toBeUndefined();
    expect(game({ title: "X" })).toBeUndefined();
    for (const notAGame of [
      "digitalextras",
      "plugins",
      "plugins/engine",
      "mods",
    ]) {
      expect(
        game({ title: "X", categories: [...apps, { path: notAGame }] }),
        notAGame,
      ).toBeUndefined();
    }
    expect(
      game({ title: "DLC", categories: apps, mainGameItem: { id: "y" } }),
    ).toBeUndefined();
    expect(
      game({
        title: "Launchable DLC",
        categories: [...apps, { path: "addons/launchable" }],
        mainGameItem: { id: "y" },
      })?.title,
    ).toBe("Launchable DLC");
    // No title, or one that is only a sign.
    expect(game({ categories: apps })).toBeUndefined();
    expect(game({ title: " ® ", categories: apps })).toBeUndefined();
  });

  it("reads the store page slug", () => {
    const slugOf = (value: unknown) =>
      epic.productSlug(
        epic.parseCatalogItem({
          customAttributes: {
            [epic.PRODUCT_SLUG_ATTRIBUTE]: { type: "STRING", value },
          },
        })!,
      );
    expect(slugOf("fortnite")).toBe("fortnite");
    // Written for the store's older addresses.
    expect(slugOf("control/home")).toBe("control");
    expect(slugOf(" /a-plague-tale_2/home/ ")).toBe("a-plague-tale_2");
    // Not a plain slug: left out rather than put in a link.
    expect(slugOf("bundles/some-bundle")).toBeUndefined();
    expect(slugOf("x?redirect=https://evil.example")).toBeUndefined();
    expect(slugOf("/home")).toBeUndefined();
    expect(slugOf("")).toBeUndefined();
    expect(slugOf(null)).toBeUndefined();
    expect(
      epic.productSlug(epic.parseCatalogItem({ title: "x" })!),
    ).toBeUndefined();
  });
});

describe("Epic account", () => {
  const items = JSON.parse(CATALOG);
  // A fake Epic: tokens rotate on every renewal, as Epic's do.
  let issued = 0;
  let validToken = "";
  let expiresIn = 7200;
  // An answer to the code grant other than the tokens.
  let codeAnswer: FakeAnswer | undefined;
  // The library's pages by cursor ("" is the first).
  let pages: Record<string, string> = {};
  let libraryDown = false;
  let catalogDown: (namespace: string) => boolean = () => false;
  let catalogRefusesSeveral = false;
  let killAnswer: () => FakeAnswer | Error = () => ({ status: 204 });
  // The refresh token on disk at each library request.
  const savedWhileListing: (string | undefined)[] = [];
  // The tokens whose sessions were ended.
  const killed: string[] = [];

  const tokenAnswer = (): FakeAnswer => {
    issued++;
    validToken = `eg1~access-${issued}`;
    return {
      body: {
        access_token: validToken,
        expires_in: expiresIn,
        token_type: "bearer",
        refresh_token: `eg1~refresh-${issued}`,
        account_id: ACCOUNT_ID,
        client_id: CLIENT,
        app: "launcher",
      },
    };
  };

  const host = new FakeStoreHost(({ url, init }) => {
    const u = new URL(url);
    const headers = init.headers || {};
    if (url === epic.OAUTH_TOKEN_URL) {
      if (init.method !== "POST" || headers.Authorization !== BASIC_AUTH) {
        return {
          status: 401,
          body: {
            errorCode:
              "errors.com.epicgames.account.invalid_client_credentials",
          },
        };
      }
      const form = new URLSearchParams(init.body);
      if (form.get("grant_type") === "authorization_code") {
        if (codeAnswer) {
          return codeAnswer;
        }
        return form.get("code") === CODE
          ? tokenAnswer()
          : { status: 400, body: TOKEN_CODE_USED };
      }
      if (
        form.get("grant_type") === "refresh_token" &&
        form.get("refresh_token") === `eg1~refresh-${issued}`
      ) {
        return tokenAnswer();
      }
      return {
        status: 400,
        body: {
          errorCode:
            "errors.com.epicgames.account.auth_token.invalid_refresh_token",
          errorMessage: `Sorry the refresh token '${form.get("refresh_token")}' is invalid`,
          error: "invalid_grant",
        },
      };
    }
    if (u.origin + u.pathname === epic.REDIRECT_URL) {
      // The cookie replay: a signed-in browser gets the code.
      return headers.Cookie === "EPIC_SSO=sso-cookie" &&
        headers["User-Agent"] === epic.LOGIN_USER_AGENT
        ? { body: REDIRECT_IN }
        : { body: REDIRECT_OUT };
    }
    if (headers.Authorization !== `bearer ${validToken}`) {
      return {
        status: 401,
        body: {
          errorCode: "errors.com.epicgames.common.oauth.invalid_token",
          errorMessage: "Invalid token",
        },
      };
    }
    if (headers["User-Agent"] !== epic.LAUNCHER_USER_AGENT) {
      return { status: 403 };
    }
    if (url.startsWith(epic.SESSION_KILL_URL)) {
      killed.push(decodeURIComponent(url.slice(epic.SESSION_KILL_URL.length)));
      return init.method === "DELETE" ? killAnswer() : { status: 405 };
    }
    if (url === `${epic.ACCOUNT_URL}${ACCOUNT_ID}`) {
      return { body: { id: ACCOUNT_ID, displayName: "Player One" } };
    }
    if (url.startsWith(epic.LIBRARY_ITEMS_URL)) {
      // What SRM has saved by the time it lists the games.
      savedWhileListing.push(
        storage.loadSession("epic", host)?.session.data.refreshToken,
      );
      if (libraryDown) {
        return { status: 503, body: "<html>Service Unavailable</html>" };
      }
      const page = pages[u.searchParams.get("cursor") ?? ""];
      return page === undefined ? { status: 404 } : { body: page };
    }
    if (url.startsWith(epic.CATALOG_URL)) {
      // (/catalog/api/shared/namespace/<namespace>/bulk/items)
      const namespace = decodeURIComponent(u.pathname.split("/")[5]);
      const ids = u.searchParams.getAll("id");
      if (catalogDown(namespace)) {
        return { status: 503, body: "<html>Service Unavailable</html>" };
      }
      if (catalogRefusesSeveral && ids.length > 1) {
        return {
          status: 400,
          body: { errorCode: "errors.com.epicgames.catalog.bad_request" },
        };
      }
      return {
        body: Object.fromEntries(
          ids
            .filter((id) => items[id]?.namespace === namespace)
            .map((id) => [id, items[id]]),
        ),
      };
    }
    return { status: 404 };
  });

  // What each catalog request asked for, in order.
  const catalogRequests = () =>
    host.requests
      .filter((r) => r.url.startsWith(epic.CATALOG_URL))
      .map((r) => new URL(r.url).searchParams.getAll("id"));

  const savedSession = (): StoreSession =>
    storage.loadSession("epic", host)!.session;

  const registered = storeClient("epic");
  beforeAll(() => registerStoreClient(epic.epicClient));
  beforeEach(() => {
    issued = 0;
    validToken = "";
    expiresIn = 7200;
    codeAnswer = undefined;
    pages = { "": LIBRARY_1, "cursor-page-2": LIBRARY_2 };
    libraryDown = false;
    catalogDown = () => false;
    catalogRefusesSeveral = false;
    killAnswer = () => ({ status: 204 });
    killed.length = 0;
    savedWhileListing.length = 0;
    host.requests.length = 0;
    host.logs.length = 0;
    setStoreHost(host);
  });
  afterEach(() => refresh.deleteAccount("epic"));
  afterAll(() => {
    if (registered) {
      registerStoreClient(registered);
    } else {
      unregisterStoreClient("epic");
    }
    setStoreHost(readOnlyStoreHost);
  });

  // A sign-in in the login window, which read the redirect page.
  const signIn = () =>
    refresh.completeLogin(refresh.pendingLogin("epic"), {
      finalUrl: epic.redirectUrl(),
      pageText: REDIRECT_IN,
      cookies: [],
    });

  const GAMES = [
    ["Calluna", "Control Ultimate Edition"],
    ["CallunaExpansionLauncher", "Control Standalone Expansion"],
    ["EAGame", "Star Wars Jedi: Fallen Order"],
    ["Fortnite", "Fortnite"],
    ["UbiGame", "Assassin's Creed Valhalla"],
  ];

  it("signs in from the page the window read and lists the games", async () => {
    // (the token answer has no name: it's asked for)
    expect(await signIn()).toBe("Player One");
    const library = await refresh.refreshLibrary("epic");
    expect(library.games.map((g) => [g.id, g.title])).toEqual(GAMES);
    expect(library.accountName).toBe("Player One");
    expect(library.partial).toBe(false);
    // One request per namespace.
    expect(catalogRequests()).toHaveLength(7);
    // Every request to Epic's services went out as the launcher.
    for (const request of host.requests) {
      expect(request.init.headers?.["User-Agent"], request.url).toBe(
        epic.LAUNCHER_USER_AGENT,
      );
    }
    // Nothing secret left in what's on disk in the clear.
    const info = JSON.stringify(storage.readSessionInfo("epic"));
    expect(info).not.toContain("eg1~");
    expect(savedSession().data).toMatchObject({
      accessToken: "eg1~access-1",
      refreshToken: "eg1~refresh-1",
      accountId: ACCOUNT_ID,
      displayName: "Player One",
    });
  });

  it("the next refresh asks the catalog only about what the list lacks", async () => {
    await signIn();
    await refresh.refreshLibrary("epic");
    host.requests.length = 0;
    const again = await refresh.refreshLibrary("epic");
    expect(again.games.map((g) => [g.id, g.title])).toEqual(GAMES);
    expect(catalogRequests().flat().sort()).toEqual([
      "cat-control-dlc",
      "cat-noapps",
      "cat-plugin",
      "cat-soundtrack",
    ]);
  });

  it("signs in with a pasted code, and explains a used one", async () => {
    const used = await refresh
      .completeLogin(refresh.pendingLogin("epic"), { pasted: "f".repeat(32) })
      .catch((e) => e);
    expect(used.message).toContain("expired or was already used");
    expect(isLoginRejected(used)).toBe(false);
    expect(refresh.accountStatus("epic").signedIn).toBe(false);

    await expect(
      refresh.completeLogin(refresh.pendingLogin("epic"), {
        pasted: "nothing here",
      }),
    ).rejects.toThrow("does not look like an Epic login code");

    expect(
      await refresh.completeLogin(refresh.pendingLogin("epic"), {
        pasted: `authorizationCode\t"${CODE}"`,
      }),
    ).toBe("Player One");
    expect(refresh.accountStatus("epic").signedIn).toBe(true);
  });

  it("replays the window's cookies when it couldn't read the page", async () => {
    const capture = (cookies: LoginCapture["cookies"]): LoginCapture => ({
      finalUrl: epic.redirectUrl(),
      cookies,
    });
    await expect(
      refresh.completeLogin(refresh.pendingLogin("epic"), capture([])),
    ).rejects.toThrow("no Epic cookies");
    // A window that wasn't signed in.
    await expect(
      refresh.completeLogin(
        refresh.pendingLogin("epic"),
        capture([{ name: "other", value: "x", domain: ".epicgames.com" }]),
      ),
    ).rejects.toThrow("not signed in");

    const name = await refresh.completeLogin(
      refresh.pendingLogin("epic"),
      capture([
        { name: "EPIC_SSO", value: "sso-cookie", domain: ".epicgames.com" },
        { name: "tracker", value: "x", domain: "example.com" },
      ]),
    );
    expect(name).toBe("Player One");
    const replays = host.requests.filter((r) => r.url === epic.redirectUrl());
    expect(replays[replays.length - 1]?.init.headers?.Cookie).toBe(
      "EPIC_SSO=sso-cookie",
    );
  });

  it("a sign-in Epic wants confirmed says where to go", async () => {
    codeAnswer = { status: 400, body: TOKEN_CORRECTIVE };
    const err = await refresh
      .completeLogin(refresh.pendingLogin("epic"), { pasted: CODE })
      .catch((e) => e);
    expect(err.message).toContain(
      "Epic needs you to confirm something on your account first",
    );
    expect(err.message).toContain(
      "https://www.epicgames.com/id/login/corrective",
    );
    expect(isLoginRejected(err)).toBe(false);
    expect(refresh.accountStatus("epic").signedIn).toBe(false);
  });

  it("renews a token about to expire, and saves the new one before listing", async () => {
    expiresIn = 60; // (within the renewal margin)
    await signIn();
    libraryDown = true;
    const err = await refresh.refreshLibrary("epic").catch((e) => e);
    expect(isTransient(err)).toBe(true);
    expect(isLoginRejected(err)).toBe(false);
    // The rotated refresh token was on disk before the games were listed:
    // the old one no longer works, and SRM may close during a long list.
    expect(savedWhileListing).toEqual(["eg1~refresh-2"]);
    // And it's kept, although the list failed.
    const saved = savedSession();
    expect(saved.data).toMatchObject({
      accessToken: "eg1~access-2",
      refreshToken: "eg1~refresh-2",
      displayName: "Player One",
    });
    expect(saved.accountName).toBe("Player One");

    libraryDown = false;
    const library = await refresh.refreshLibrary("epic");
    expect(library.games).toHaveLength(5);
    expect(library.accountName).toBe("Player One");
    expect(savedSession().data.refreshToken).toBe("eg1~refresh-3");
  });

  it("a token Epic ended early is renewed once", async () => {
    await signIn();
    validToken = "eg1~ended-early";
    // (the renewal makes access-2 the valid one)
    const library = await refresh.refreshLibrary("epic");
    expect(library.games).toHaveLength(5);
    expect(savedSession().data.refreshToken).toBe("eg1~refresh-2");
    // (saved before the library was asked for again)
    expect(savedWhileListing).toEqual(["eg1~refresh-2", "eg1~refresh-2"]);
  });

  it("a refused refresh token asks to sign in again", async () => {
    expiresIn = 60;
    await signIn();
    // Someone else used the refresh token (it rotated away).
    issued = 5;
    const err = await refresh.refreshLibrary("epic").catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    expect(err.message).toContain("Sign in again");
    const status = refresh.accountStatus("epic");
    expect(status.needsSignIn).toBe(true);
    expect(status.lastError).not.toContain("eg1~");
  });

  it("a catalog outage leaves out new games for now and keeps listed ones", async () => {
    await signIn();
    catalogDown = (namespace) => namespace === "ns-ubi";
    const first = await refresh.refreshLibrary("epic");
    expect(first.partial).toBe(true);
    expect(first.games.map((g) => g.id)).toEqual([
      "Calluna",
      "CallunaExpansionLauncher",
      "EAGame",
      "Fortnite",
    ]);
    expect(
      host.logs.some((l) => l.includes("1 Epic games could not be looked up")),
    ).toBe(true);

    catalogDown = () => false;
    const second = await refresh.refreshLibrary("epic");
    expect(second.partial).toBe(false);
    expect(second.games).toHaveLength(5);

    // Down entirely: every listed game stays. (What isn't a game is in no
    // list, so the list is fetched again soon.)
    catalogDown = () => true;
    const third = await refresh.refreshLibrary("epic");
    expect(third.games.map((g) => [g.id, g.title])).toEqual(GAMES);
    expect(third.partial).toBe(true);
  });

  it("a first list the catalog can't look up at all fails", async () => {
    await signIn();
    catalogDown = () => true;
    const err = await refresh.refreshLibrary("epic").catch((e) => e);
    expect(err.message).toContain("Could not look up the Epic games");
    expect(isTransient(err)).toBe(true);
    expect(refresh.cachedLibrary("epic")).toBeNull();
  });

  it("asks for ids one by one when Epic refuses a request for several", async () => {
    await signIn();
    catalogRefusesSeveral = true;
    const library = await refresh.refreshLibrary("epic");
    expect(library.games.map((g) => [g.id, g.title])).toEqual(GAMES);
    expect(library.partial).toBe(false);
    expect(
      catalogRequests().filter((ids) => ids[0].startsWith("cat-control")),
    ).toEqual([
      ["cat-control", "cat-control-dlc", "cat-control-launchable"],
      ["cat-control"],
      ["cat-control-dlc"],
      ["cat-control-launchable"],
    ]);
  });

  it("a library that sends the same cursor again is not saved", async () => {
    await signIn();
    const page = JSON.stringify({
      responseMetadata: { nextCursor: "again" },
      records: [],
    });
    pages = { "": page, again: page };
    const err = await refresh.refreshLibrary("epic").catch((e) => e);
    expect(err.message).toContain("sent the same page twice");
    expect(refresh.cachedLibrary("epic")).toBeNull();
  });

  it("sign-out ends the session at Epic", async () => {
    await signIn();
    expect(await refresh.signOut("epic")).toBeNull();
    expect(killed).toEqual(["eg1~access-1"]);
    expect(refresh.accountStatus("epic").signedIn).toBe(false);
  });

  it("a sign-out Epic didn't hear about warns without naming the token", async () => {
    await signIn();
    killAnswer = () =>
      new Error(`connect ECONNREFUSED ${epic.SESSION_KILL_URL}${validToken}`);
    const warning = await refresh.signOut("epic");
    expect(warning).toContain("may still list SRM's login");
    expect(warning).toContain("Epic could not be reached");
    expect(warning).not.toContain("eg1~access");
    expect(refresh.accountStatus("epic").signedIn).toBe(false);

    await signIn();
    killAnswer = () => ({ status: 503 });
    expect(await refresh.signOut("epic")).toContain("Epic answered 503");
  });

  it("signing out of a login Epic no longer accepts asks Epic nothing more", async () => {
    expiresIn = 60;
    await signIn();
    issued = 5;
    expect(await refresh.signOut("epic")).toBeNull();
    expect(killed).toEqual([]);
    expect(refresh.accountStatus("epic").signedIn).toBe(false);
  });

  it("an unreadable session asks to sign in again", async () => {
    storage.saveSession(
      "epic",
      { accountName: null, data: { cookies: [] } },
      host,
    );
    await expect(refresh.refreshLibrary("epic")).rejects.toSatisfy(
      (err: Error) =>
        isLoginRejected(err) && err.message.includes("Sign in again"),
    );
    expect(host.requests).toEqual([]);
  });
});
