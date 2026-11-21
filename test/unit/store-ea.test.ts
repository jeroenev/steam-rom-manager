// EA app accounts (ported from BoilR's ea.rs tests, plus a sign-in and a
// refresh against a fake EA).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { gamesToAdd } from "../../src/lib/parsers/store-account.parser";
import * as ea from "../../src/lib/stores/ea";
import { readOnlyStoreHost, setStoreHost } from "../../src/lib/stores/host";
import {
  BROWSER_USER_AGENT,
  StoreHttp,
  isLoginRejected,
  isTransient,
  queryParam,
  statusOf,
  transient,
} from "../../src/lib/stores/http";
import { eaInstalled } from "../../src/lib/stores/installed-ids";
import * as refresh from "../../src/lib/stores/refresh";
import {
  registerStoreClient,
  storeClient,
  unregisterStoreClient,
} from "../../src/lib/stores/registry";
import * as storage from "../../src/lib/stores/storage";
import { eaInstallLink } from "../../src/lib/stores/targets";
import {
  ListContext,
  OwnedGame,
  StoreCookie,
  StoreSession,
  ownedGame,
} from "../../src/lib/stores/types";
import {
  FakeAnswer,
  FakeRequest,
  FakeStoreHost,
  storeFixture,
} from "../helpers/fake-store-host";

const LEGACY_OFFERS = storeFixture("ea", "legacy_offers.json");
const NOT_AUTHENTICATED = storeFixture("ea", "not_authenticated.json");
const PAGE_1 = storeFixture("ea", "owned_games_page1.json");
const PAGE_2 = storeFixture("ea", "owned_games_page2.json");
const TRIALS = storeFixture("ea", "owned_games_trials.json");
const PLAYER = storeFixture("ea", "player.json");
const LOGIN_REQUIRED = storeFixture("ea", "token_login_required.json");
const TOKEN_OK = storeFixture("ea", "token_ok.json");
// (the access token in token_ok.json)
const FIXTURE_TOKEN = "QVQwOjIuMDozLjA6NjA6dGVzdHRva2Vu";

const cookie = (name: string, value: string, domain: string): StoreCookie => ({
  name,
  value,
  domain,
});

// What went wrong, when it's neither a refused login nor a transient
// failure; undefined otherwise.
function plainError(run: () => unknown): string | undefined {
  try {
    run();
  } catch (err) {
    return isLoginRejected(err) || isTransient(err)
      ? undefined
      : (err as Error).message;
  }
  throw new Error("no error");
}

function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error("no error");
}

const read = (status: number, body: string) =>
  ea.graphqlAnswer(status, body, ea.parseOwnedGamesPage);

describe("EA", () => {
  it("login URLs don't finish early", () => {
    const pending = ea.beginLogin();
    const done = (url: string) =>
      pending.doneUrlPrefixes.some((prefix) => url.startsWith(prefix));
    expect(done(pending.startUrl)).toBe(false);
    // The pages EA's sign-in goes through (seen 2026-11-08).
    expect(
      done(
        "https://accounts.ea.com/connect/auth?response_type=code&redirect_uri=https%3A%2F%2Fwww.ea.com%2Flogin_check&state=x&locale=en_US&client_id=EADOTCOM-WEB-SERVER&display=junoWeb%2Flogin",
      ),
    ).toBe(false);
    expect(done("https://signin.ea.com/p/juno/login?fid=abc")).toBe(false);
    expect(done("https://www.ea.com/login_check?code=QUOx&state=x")).toBe(true);
    // The window only stops there: nothing is loaded for its text.
    expect(pending.pageTextUrlPrefixes).toEqual([]);
  });

  it("the login window is asked for what the token request needs", () => {
    const pending = ea.beginLogin();
    // Cookies scoped to /connect aren't handed out for the root URL.
    expect(pending.cookieUrls).toContain(ea.AUTH_URL);
    for (const url of pending.cookieUrls) {
      expect(url.startsWith(`https://${ea.ACCOUNTS_HOST}/`), url).toBe(true);
    }
    // The session is used under the user agent it was made with.
    expect(pending.userAgent).toBe(BROWSER_USER_AGENT);
    // HttpOnly cookies can't be pasted.
    expect(pending.manual).toEqual({ kind: "unsupported" });
    expect(pending.store).toBe("ea");
    // The token request is the one EaLibrary sends.
    expect(ea.TOKEN_URL).toBe(
      "https://accounts.ea.com/connect/auth?client_id=ORIGIN_JS_SDK&response_type=token&redirect_uri=nucleus:rest&prompt=none",
    );
  });

  it("only cookies for the accounts host count", () => {
    // Domains as a login window reports them: without a leading dot.
    const captured = [
      cookie("sid", "s", "accounts.ea.com"),
      cookie("remid", "r", "accounts.ea.com"),
      cookie("site", "e", "ea.com"),
      cookie("signin", "x", "signin.ea.com"),
      cookie("shop", "w", "www.ea.com"),
      cookie("tracker", "t", "example.com"),
      cookie("lookalike", "l", "notea.com"),
      cookie("nowhere", "n", "."),
    ];
    const kept = ea.sessionCookies(captured);
    expect(kept.map((c) => c.name)).toEqual(["sid", "remid", "site"]);
    expect(ea.sessionCookies([cookie("shop", "w", "www.ea.com")])).toEqual([]);
    // With a leading dot too; one per name and domain, the last wins.
    expect(
      ea.sessionCookies([
        cookie("site", "old", ".ea.com"),
        cookie("sid", "s", "accounts.ea.com"),
        cookie("site", "new", ".ea.com"),
      ]),
    ).toEqual([
      cookie("sid", "s", "accounts.ea.com"),
      cookie("site", "new", ".ea.com"),
    ]);
  });

  it("reads the access token", () => {
    expect(ea.tokenFromAnswer(200, TOKEN_OK)).toBe(FIXTURE_TOKEN);
  });

  it("only a required login asks to sign in again", () => {
    for (const status of [200, 400, 401]) {
      const refused = errorOf(() => ea.tokenFromAnswer(status, LOGIN_REQUIRED));
      expect(isLoginRejected(refused), String(status)).toBe(true);
      expect((refused as Error).message).toContain("Sign in again");
    }

    // An outage or a rate limit, whatever the body says.
    for (const [status, body] of [
      [503, "<html>Service Unavailable</html>"],
      [502, ""],
      [429, '{"error":"too_many_requests"}'],
      [500, LOGIN_REQUIRED],
    ] as const) {
      const outage = errorOf(() => ea.tokenFromAnswer(status, body));
      expect(isTransient(outage) && !isLoginRejected(outage), body).toBe(true);
      expect(statusOf(outage)).toBe(status);
    }

    // Another error is reported with EA's own word for it.
    const other = plainError(() =>
      ea.tokenFromAnswer(400, '{"error":"invalid_request"}'),
    );
    expect(other).toContain("invalid_request");

    // A page where JSON was expected, a bot block, and a token on a failed
    // request.
    expect(
      plainError(() => ea.tokenFromAnswer(200, "<html>login</html>")),
    ).toContain("Unexpected answer");
    expect(
      plainError(() => ea.tokenFromAnswer(403, "<html>Access Denied</html>")),
    ).toBeDefined();
    const failed = plainError(() => ea.tokenFromAnswer(404, TOKEN_OK));
    expect(failed).toBeDefined();
    // (and the token isn't in the message)
    expect(failed).not.toContain(FIXTURE_TOKEN);
    expect(
      plainError(() => ea.tokenFromAnswer(200, '{"access_token":""}')),
    ).toBeDefined();
    expect(
      plainError(() => ea.tokenFromAnswer(200, '{"access_token":42}')),
    ).toBeDefined();

    // A 401 without EA's reason is a refused login by its status.
    expect(isLoginRejected(errorOf(() => ea.tokenFromAnswer(401, "")))).toBe(
      true,
    );
  });

  it("errors about the token keep secrets out", () => {
    const page = plainError(() =>
      ea.tokenFromAnswer(
        200,
        '<html><a href="https://accounts.ea.com/connect/auth?code=SECRET1">go</a></html>',
      ),
    );
    expect(page).toContain("https://accounts.ea.com/connect/auth");
    expect(page).not.toContain("SECRET1");
    const failed = plainError(() =>
      ea.tokenFromAnswer(404, '{"access_token":"SECRET2","sid":"SECRET3"}'),
    );
    expect(failed).not.toContain("SECRET2");
    expect(failed).not.toContain("SECRET3");
  });

  it("parses the pages of owned games", () => {
    const first = ea.parseOwnedGamesPage(PAGE_1);
    expect(first.next).toBe("Mw==");
    // A Way Out is only there through the linked Steam account. Crysis comes
    // with Game Pass, which the EA app installs.
    expect(first.games.map((g) => g.title)).toEqual([
      "Battlefield 3",
      "Crysis",
    ]);

    const battlefield = first.games[0];
    expect(battlefield.store).toBe("ea");
    expect(battlefield.id).toBe("DR:225064100");
    // The content id is added later; nothing else is kept.
    expect(battlefield.extra).toEqual({});

    const second = ea.parseOwnedGamesPage(PAGE_2);
    expect(second.next).toBeNull();
    const zuma = second.games[0];
    expect(zuma.id).toBe("OFB-EAST:52735");
    // Trademark signs are dropped.
    expect(zuma.title).toBe("Zuma's Revenge");

    // An empty cursor ends the list like a missing one.
    expect(
      ea.parseOwnedGamesPage(
        '{"data":{"me":{"ownedGameProducts":{"next":"","items":[]}}}}',
      ).next,
    ).toBeNull();
    expect(
      ea.parseOwnedGamesPage('{"data":{"me":{"ownedGameProducts":{}}}}'),
    ).toEqual({ games: [], next: null });
  });

  it("an entry without an offer id, a product or a title is skipped", () => {
    const page = (items: unknown[]) =>
      ea.parseOwnedGamesPage(
        JSON.stringify({ data: { me: { ownedGameProducts: { items } } } }),
      );
    const games = page([
      // (originOfferId first, the id when it's empty)
      { id: "A", originOfferId: "", product: { name: "Game A" } },
      { id: "x", originOfferId: "B", product: { name: "Game B" } },
      // (the base item's title when the product has no name)
      { id: "C", product: { name: " ™ ", baseItem: { title: "Game C®" } } },
      { id: "", originOfferId: null, product: { name: "No Id" } },
      { id: "D" },
      { id: "E", product: { name: null, baseItem: null } },
    ]);
    expect(games.games.map((g) => [g.id, g.title])).toEqual([
      ["A", "Game A"],
      ["B", "Game B"],
      ["C", "Game C"],
    ]);
  });

  it("games of a linked store are left out unless EA gives them too", () => {
    const linkedOnly = (methods: string[]) =>
      ea.onlyThroughLinkedStore(methods);
    // Bought on Steam or Epic, or part of an EA Play subscription taken out
    // there.
    for (const method of [
      "STEAM",
      "STEAM_VAULT",
      "STEAM_SUBSCRIPTION",
      "EPIC",
      "EPIC_VAULT",
      "EPIC_SUBSCRIPTION",
    ]) {
      expect(linkedOnly([method]), method).toBe(true);
    }
    expect(linkedOnly(["STEAM", "EPIC"])).toBe(true);
    // Steam purchases carry EA's grant too (both orders are in EaLibrary's
    // sample).
    expect(linkedOnly(["STEAM", "ENTITLEMENT_GRANT"])).toBe(true);
    expect(linkedOnly(["ENTITLEMENT_GRANT", "STEAM"])).toBe(true);
    expect(linkedOnly(["EPIC_VAULT", "ENTITLEMENT_GRANT"])).toBe(true);

    // Real EA ownership wins.
    expect(linkedOnly(["STEAM", "PURCHASE", "ENTITLEMENT_GRANT"])).toBe(false);
    expect(linkedOnly(["STEAM", "REDEMPTION", "ENTITLEMENT_GRANT"])).toBe(
      false,
    );
    expect(linkedOnly(["EPIC", "GIFT_RECEIPT"])).toBe(false);
    expect(linkedOnly(["STEAM_VAULT", "PRE_ORDER_PURCHASE"])).toBe(false);
    expect(linkedOnly(["EPIC_SUBSCRIPTION", "DIRECT_ENTITLEMENT"])).toBe(false);
    // So do the subscriptions the EA app installs, and a method SRM doesn't
    // know.
    expect(linkedOnly(["STEAM", "XGP_VAULT"])).toBe(false);
    expect(linkedOnly(["EPIC", "VAULT"])).toBe(false);
    expect(linkedOnly(["STEAM", "SOMETHING_NEW"])).toBe(false);

    // Nothing from a linked store.
    expect(linkedOnly(["PURCHASE", "ENTITLEMENT_GRANT"])).toBe(false);
    expect(linkedOnly(["ENTITLEMENT_GRANT"])).toBe(false);
    expect(linkedOnly(["VAULT"])).toBe(false);
    expect(linkedOnly(["XGP_VAULT"])).toBe(false);
    expect(linkedOnly(["UNKNOWN"])).toBe(false);
    expect(linkedOnly([])).toBe(false);
  });

  it("only a clear trial is left out", () => {
    const page = ea.parseOwnedGamesPage(TRIALS);
    // A bought game with a trial on record stays, and so does a trial
    // product the account also bought. The open trial held by nothing but
    // its grant goes.
    expect(page.games.map((g) => g.title)).toEqual([
      "A Way Out",
      "Bought After The Trial",
    ]);

    const grant = ["ENTITLEMENT_GRANT"];
    expect(ea.isUnownedTrial(true, true, grant)).toBe(true);
    expect(ea.isUnownedTrial(true, true, [])).toBe(true);
    // Any doubt keeps the game.
    expect(ea.isUnownedTrial(false, true, grant)).toBe(false);
    expect(ea.isUnownedTrial(true, false, grant)).toBe(false);
    for (const owned of [
      ["PURCHASE", "ENTITLEMENT_GRANT"],
      ["VAULT"],
      ["XGP_VAULT"],
      ["UNKNOWN"],
    ]) {
      expect(ea.isUnownedTrial(true, true, owned), owned.join()).toBe(false);
    }
  });

  it("every ownership method is asked for once", () => {
    const variables = JSON.parse(
      queryParam(ea.ownedGamesUrl(ea.FIRST_PAGE), "variables") ?? "{}",
    );
    expect(variables.ownershipMethods).toEqual(ea.OWNERSHIP_METHODS);
    expect(new Set(ea.OWNERSHIP_METHODS).size).toBe(
      ea.OWNERSHIP_METHODS.length,
    );
    expect(ea.OWNERSHIP_METHODS.filter(ea.isLinkedStore)).toHaveLength(6);
  });

  it("the game list is asked for as BoilR asks for it", () => {
    const url = ea.ownedGamesUrl("Mw==");
    expect(queryParam(url, "operationName")).toBe("getPreloadedOwnedGames");
    // The exact variables and their order (BoilR's JSON keys are sorted).
    expect(queryParam(url, "variables")).toBe(
      '{"addFieldsToPreloadGames":true,"entitlementEnabled":true,"isMac":false,"limit":500,"locale":"en","next":"Mw==",' +
        '"ownershipMethods":["UNKNOWN","ASSOCIATION","PURCHASE","REDEMPTION","GIFT_RECEIPT","ENTITLEMENT_GRANT","DIRECT_ENTITLEMENT","PRE_ORDER_PURCHASE","VAULT","XGP_VAULT","STEAM","STEAM_VAULT","STEAM_SUBSCRIPTION","EPIC","EPIC_VAULT","EPIC_SUBSCRIPTION"],' +
        '"platforms":["PC"],"storefronts":["EA","STEAM","EPIC"],"type":["DIGITAL_FULL_GAME","PACKAGED_FULL_GAME"]}',
    );
    expect(queryParam(url, "extensions")).toBe(
      `{"persistedQuery":{"sha256Hash":"${ea.OWNED_GAMES_QUERY_HASH}","version":1}}`,
    );
    expect(ea.OWNED_GAMES_QUERY_HASH).toBe(
      "779f1cd1355699752e20c0b3877847f4e3010ef5de131c248e98f8eff84f0718",
    );
    // (form-encoded, as BoilR's url crate encodes it)
    expect(url).toMatch(
      /^https:\/\/service-aggregation-layer\.juno\.ea\.com\/graphql\?operationName=getPreloadedOwnedGames&variables=%7B%22addFieldsToPreloadGames%22%3Atrue%2C/,
    );
    expect(url).toContain("%22next%22%3A%22Mw%3D%3D%22");
  });

  it("the catalog lookup and the name are asked for as BoilR asks for them", () => {
    expect(JSON.parse(ea.legacyOffersBody(["A", "B"]))).toEqual({
      operationName: "getLegacyCatalogDefs",
      query:
        "query getLegacyCatalogDefs($offerIds: [String!]!, $locale: Locale) { legacyOffers(offerIds: $offerIds, locale: $locale) { offerId: id contentId } }",
      variables: { locale: "DEFAULT", offerIds: ["A", "B"] },
    });
    expect(JSON.parse(ea.PLAYER_NAME_BODY)).toEqual({
      query: "query { me { player { displayName } } }",
    });
  });

  it("an unauthenticated answer is a refused login", () => {
    expect(
      isLoginRejected(errorOf(() => ea.parseOwnedGamesPage(NOT_AUTHENTICATED))),
    ).toBe(true);
    // EA sends it with 401.
    const refused = errorOf(() => read(401, NOT_AUTHENTICATED));
    expect(isLoginRejected(refused)).toBe(true);
    expect((refused as Error).message).toContain("Sign in again");
    // The catalog too.
    expect(
      isLoginRejected(errorOf(() => ea.parseLegacyOffers(NOT_AUTHENTICATED))),
    ).toBe(true);
  });

  it("a failure status is never read as an empty answer", () => {
    // JSON that isn't a GraphQL answer: the status decides.
    const unauthorized = errorOf(() => read(401, '{"message":"Unauthorized"}'));
    expect(
      isLoginRejected(unauthorized) && statusOf(unauthorized) === 401,
    ).toBe(true);
    const limited = errorOf(() => read(429, '{"message":"Too many requests"}'));
    expect(isTransient(limited) && !isLoginRejected(limited)).toBe(true);
    expect(
      isTransient(errorOf(() => read(503, "<html>Service Unavailable</html>"))),
    ).toBe(true);
    const blocked = errorOf(() => read(403, "<html>Access Denied</html>"));
    expect(statusOf(blocked) === 403 && !isLoginRejected(blocked)).toBe(true);

    // A GraphQL error with an outage status stays an outage, and with 401 a
    // refused login.
    const upstream =
      '{"errors":[{"message":"upstream timed out"}],"data":null}';
    const outage = errorOf(() => read(502, upstream));
    expect(isTransient(outage) && !isLoginRejected(outage)).toBe(true);
    expect(isLoginRejected(errorOf(() => read(401, upstream)))).toBe(true);
    // With another status, EA's error is the message.
    expect(plainError(() => read(400, upstream))).toContain(
      "upstream timed out",
    );

    // Data that comes with a failure status isn't taken as the game list.
    expect(isTransient(errorOf(() => read(500, PAGE_1)))).toBe(true);
    expect(statusOf(errorOf(() => read(404, PAGE_1)))).toBe(404);
    expect(read(200, PAGE_1).games).toHaveLength(2);
  });

  it("an unknown persisted query asks for an update, not a sign-in", () => {
    for (const body of [
      '{"errors":[{"message":"PersistedQueryNotFound","extensions":{"code":"PERSISTED_QUERY_NOT_FOUND"}}]}',
      '{"data":null,"errors":[{"message":"PersistedQueryNotFound"}]}',
      '{"errors":[{"message":"PersistedQueryNotSupported","extensions":{"code":"PERSISTED_QUERY_NOT_SUPPORTED"}}]}',
    ]) {
      for (const status of [200, 400]) {
        const message = plainError(() => read(status, body)) ?? "";
        expect(message, body).toContain("SRM needs an update");
        expect(message.toLowerCase(), body).not.toContain("sign in");
      }
    }
  });

  it("GraphQL errors are reported with EA's message", () => {
    // No data at all.
    expect(
      plainError(() =>
        ea.parseOwnedGamesPage(
          '{"data":null,"errors":[{"message":"Something broke"}]}',
        ),
      ),
    ).toContain("Something broke");
    // Data without the account in it.
    expect(
      plainError(() =>
        ea.parseOwnedGamesPage(
          '{"data":{"me":null},"errors":[{"message":"Account lookup failed"}]}',
        ),
      ),
    ).toContain("Account lookup failed");
    expect(
      plainError(() => ea.parseOwnedGamesPage('{"data":{"me":{}}}')),
    ).toContain("no data in the answer");
    // Not GraphQL at all.
    expect(plainError(() => ea.parseOwnedGamesPage("<html></html>"))).toContain(
      "Unexpected answer",
    );
    // Partial data (data plus errors on some fields) is kept.
    expect(
      ea.parseOwnedGamesPage(
        '{"data":{"me":{"ownedGameProducts":{"items":[]}}},"errors":[{"message":"a field failed"}]}',
      ).games,
    ).toEqual([]);
  });

  it("an answer of another shape is an unexpected answer, not an empty library", () => {
    for (const body of [
      "",
      "[]",
      '"text"',
      '{"data":5}',
      '{"data":{"me":5}}',
      '{"data":{"me":{"ownedGameProducts":[]}}}',
      '{"data":{"me":{"ownedGameProducts":{"items":"x"}}}}',
      '{"data":{"me":{"ownedGameProducts":{"items":[null]}}}}',
      '{"data":{"me":{"ownedGameProducts":{"next":3,"items":[]}}}}',
      '{"data":{"me":{"ownedGameProducts":{"items":[{"id":"A","product":{"name":"A","gameProductUser":{"ownershipMethods":[1]}}}]}}}}',
      '{"errors":"broken"}',
      '{"errors":[5]}',
    ]) {
      const err = errorOf(() => ea.parseOwnedGamesPage(body));
      expect((err as Error).message, body).toContain("Unexpected answer");
      expect(isLoginRejected(err) || isTransient(err), body).toBe(false);
    }
  });

  it("parses content ids", () => {
    const ids = ea.parseLegacyOffers(LEGACY_OFFERS);
    expect(ids.size).toBe(4);
    expect(ids.get("Origin.OFR.50.0002487")).toBe("1028663");
    // Offers the catalog doesn't know come back as null, or without a
    // content id.
    expect([
      ...ea.parseLegacyOffers(
        '{"data":{"legacyOffers":[null,{"offerId":"A"},{"offerId":"B","contentId":""},{"offerId":"C","contentId":"3"}]}}',
      ),
    ]).toEqual([["C", "3"]]);
    expect(ea.parseLegacyOffers('{"data":{"legacyOffers":null}}').size).toBe(0);
    expect(
      plainError(() =>
        ea.parseLegacyOffers('{"data":null,"errors":[{"message":"down"}]}'),
      ),
    ).toContain("down");
    expect(
      plainError(() => ea.parseLegacyOffers('{"data":{"legacyOffers":[5]}}')),
    ).toContain("Unexpected answer from EA's catalog");
  });

  it("content ids fall back to the previous library", () => {
    const games = [
      ownedGame("ea", "A", "A"),
      ownedGame("ea", "B", "B"),
      ownedGame("ea", "C", "C"),
    ];
    const found = new Map([["A", "1"]]);
    const previous = [
      ownedGame("ea", "A", "A", { content_id: "old" }),
      ownedGame("ea", "B", "B", { content_id: "2" }),
    ];
    expect(
      ea.withContentIds(games, found, previous).map((g) => g.extra.content_id),
    ).toEqual(["1", "2", undefined]);
    // (the games themselves are left as they were)
    expect(games[0].extra).toEqual({});
  });

  it("a failed content id batch ends the lookup", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => String(i));
    const contentIds = (batch: string[]) =>
      new Map(batch.map((id) => [id, `c${id}`]));

    let asked = 0;
    const failing = await ea.lookupInBatches(ids, 2, async (batch) => {
      asked++;
      if (asked === 2) {
        throw transient("the catalog is down");
      }
      return contentIds(batch);
    });
    // The third and fourth batch were never asked for.
    expect(asked).toBe(2);
    expect(failing.found.size).toBe(2);
    expect(isTransient(failing.failed)).toBe(true);

    const batches: string[][] = [];
    const working = await ea.lookupInBatches(ids, 2, async (batch) => {
      batches.push(batch);
      return contentIds(batch);
    });
    expect(working.found.size).toBe(7);
    expect(working.failed).toBeNull();
    expect(batches.map((b) => b.length)).toEqual([2, 2, 2, 1]);
  });

  it("parses the player name", () => {
    expect(ea.parsePlayerName(PLAYER)).toBe("PlayerOne");
    expect(ea.parsePlayerName(NOT_AUTHENTICATED)).toBeNull();
    expect(
      ea.parsePlayerName('{"data":{"me":{"player":{"displayName":" "}}}}'),
    ).toBeNull();
    expect(ea.parsePlayerName("<html>")).toBeNull();
  });
});

describe("EA account", () => {
  const offers: { offerId: string; contentId: string }[] =
    JSON.parse(LEGACY_OFFERS).data.legacyOffers;

  // The fake EA. `signedIn`: the cookies in EA's partition are still good.
  let signedIn = true;
  let tokenDown = false;
  let catalogDown = false;
  let issued = 0;
  let validToken = "";
  // The page for a cursor, as a body or a whole answer.
  let pageFor: (cursor: string) => unknown;
  // The catalog's content id for an offer.
  let contentIdOf: (offerId: string) => string | undefined;

  const defaultPages = (cursor: string) =>
    cursor === ea.FIRST_PAGE
      ? PAGE_1
      : cursor === "Mw=="
        ? PAGE_2
        : { status: 400, body: { errors: [{ message: "Bad cursor" }] } };

  const isAnswer = (value: unknown): value is FakeAnswer =>
    typeof value === "object" &&
    value !== null &&
    ("status" in value || "body" in value);

  const handler = ({ url, init }: FakeRequest): FakeAnswer => {
    const u = new URL(url);
    if (`${u.origin}${u.pathname}` === ea.AUTH_URL) {
      if (tokenDown) {
        return { status: 503, body: "<html>Service Unavailable</html>" };
      }
      if (!signedIn) {
        return { status: 400, body: LOGIN_REQUIRED };
      }
      issued++;
      validToken = `token-${issued}`;
      return {
        body: {
          access_token: validToken,
          token_type: "Bearer",
          expires_in: "3599",
        },
      };
    }
    if (`${u.origin}${u.pathname}` !== ea.GRAPHQL_URL) {
      return { status: 404 };
    }
    const authorized = init.headers?.Authorization === `Bearer ${validToken}`;
    if (init.method === "POST") {
      const request = JSON.parse(init.body ?? "{}");
      if (request.operationName === "getLegacyCatalogDefs") {
        if (catalogDown) {
          return { status: 503, body: "<html>Service Unavailable</html>" };
        }
        return {
          body: {
            data: {
              legacyOffers: request.variables.offerIds.map((id: string) => {
                const contentId = contentIdOf(id);
                return contentId ? { offerId: id, contentId } : null;
              }),
            },
          },
        };
      }
      return authorized
        ? { body: PLAYER }
        : { status: 401, body: NOT_AUTHENTICATED };
    }
    if (u.searchParams.get("operationName") === "getPreloadedOwnedGames") {
      if (!authorized) {
        return { status: 401, body: NOT_AUTHENTICATED };
      }
      const page = pageFor(JSON.parse(u.searchParams.get("variables")!).next);
      return isAnswer(page) ? page : { body: page };
    }
    return { status: 404 };
  };
  const host = new FakeStoreHost(handler);

  const tokenRequests = () =>
    host.requests.filter((r) => r.url.startsWith(ea.AUTH_URL));
  const libraryRequests = () =>
    host.requests.filter((r) => r.url.includes("getPreloadedOwnedGames"));
  const catalogRequests = () =>
    host.requests.filter((r) =>
      (r.init.body ?? "").includes("getLegacyCatalogDefs"),
    );

  // What the login window hands over once EA sent it to login_check.
  const WINDOW_COOKIES = [
    cookie("sid", "sid-value", "accounts.ea.com"),
    cookie("remid", "remid-value", "accounts.ea.com"),
    cookie("ak_bmsc", "site-value", ".ea.com"),
  ];
  const signIn = () =>
    refresh.completeLogin(refresh.pendingLogin("ea"), {
      finalUrl: "https://www.ea.com/login_check?code=QUOx&state=x",
      cookies: WINDOW_COOKIES,
    });

  // A list of one account, without the refresh around it.
  const listContext = (previous: OwnedGame[] = []) => {
    const logs: string[] = [];
    const ctx: ListContext = {
      http: new StoreHttp(host.fetchFor("ea")),
      now: () => 1_000,
      log: (message) => logs.push(message),
      previous,
      checkpoint: async () => undefined,
    };
    return { ctx, logs };
  };
  const session = (): StoreSession => ({
    accountName: "PlayerOne",
    data: { signedInAt: 1 },
  });

  // A page of synthetic games, bought on EA.
  const syntheticPage = (ids: string[], next: string | null) => ({
    data: {
      me: {
        ownedGameProducts: {
          next,
          items: ids.map((id) => ({
            id,
            originOfferId: id,
            product: {
              name: `Game ${id}`,
              isUngatedTrial: false,
              gameProductUser: {
                ownershipMethods: ["PURCHASE", "ENTITLEMENT_GRANT"],
                gameProductUserTrial: null,
              },
            },
          })),
        },
      },
    },
  });

  const registered = storeClient("ea");
  beforeAll(() => registerStoreClient(ea.eaClient));
  beforeEach(() => {
    signedIn = true;
    tokenDown = false;
    catalogDown = false;
    issued = 0;
    validToken = "";
    pageFor = defaultPages;
    contentIdOf = (id) => offers.find((o) => o.offerId === id)?.contentId;
    host.requests.length = 0;
    host.logs.length = 0;
    setStoreHost(host);
  });
  afterEach(() => refresh.deleteAccount("ea"));
  afterAll(() => {
    if (registered) {
      registerStoreClient(registered);
    } else {
      unregisterStoreClient("ea");
    }
    setStoreHost(readOnlyStoreHost);
  });

  it("signs in from the window's cookies and lists the games", async () => {
    expect(await signIn()).toBe("PlayerOne");
    // The cookies stay in EA's partition: none of them is saved.
    const saved = storage.loadSession("ea", host)!.session;
    expect(Object.keys(saved.data)).toEqual(["signedInAt"]);
    const onDisk = fs.readFileSync(storage.sessionFile("ea"), "utf8");
    for (const value of ["sid-value", "remid-value", "site-value"]) {
      expect(onDisk).not.toContain(value);
      expect(JSON.stringify(saved)).not.toContain(value);
    }

    host.requests.length = 0;
    const library = await refresh.refreshLibrary("ea");
    expect(library.accountName).toBe("PlayerOne");
    expect(library.partial).toBe(false);
    // A Way Out is only owned through Steam.
    expect(
      library.games.map((g) => [g.id, g.title, g.extra.content_id]),
    ).toEqual([
      ["DR:225064100", "Battlefield 3", "70619"],
      ["OFB-EAST:52735", "Zuma's Revenge", "1002139"],
      ["OFB-EAST:57289", "Crysis", "1003310"],
    ]);

    // Everything goes through EA's partition (the host's fetch for "ea").
    expect(host.requests.every((r) => r.store === "ea")).toBe(true);
    // A fresh token every refresh, from the cookies alone.
    expect(tokenRequests().map((r) => r.url)).toEqual([ea.TOKEN_URL]);
    expect(tokenRequests()[0].init.headers).toMatchObject({
      Accept: "application/json",
      "User-Agent": BROWSER_USER_AGENT,
    });
    expect(tokenRequests()[0].init.headers?.Authorization).toBeUndefined();
    // Two pages with the refresh's own token (the sign-in's was token-1);
    // the cursor of the first asks for the second.
    expect(
      libraryRequests().map((r) => [
        JSON.parse(queryParam(r.url, "variables")!).next,
        r.init.headers?.Authorization,
      ]),
    ).toEqual([
      ["0", "Bearer token-2"],
      ["Mw==", "Bearer token-2"],
    ]);
    // The catalog is asked without a token, for every offer at once.
    expect(catalogRequests()).toHaveLength(1);
    expect(catalogRequests()[0].init.headers?.Authorization).toBeUndefined();
    expect(
      JSON.parse(catalogRequests()[0].init.body!).variables.offerIds,
    ).toEqual(["DR:225064100", "OFB-EAST:57289", "OFB-EAST:52735"]);
    // The name was known: it isn't asked for again.
    expect(
      host.requests.filter((r) => r.init.body === ea.PLAYER_NAME_BODY),
    ).toHaveLength(0);
  });

  it("the content id is the one the EA app's installer data and install link use", async () => {
    await signIn();
    const library = await refresh.refreshLibrary("ea");
    const game = (id: string) => library.games.find((g) => g.id === id)!;

    // Battlefield 3 is installed: its installer data lists its content id
    // (and another one).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "srm-ea-"));
    try {
      const folder = path.join(root, "Battlefield 3");
      fs.mkdirSync(path.join(folder, "__Installer"), { recursive: true });
      fs.writeFileSync(
        path.join(folder, "__Installer", "installerdata.xml"),
        `<?xml version="1.0" encoding="utf-8"?>
<DiPManifest version="4.0">
  <gameTitles><gameTitle locale="en_US">Battlefield 3</gameTitle></gameTitles>
  <contentIDs><contentID>70618</contentID><contentID>70619</contentID></contentIDs>
</DiPManifest>`,
      );
      const installed = await eaInstalled([folder]);
      const kept = gamesToAdd(
        library.games,
        {
          sameStoreIds: new Set(installed.map((g) => g.id)),
          titles: new Set(),
        },
        new Set(),
        {
          skipPrereleases: false,
          skipInstalledElsewhere: false,
          skipSteamInstalled: false,
        },
      );
      expect(kept.map((g) => g.id)).toEqual([
        "OFB-EAST:52735",
        "OFB-EAST:57289",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(eaInstallLink(game("OFB-EAST:52735"))).toBe(
      "origin2://game/launch/?offerIds=1002139",
    );
    // Without a content id, the offer id.
    expect(eaInstallLink(ownedGame("ea", "OFB-EAST:1", "No Content Id"))).toBe(
      "origin2://game/launch/?offerIds=OFB-EAST:1",
    );
  });

  it("asks for the name when it isn't known yet", async () => {
    const { ctx } = listContext();
    const unnamed: StoreSession = {
      accountName: null,
      data: { signedInAt: 1 },
    };
    await ea.eaClient.listLibrary(unnamed, ctx);
    expect(unnamed.accountName).toBe("PlayerOne");
    const nameRequest = host.requests.find(
      (r) => r.init.body === ea.PLAYER_NAME_BODY,
    );
    expect(nameRequest?.init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      },
    });
  });

  it("a name EA doesn't hand out fails neither the sign-in nor the list", async () => {
    const base = handler;
    host.handler = (request) =>
      request.init.body === ea.PLAYER_NAME_BODY
        ? { status: 500, body: "<html>oops</html>" }
        : base(request);
    try {
      expect(await signIn()).toBeNull();
      const library = await refresh.refreshLibrary("ea");
      expect(library.games).toHaveLength(3);
      expect(library.accountName).toBeNull();
    } finally {
      host.handler = handler;
    }
  });

  it("a sign-in the window didn't hand over isn't kept", async () => {
    const pending = refresh.pendingLogin("ea");
    const finalUrl = "https://www.ea.com/login_check?code=QUOx";
    await expect(
      refresh.completeLogin(pending, { finalUrl, cookies: [] }),
    ).rejects.toThrow("handed over no cookies for accounts.ea.com");
    await expect(
      refresh.completeLogin(pending, {
        finalUrl,
        cookies: [cookie("shop", "w", "www.ea.com")],
      }),
    ).rejects.toThrow("handed over no cookies");
    await expect(
      refresh.completeLogin(pending, { pasted: "sid=abc" }),
    ).rejects.toThrow("sign-in window");
    // EA doesn't take the cookies.
    signedIn = false;
    const refused = await refresh
      .completeLogin(pending, {
        finalUrl,
        cookies: WINDOW_COOKIES,
      })
      .catch((e) => e);
    expect(refused.message).toContain("Signing in to EA did not finish");
    expect(isLoginRejected(refused)).toBe(true);
    expect(storage.readSessionInfo("ea")).toBeNull();
  });

  it("an unreadable session asks to sign in again", async () => {
    // (BoilR's shape: the cookies themselves)
    storage.saveSession(
      "ea",
      { accountName: null, data: { cookies: [] } },
      host,
    );
    await expect(refresh.refreshLibrary("ea")).rejects.toSatisfy(
      (err: Error) =>
        isLoginRejected(err) && err.message.includes("Sign in again"),
    );
    expect(host.requests).toEqual([]);
  });

  it("cookies EA no longer takes ask to sign in again", async () => {
    await signIn();
    signedIn = false;
    const err = await refresh.refreshLibrary("ea").catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    expect(err.message).toContain("Could not renew the EA sign-in");
    expect(err.message).toContain("login_required");
    const status = refresh.accountStatus("ea");
    expect(status.needsSignIn).toBe(true);
    expect(status.lastError).toContain("Sign in again");
  });

  it("a token EA turns down for the list asks to sign in again", async () => {
    await signIn();
    const base = handler;
    host.handler = (request) =>
      request.url.includes("getPreloadedOwnedGames")
        ? { status: 401, body: NOT_AUTHENTICATED }
        : base(request);
    try {
      const err = await refresh.refreshLibrary("ea").catch((e) => e);
      expect(isLoginRejected(err)).toBe(true);
      expect(err.message).toContain("Could not load the EA library");
      expect(refresh.accountStatus("ea").needsSignIn).toBe(true);
    } finally {
      host.handler = handler;
    }
  });

  it("an outage is no reason to sign in again", async () => {
    await signIn();
    tokenDown = true;
    const token = await refresh.refreshLibrary("ea").catch((e) => e);
    expect(isTransient(token) && !isLoginRejected(token)).toBe(true);
    expect(refresh.accountStatus("ea").needsSignIn).toBe(false);

    tokenDown = false;
    pageFor = (cursor) =>
      cursor === ea.FIRST_PAGE
        ? PAGE_1
        : {
            status: 502,
            body: '{"errors":[{"message":"upstream timed out"}],"data":null}',
          };
    const page = await refresh.refreshLibrary("ea").catch((e) => e);
    expect(isTransient(page) && !isLoginRejected(page)).toBe(true);
    expect(page.message).toContain("502 Bad Gateway");
    // Nothing was saved from the first page alone.
    expect(refresh.cachedLibrary("ea")).toBeNull();
  });

  it("a query EA no longer knows asks for an update", async () => {
    await signIn();
    pageFor = () => ({
      status: 200,
      body: {
        errors: [
          {
            message: "PersistedQueryNotFound",
            extensions: { code: "PERSISTED_QUERY_NOT_FOUND" },
          },
        ],
      },
    });
    const err = await refresh.refreshLibrary("ea").catch((e) => e);
    expect(err.message).toContain("SRM needs an update");
    expect(isLoginRejected(err) || isTransient(err)).toBe(false);
    expect(refresh.accountStatus("ea").needsSignIn).toBe(false);
  });

  it("a failed catalog lookup keeps the content ids from before", async () => {
    await signIn();
    await refresh.refreshLibrary("ea");
    catalogDown = true;
    const again = await refresh.refreshLibrary("ea");
    // Every game had one before: the list is whole.
    expect(again.partial).toBe(false);
    expect(again.games.map((g) => g.extra.content_id)).toEqual([
      "70619",
      "1002139",
      "1003310",
    ]);
    expect(host.logs.join("\n")).toContain(
      "Could not look up EA content ids, using the ones from before",
    );

    // Without a list from before, the games are listed without content ids,
    // and the list is partial (fetched again sooner).
    const { ctx, logs } = listContext();
    const first = await ea.eaClient.listLibrary(session(), ctx);
    expect(first.partial).toBe(true);
    expect(first.games.map((g) => g.extra)).toEqual([{}, {}, {}]);
    expect(logs.join("\n")).toContain("503");
  });

  it("looks content ids up 100 offers at a time, and stops at the first failed batch", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `OFB-EAST:${i + 1}`);
    pageFor = (cursor) =>
      cursor === ea.FIRST_PAGE
        ? syntheticPage(ids.slice(0, 200), "next")
        : syntheticPage(ids.slice(200), null);
    contentIdOf = (id) => `c-${id}`;

    const { ctx } = listContext();
    const listed = await ea.eaClient.listLibrary(session(), ctx);
    expect(listed.games).toHaveLength(250);
    expect(listed.partial).toBe(false);
    expect(listed.games[249].extra.content_id).toBe("c-OFB-EAST:250");
    expect(
      catalogRequests().map(
        (r) => JSON.parse(r.init.body!).variables.offerIds.length,
      ),
    ).toEqual([100, 100, 50]);

    // The second batch fails: the third isn't asked for, and the games of
    // the first keep their ids.
    host.requests.length = 0;
    let batch = 0;
    const base = handler;
    host.handler = (request) =>
      (request.init.body ?? "").includes("getLegacyCatalogDefs") &&
      ++batch === 2
        ? { status: 500, body: "" }
        : base(request);
    try {
      const { ctx: again } = listContext();
      const partial = await ea.eaClient.listLibrary(session(), again);
      expect(catalogRequests()).toHaveLength(2);
      expect(partial.partial).toBe(true);
      expect(
        partial.games.filter((g) => g.extra.content_id).map((g) => g.id),
      ).toEqual(ids.slice(0, 100));
    } finally {
      host.handler = handler;
    }
  });

  it("a page that comes back, or pages without end, are no list", async () => {
    // The second page sends its own cursor again.
    pageFor = (cursor) => syntheticPage([`OFB-EAST:${cursor}`], "A");
    const { ctx } = listContext();
    await expect(ea.eaClient.listLibrary(session(), ctx)).rejects.toThrow(
      "sent the same page twice",
    );

    host.requests.length = 0;
    pageFor = (cursor) =>
      syntheticPage([`OFB-EAST:${cursor}`], `${Number(cursor) + 1}`);
    const { ctx: endless } = listContext();
    await expect(ea.eaClient.listLibrary(session(), endless)).rejects.toThrow(
      `kept sending more pages after ${ea.MAX_PAGES}`,
    );
    expect(libraryRequests()).toHaveLength(ea.MAX_PAGES);
    // (no catalog lookup for a list that isn't one)
    expect(catalogRequests()).toHaveLength(0);
  });

  it("the token never shows in what's saved or reported", async () => {
    await signIn();
    // A failure that echoes the request back.
    pageFor = () => ({
      status: 500,
      body: {
        message: "upstream failed",
        access_token: "token-2",
        headers: { Authorization: "Bearer token-2" },
      },
    });
    await refresh.refreshLibrary("ea").catch(() => undefined);
    const status = refresh.accountStatus("ea");
    expect(status.lastError).toContain("500 Internal Server Error");
    expect(status.lastError).toContain("upstream failed");
    expect(status.lastError).not.toContain("token-2");
    expect(JSON.stringify(storage.loadSession("ea", host))).not.toContain(
      "token-",
    );
  });
});
