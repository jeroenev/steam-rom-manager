// Amazon Games accounts (ported from BoilR's amazon.rs tests, plus a
// sign-in, refreshes and a sign-out against a fake Amazon).
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import * as amazon from "../../src/lib/stores/amazon";
import {
  StoreFetch,
  StoreRequestInit,
  readOnlyStoreHost,
  setStoreHost,
} from "../../src/lib/stores/host";
import {
  HttpStatus,
  StoreHttp,
  isLoginRejected,
  isTransient,
  queryParam,
  redact,
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
  LoginCapture,
  OwnedLibrary,
  StoreSession,
  ownedGame,
} from "../../src/lib/stores/types";
import {
  FakeAnswer,
  FakeStoreHost,
  storeFixture,
} from "../helpers/fake-store-host";

const REGISTER_SUCCESS = storeFixture("amazon", "register_success.json");
const REGISTER_ERROR = storeFixture("amazon", "register_error.json");
const REFRESH = storeFixture("amazon", "refresh.json");
const PAGE_1 = storeFixture("amazon", "entitlements_page1.json");
const PAGE_2 = storeFixture("amazon", "entitlements_page2.json");

const SERIAL = "0123456789ABCDEF0123456789ABCDEF";
const state = (): amazon.LoginState => ({
  codeVerifier: "verifier",
  deviceSerial: SERIAL,
  clientId: amazon.clientId(SERIAL),
});

const captureUrl = (url: string): LoginCapture => ({ finalUrl: url });
const capturePaste = (text: string): LoginCapture => ({ pasted: text });

// An error body as Amazon's services send it.
const exception = (name: string) =>
  `{"__type":"com.amazon.coral.service#${name}","message":"Invalid token"}`;

const status = (code: number) =>
  new HttpStatus(code, amazon.TOKEN_URL, '{"error":"invalid_grant"}');

const errorOf = (work: () => unknown): Error => {
  try {
    work();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected an error");
};

describe("Amazon", () => {
  it("PKCE matches RFC 7636's example", () => {
    // RFC 7636 appendix B.
    const bytes = Buffer.from([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187,
      186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141,
      121,
    ]);
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(amazon.codeVerifierFromBytes(bytes)).toBe(verifier);
    expect(amazon.codeChallenge(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("a login's state has the expected shape", () => {
    const login = amazon.newLoginState();
    expect(login.codeVerifier).toHaveLength(43);
    expect(login.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(login.deviceSerial).toMatch(/^[0-9A-F]{32}$/);
    expect(login.clientId).toBe(amazon.clientId(login.deviceSerial));
    const challenge = amazon.codeChallenge(login.codeVerifier);
    expect(challenge).toHaveLength(43);
    expect(challenge).not.toContain("=");
    expect(amazon.newLoginState()).not.toEqual(login);
    // 16 bytes of serial, 32 of verifier.
    const fixed = amazon.newLoginState((size) => Buffer.alloc(size, 0xab));
    expect(fixed.deviceSerial).toBe("AB".repeat(16));
    expect(fixed.codeVerifier).toBe(
      amazon.codeVerifierFromBytes(Buffer.alloc(32, 0xab)),
    );
  });

  it("the client id is hex of the serial and the device type", () => {
    // Playnite's fixed client id decodes to this serial.
    expect(amazon.clientId("73db8d286c2a924d2e77e1af67766645")).toBe(
      "3733646238643238366332613932346432653737653161663637373636363435234132554d56484f58375550345637",
    );
  });

  it("the hardware hash is upper-case hex SHA-256", () => {
    expect(amazon.hardwareHash("abc")).toBe(
      "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
    );
  });

  it("the sign-in URL carries the client and the challenge", () => {
    const pending = amazon.beginLogin();
    const login = amazon.loginState(pending);
    const url = pending.startUrl;
    expect(url.startsWith("https://www.amazon.com/ap/signin?")).toBe(true);
    const param = (name: string) => queryParam(url, name);
    expect(param("openid.oa2.client_id")).toBe(`device:${login.clientId}`);
    expect(param("openid.oa2.code_challenge")).toBe(
      amazon.codeChallenge(login.codeVerifier),
    );
    expect(param("openid.oa2.code_challenge_method")).toBe("S256");
    expect(param("openid.assoc_handle")).toBe("amzn_sonic_games_launcher");
    // The rest of what the Amazon Games app asks for.
    expect(param("openid.ns")).toBe("http://specs.openid.net/auth/2.0");
    for (const name of ["openid.claimed_id", "openid.identity"]) {
      expect(param(name)).toBe(
        "http://specs.openid.net/auth/2.0/identifier_select",
      );
    }
    expect(param("openid.mode")).toBe("checkid_setup");
    expect(param("openid.oa2.scope")).toBe("device_auth_access");
    expect(param("openid.ns.oa2")).toBe("http://www.amazon.com/ap/ext/oauth/2");
    expect(param("openid.oa2.response_type")).toBe("code");
    expect(param("language")).toBe("en_US");
    expect(param("marketPlaceId")).toBe("ATVPDKIKX0DER");
    expect(param("openid.return_to")).toBe("https://www.amazon.com");
    expect(param("openid.pape.max_auth_age")).toBe("0");
    expect(param("pageId")).toBe("amzn_sonic_games_launcher");
    // The link to open in the browser is the same login's.
    expect(pending.manual).toMatchObject({ kind: "paste", url });
    // The sign-in window looks like the Amazon Games app's.
    expect(pending.userAgent).toContain("@amzn/aga-electron-platform");
    expect(pending.pageTextUrlPrefixes).toEqual([]);
    expect(pending.cookieUrls).toEqual([]);
  });

  it("done prefixes match only the final redirect", () => {
    const pending = amazon.beginLogin();
    const matches = (url: string) =>
      pending.doneUrlPrefixes.some((prefix) => url.startsWith(prefix));
    expect(matches(pending.startUrl)).toBe(false);
    for (const url of [
      "https://www.amazon.com/ap/signin?openid.ns=x",
      "https://www.amazon.com/ap/mfa?arb=x",
      "https://www.amazon.com/ap/cvf/request?arb=x",
      "https://www.amazon.com/",
      "https://www.amazon.com/gp/help/customer/display.html?nodeId=1",
      "https://www.amazon.com.example/?openid.mode=id_res",
    ]) {
      expect(matches(url), url).toBe(false);
    }
    for (const url of [
      "https://www.amazon.com/?openid.assoc_handle=amzn_sonic_games_launcher&openid.oa2.authorization_code=ANabc",
      // Whichever parameter Amazon puts first.
      "https://www.amazon.com/?ref_=nav_signin&openid.oa2.authorization_code=ANabc",
      "https://amazon.com/?language=en_US&openid.oa2.authorization_code=ANabc",
    ]) {
      expect(matches(url), url).toBe(true);
    }
    // Each login has a list of its own.
    pending.doneUrlPrefixes.push("https://example.invalid/");
    expect(amazon.beginLogin().doneUrlPrefixes).toEqual(amazon.DONE_PREFIXES);
  });

  it("reads the code from the redirect", () => {
    const url =
      "https://www.amazon.com/?openid.assoc_handle=amzn_sonic_games_launcher&openid.mode=id_res&openid.oa2.authorization_code=ANcodeXYZ&openid.ns=x";
    expect(amazon.authorizationCode(captureUrl(url))).toBe("ANcodeXYZ");
    expect(amazon.authorizationCode(capturePaste(`  ${url}\n`))).toBe(
      "ANcodeXYZ",
    );
    // The code is found wherever it is in the query.
    expect(
      amazon.authorizationCode(
        captureUrl(
          "https://www.amazon.com/?ref_=nav&openid.oa2.authorization_code=ANcodeXYZ#top",
        ),
      ),
    ).toBe("ANcodeXYZ");
  });

  it("reads the code from a pasted address without its scheme", () => {
    // Browsers hide the scheme in the address bar, and some copy the address
    // without it.
    for (const pasted of [
      "www.amazon.com/?openid.mode=id_res&openid.oa2.authorization_code=ANcodeXYZ",
      "amazon.com/?openid.oa2.authorization_code=ANcodeXYZ&openid.ns=x",
      "?openid.mode=id_res&openid.oa2.authorization_code=ANcodeXYZ",
      "openid.mode=id_res&openid.oa2.authorization_code=ANcodeXYZ",
    ]) {
      expect(amazon.authorizationCode(capturePaste(pasted)), pasted).toBe(
        "ANcodeXYZ",
      );
    }
  });

  it("a bare value is a code only when it looks like one", () => {
    // The length and shape of the codes in Amazon's examples.
    const code = "ANdNAVhyhqirUelHGEHA";
    expect(amazon.authorizationCode(capturePaste(code))).toBe(code);
    expect(amazon.authorizationCode(capturePaste(` ${code}\n`))).toBe(code);
    expect(amazon.looksLikeCode("AN-dNAVhy_hqir")).toBe(true);

    for (const notACode of [
      // An address without its query, with or without its scheme.
      "www.amazon.com/",
      "www.amazon.com",
      "amazon.com",
      "https://www.amazon.com/",
      "https://www.amazon.com/ap/signin",
      // Too short, or with characters no code has.
      "ANcode",
      "not a code at all",
      "ANdNAVhy|hqirUelHGEHA",
      "ANdNAVhy/hqirUelHGEHA",
      "ANdNAVhy.hqirUelHGEHA",
    ]) {
      expect(
        () => amazon.authorizationCode(capturePaste(notACode)),
        notACode,
      ).toThrow("paste the full address");
    }
  });

  it("rejects redirects without a code", () => {
    expect(() =>
      amazon.authorizationCode(
        captureUrl("https://www.amazon.com/?openid.mode=cancel"),
      ),
    ).toThrow(/^The Amazon sign-in was cancelled\.$/);
    expect(() =>
      amazon.authorizationCode(
        captureUrl("https://www.amazon.com/?openid.mode=id_res"),
      ),
    ).toThrow("no Amazon sign-in code");
    expect(() =>
      amazon.authorizationCode(
        capturePaste(
          "www.amazon.com/?openid.oa2.authorization_code=&openid.mode=id_res",
        ),
      ),
    ).toThrow("no Amazon sign-in code");
    expect(() => amazon.authorizationCode({})).toThrow();
    expect(() => amazon.authorizationCode(capturePaste("   "))).toThrow();
  });

  it("a login that lost its state can't be finished", () => {
    const pending = amazon.beginLogin();
    expect(amazon.loginState(pending)).toEqual(pending.state);
    for (const lost of [
      {},
      { ...pending.state, codeVerifier: "" },
      { ...pending.state, deviceSerial: 5 },
      { codeVerifier: "v", deviceSerial: "S" },
    ]) {
      expect(() => amazon.loginState({ ...pending, state: lost })).toThrow(
        "Start the sign-in again",
      );
    }
  });

  it("the register request has the launcher's shape", () => {
    const login = state();
    expect(
      JSON.parse(JSON.stringify(amazon.registerRequest("ANcode", login))),
    ).toEqual({
      auth_data: {
        authorization_code: "ANcode",
        client_domain: "DeviceLegacy",
        client_id: login.clientId,
        code_algorithm: "SHA-256",
        code_verifier: "verifier",
        use_global_authentication: false,
      },
      registration_data: {
        app_name: "AGSLauncher for Windows",
        app_version: "1.0.0",
        device_model: "Windows",
        device_name: null,
        device_serial: SERIAL,
        device_type: "A2UMVHOX7UP4V7",
        domain: "Device",
        os_version: "10.0.19044.0",
      },
      requested_extensions: ["customer_info", "device_info"],
      requested_token_type: ["bearer", "mac_dms"],
      user_context_map: {},
    });
  });

  it("parses a device registration", () => {
    const { session, accountName } = amazon.sessionFromRegistration(
      JSON.parse(REGISTER_SUCCESS),
      state(),
      1_000_000,
    );
    expect(accountName).toBe("Jane Player");
    expect(session).toEqual({
      accessToken: "Atna|access",
      refreshToken: "Atnr|refresh",
      // (expires_in came as text)
      expiresAt: 4_600_000,
      deviceSerial: "SERIALFROMAMAZON",
    });
    expect(amazon.needsRefresh(session, 1_000_000)).toBe(false);
    expect(amazon.needsRefresh(session, 4_500_000)).toBe(true);

    // The given name when there is no name; the login's serial when Amazon
    // doesn't name one; no expiry: renewed on every refresh.
    const sparse = amazon.sessionFromRegistration(
      {
        response: {
          success: {
            extensions: { customer_info: { name: " ", given_name: "Jane" } },
            tokens: { bearer: { access_token: "a", refresh_token: "r" } },
          },
        },
      },
      state(),
      1_000_000,
    );
    expect(sparse.accountName).toBe("Jane");
    expect(sparse.session.deviceSerial).toBe(SERIAL);
    expect(sparse.session.expiresAt).toBe(0);
    expect(amazon.needsRefresh(sparse.session, 1_000_000)).toBe(true);
    const numeric = amazon.sessionFromRegistration(
      {
        response: {
          success: {
            tokens: {
              bearer: { access_token: "a", refresh_token: "r", expires_in: 60 },
            },
          },
        },
      },
      state(),
      1_000,
    );
    expect(numeric.accountName).toBeNull();
    expect(numeric.session.expiresAt).toBe(61_000);
  });

  it("reports a refused registration", () => {
    const refused = errorOf(() =>
      amazon.sessionFromRegistration(JSON.parse(REGISTER_ERROR), state(), 0),
    );
    expect(refused.message).toContain("Authorization code is invalid");
    expect(refused.message).toContain("InvalidValue");
    expect(
      errorOf(() => amazon.sessionFromRegistration({}, state(), 0)).message,
    ).toContain("returned no response");
    expect(
      errorOf(() =>
        amazon.sessionFromRegistration({ response: {} }, state(), 0),
      ).message,
    ).toContain("neither tokens nor an error");
    // Tokens missing or empty: no sign-in, and nothing of the answer shown.
    for (const bearer of [
      { access_token: "", refresh_token: "SECRET" },
      { access_token: "SECRET" },
      {},
    ]) {
      const empty = errorOf(() =>
        amazon.sessionFromRegistration(
          { response: { success: { tokens: { bearer } } } },
          state(),
          0,
        ),
      );
      expect(empty.message).toContain("returned no tokens");
      expect(empty.message).not.toContain("SECRET");
    }
  });

  it("applies a token refresh", () => {
    const { session } = amazon.sessionFromRegistration(
      JSON.parse(REGISTER_SUCCESS),
      state(),
      0,
    );
    const renewed = amazon.applyRefresh(
      session,
      JSON.parse(REFRESH),
      10_000_000,
    );
    expect(renewed).toEqual({
      ...session,
      accessToken: "Atna|fresh",
      // (Amazon keeps the refresh token)
      refreshToken: "Atnr|refresh",
      expiresAt: 13_600_000,
    });
    expect(amazon.refreshRequest("Atnr|refresh")).toEqual({
      source_token: "Atnr|refresh",
      source_token_type: "refresh_token",
      requested_token_type: "access_token",
      app_name: "AGSLauncher for Windows",
      app_version: "1.0.0",
    });

    const refused = errorOf(() =>
      amazon.applyRefresh(
        renewed,
        {
          error: "invalid_grant",
          error_description: "The request has an invalid grant parameter",
        },
        0,
      ),
    );
    expect(isLoginRejected(refused)).toBe(true);
    expect(refused.message).toContain("invalid grant");
    expect(
      isLoginRejected(
        errorOf(() =>
          amazon.applyRefresh(renewed, { error: "invalid_grant" }, 0),
        ),
      ),
    ).toBe(true);

    // An answer with neither a token nor a refusal is no reason to sign in
    // again.
    for (const body of [
      "{}",
      '{"access_token":""}',
      '{"token_type":"bearer"}',
      "null",
    ]) {
      const odd = errorOf(() =>
        amazon.applyRefresh(renewed, JSON.parse(body), 0),
      );
      expect(isLoginRejected(odd), body).toBe(false);
      expect(odd.message, body).toContain("Unexpected answer");
    }
    expect(renewed.accessToken).toBe("Atna|fresh");
  });

  it("only a refused refresh token is a refused login", () => {
    expect(amazon.refreshWasRefused(400)).toBe(true);
    expect(amazon.refreshWasRefused(401)).toBe(true);
    for (const other of [403, 404, 408, 429, 500, 502, 503]) {
      expect(amazon.refreshWasRefused(other), String(other)).toBe(false);
    }
    expect(amazon.refreshWasRefused(undefined)).toBe(false);

    for (const refused of [400, 401]) {
      const err = amazon.refreshFailure(status(refused));
      expect(isLoginRejected(err)).toBe(true);
      expect(err.message).toContain("Sign in again");
    }
    // An outage stays an outage, with the status still there to read.
    const outage = amazon.refreshFailure(status(503));
    expect(isTransient(outage) && !isLoginRejected(outage)).toBe(true);
    expect(statusOf(outage)).toBe(503);
    expect(outage.message).toContain("Could not refresh the Amazon login");
    const offline = amazon.refreshFailure(transient("no connection"));
    expect(isTransient(offline) && !isLoginRejected(offline)).toBe(true);
    const blocked = amazon.refreshFailure(status(403));
    expect(isLoginRejected(blocked) || isTransient(blocked)).toBe(false);
  });

  it("a refused token is told from other failures", () => {
    // 401 is a refused token whatever the body.
    expect(amazon.loginWasRefused(401, "")).toBe(true);
    expect(amazon.loginWasRefused(401, "<html>Unauthorized</html>")).toBe(true);
    // Amazon's services answer a bad or expired token with 400 or 403 and
    // name why.
    for (const name of amazon.AUTH_EXCEPTIONS) {
      for (const code of [400, 403]) {
        expect(
          amazon.loginWasRefused(code, exception(name)),
          `${code} ${name}`,
        ).toBe(true);
      }
    }
    // The exception can be named without its namespace, in any case, or in
    // the message.
    expect(
      amazon.loginWasRefused(400, '{"__type":"ExpiredTokenException"}'),
    ).toBe(true);
    expect(
      amazon.loginWasRefused(403, '{"__type":"x#accessdeniedexception"}'),
    ).toBe(true);
    expect(
      amazon.loginWasRefused(
        400,
        '{"message":"com.amazon.coral.service#InvalidTokenException"}',
      ),
    ).toBe(true);
    expect(
      amazon.loginWasRefused(
        403,
        '{"Message":"NotAuthorizedException: token expired"}',
      ),
    ).toBe(true);

    // Other errors of the service are not about the login.
    expect(amazon.loginWasRefused(400, exception("ValidationException"))).toBe(
      false,
    );
    expect(amazon.loginWasRefused(400, exception("ThrottlingException"))).toBe(
      false,
    );
    expect(amazon.loginWasRefused(403, '{"message":"Forbidden"}')).toBe(false);
    // A bot block, a captive portal or an empty answer is not either.
    expect(amazon.loginWasRefused(403, "<html>Request blocked</html>")).toBe(
      false,
    );
    expect(amazon.loginWasRefused(403, "")).toBe(false);
    expect(amazon.loginWasRefused(400, '{"__type": 3}')).toBe(false);
    expect(amazon.loginWasRefused(400, '["UnrecognizedClientException"]')).toBe(
      false,
    );
    // No other status is, whatever the body says.
    const named = exception("UnrecognizedClientException");
    for (const other of [200, 404, 408, 429, 500, 502, 503]) {
      expect(amazon.loginWasRefused(other, named), String(other)).toBe(false);
    }
  });

  it("a refused token fails the entitlements call as a refused login", () => {
    const failure = (code: number, body: string) =>
      amazon.entitlementsFailure(code, amazon.ENTITLEMENTS_URL, body);
    // These make the token be renewed once and the request tried again.
    for (const code of [400, 401, 403]) {
      const err = failure(code, exception("UnrecognizedClientException"));
      expect(isLoginRejected(err), String(code)).toBe(true);
      expect(err.message).toContain("Sign in again");
      expect(err.message).toContain(amazon.ENTITLEMENTS_URL);
      expect(statusOf(err)).toBe(code);
    }
    expect(isLoginRejected(failure(401, ""))).toBe(true);

    // These don't, and keep their status.
    const blocked = failure(403, "<html>Request blocked</html>");
    expect(isLoginRejected(blocked) || isTransient(blocked)).toBe(false);
    expect(statusOf(blocked)).toBe(403);
    expect(
      isLoginRejected(failure(400, exception("ValidationException"))),
    ).toBe(false);
    for (const outage of [429, 500, 503]) {
      const err = failure(outage, exception("UnrecognizedClientException"));
      expect(isTransient(err) && !isLoginRejected(err), String(outage)).toBe(
        true,
      );
    }
    // The body in the message has its secrets taken out.
    const leaky = failure(
      403,
      '{"__type":"AccessDeniedException","message":"denied","token":"SECRET"}',
    );
    expect(isLoginRejected(leaky)).toBe(true);
    expect(leaky.message).not.toContain("SECRET");
  });

  it("a refused token is told by its status when its body can't be read", async () => {
    // Every answer is 401 with a body that breaks off.
    const asked: string[] = [];
    const fetch: StoreFetch = async (url) => {
      asked.push(url);
      return {
        status: 401,
        ok: false,
        url,
        headers: { get: () => null },
        text: async () => {
          throw new Error("The answer was cut off");
        },
      };
    };
    const ctx: ListContext = {
      http: new StoreHttp(fetch),
      now: () => 0,
      log: () => undefined,
      previous: [],
      checkpoint: async () => undefined,
    };
    const session: StoreSession = {
      accountName: null,
      data: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 3600 * 1000,
        deviceSerial: SERIAL,
      } satisfies amazon.AmazonSession,
    };
    const err = await amazon.amazonClient
      .listLibrary(session, ctx)
      .catch((e) => e);
    // A refused login (renewed once, then refused too), not a network
    // problem.
    expect(isLoginRejected(err)).toBe(true);
    expect(isTransient(err)).toBe(false);
    expect(asked).toEqual([amazon.ENTITLEMENTS_URL, amazon.TOKEN_URL]);
  });

  it("the entitlements request has the launcher's shape", () => {
    expect(
      JSON.parse(JSON.stringify(amazon.entitlementsRequest("HASH", "next"))),
    ).toEqual({
      Operation: "GetEntitlements",
      clientId: "Sonic",
      syncPoint: null,
      nextToken: "next",
      maxResults: 50,
      productIdFilter: null,
      keyId: "d5dc8b8b-86c8-4fc4-ae93-18c0def5314d",
      hardwareHash: "HASH",
    });
    // The first page has no token, and says so.
    expect(
      JSON.parse(JSON.stringify(amazon.entitlementsRequest("HASH", null))),
    ).toMatchObject({ nextToken: null });
  });

  it("parses entitlement pages into games", () => {
    const first = amazon.entitlementsPage(JSON.parse(PAGE_1));
    const second = amazon.entitlementsPage(JSON.parse(PAGE_2));
    expect(first.nextToken).toBe("page-2-token");
    expect(second.nextToken).toBeNull();

    const games = amazon.ownedGames([
      ...first.entitlements,
      ...second.entitlements,
    ]);
    // Loot, a product without a title and an entitlement without a product
    // are skipped; a product listed twice is kept once.
    expect(games.map((g) => g.id)).toEqual([
      "amzn1.adg.product.11111111-1111-1111-1111-111111111111",
      "amzn1.adg.product.33333333-3333-3333-3333-333333333333",
    ]);
    const [fallout, other] = games;
    expect(fallout.store).toBe("amazon");
    expect(fallout.title).toBe("Fallout: New Vegas Ultimate Edition");
    expect(fallout.extra).toEqual({
      entitlement_id: "aaaaaaaa-0000-0000-0000-000000000001",
      sku: "FNV_SKU",
      icon_url: "https://example.invalid/fnv-icon.jpg",
    });
    expect(other.title).toBe("Second Game");
    // (an empty SKU is none)
    expect(other.extra).toEqual({
      entitlement_id: "aaaaaaaa-0000-0000-0000-000000000005",
    });
  });

  it("titles lose trademark signs and extra spaces", () => {
    const games = amazon.ownedGames(
      amazon.entitlementsPage(
        JSON.parse(`{"entitlements":[
          {"id":"e1","product":{"id":"p1","title":"  STAR WARS\\u2122  Battlefront\\u00ae "}},
          {"id":"e2","product":{"id":"p2","title":" \\u2122 "}}
        ]}`),
      ).entitlements,
    );
    // A title that's only a sign is no title.
    expect(games.map((g) => g.title)).toEqual(["STAR WARS Battlefront"]);
  });

  it("reports an entitlements error", () => {
    // Amazon names an auth exception: the login was refused.
    const refused = errorOf(() =>
      amazon.entitlementsPage(
        JSON.parse(exception("UnrecognizedClientException")),
      ),
    );
    expect(isLoginRejected(refused)).toBe(true);
    expect(refused.message).toContain(
      "UnrecognizedClientException: Invalid token",
    );

    // Any other answer without the list is an error that isn't about the
    // login.
    for (const body of [
      '{"__type":"com.amazon.coral.service#InternalFailure","message":"Try again"}',
      '{"message":"Service unavailable"}',
      "{}",
      '{"entitlements":null}',
    ]) {
      const err = errorOf(() => amazon.entitlementsPage(JSON.parse(body)));
      expect(isLoginRejected(err), body).toBe(false);
      expect(err.message, body).toContain("did not send the list of games");
    }
  });

  it("an answer that isn't a page is not the end of the list", () => {
    // A list that isn't one, or a nextToken that isn't text, would end the
    // paging early if read as an empty page or as the last one.
    for (const body of [
      '{"entitlements":{}}',
      '{"entitlements":"none"}',
      '{"entitlements":[],"nextToken":5}',
      '{"entitlements":[],"nextToken":{"token":"SECRET"}}',
    ]) {
      const err = errorOf(() => amazon.entitlementsPage(JSON.parse(body)));
      expect(err.message, body).toContain("Unexpected answer from Amazon");
      expect(err.message, body).not.toContain("SECRET");
      expect(isLoginRejected(err) || isTransient(err), body).toBe(false);
    }
    // An empty token is the last page, as Amazon sends it.
    expect(
      amazon.entitlementsPage({ entitlements: [], nextToken: "" }).nextToken,
    ).toBeNull();
    // A body that isn't JSON (a captive portal's page) or isn't an object.
    for (const body of ["<html>Sign in to the Wi-Fi</html>", "[]", "null"]) {
      const err = errorOf(() =>
        amazon.parseEntitlementsText(
          "https://portal.example/a?token=SECRET",
          body,
        ),
      );
      expect(err.message, body).toContain(
        "Unexpected response from https://portal.example/a",
      );
      expect(err.message, body).not.toContain("SECRET");
    }
  });

  it("the session survives being saved", () => {
    const host = new FakeStoreHost();
    const session = {
      accountName: "Jane Player",
      data: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 5,
        deviceSerial: "S",
      } satisfies amazon.AmazonSession,
    };
    try {
      storage.saveSession("amazon", session, host);
      expect(storage.loadSession("amazon", host)?.session).toEqual(session);
    } finally {
      storage.deleteAccount("amazon");
    }
  });

  it("secrets stay out of what's logged", () => {
    // What redact() leaves of a session and a login's state: the serial,
    // not the tokens or the verifier.
    const session: amazon.AmazonSession = {
      accessToken: "Atna|SECRET",
      refreshToken: "Atnr|SECRET",
      expiresAt: 5,
      deviceSerial: "SERIAL",
    };
    const login = { ...state(), codeVerifier: "SECRET-verifier" };
    const shown = redact(`${JSON.stringify(session)} ${JSON.stringify(login)}`);
    expect(shown).not.toContain("SECRET");
    expect(shown).toContain("SERIAL");
  });
});

// The value of a request header, whatever its case.
function header(init: StoreRequestInit, name: string) {
  return Object.entries(init.headers || {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
}

describe("Amazon account", () => {
  // A fake Amazon. It checks what the real services check: the code's PKCE
  // pair, the device's hardware hash, the token. Access tokens change on
  // every renewal; the refresh token stays.
  let issued = 0;
  let validToken = "";
  let expiresIn: number | string = 3600;
  // The challenge of the sign-in page the user signed in on.
  let challenge = "";
  let registeredSerial = "";
  let refreshRefused = false;
  let deregisterFails = false;
  let deregistered: (string | undefined)[] = [];
  let entitlements: (nextToken: string | null) => FakeAnswer;
  const library = (nextToken: string | null): FakeAnswer => {
    if (nextToken === null) {
      return { body: PAGE_1 };
    }
    if (nextToken === "page-2-token") {
      return { body: PAGE_2 };
    }
    return { status: 400, body: exception("ValidationException") };
  };
  const newAccessToken = () => {
    issued++;
    validToken = `access-${issued}`;
    return validToken;
  };
  const host = new FakeStoreHost(({ url, init }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const json = header(init, "content-type") === "application/json";
    if (url === amazon.REGISTER_URL) {
      const auth = body?.auth_data;
      const serial = body?.registration_data?.device_serial;
      if (
        !json ||
        init.method !== "POST" ||
        header(init, "user-agent") !== amazon.AUTH_USER_AGENT ||
        auth?.authorization_code !== "good-code" ||
        amazon.codeChallenge(auth?.code_verifier) !== challenge ||
        auth?.client_id !== amazon.clientId(serial)
      ) {
        return { status: 400, body: REGISTER_ERROR };
      }
      registeredSerial = serial;
      const answer = JSON.parse(REGISTER_SUCCESS);
      const success = answer.response.success;
      success.extensions.device_info.device_serial_number = serial;
      success.tokens.bearer = {
        access_token: newAccessToken(),
        refresh_token: "refresh-1",
        expires_in: String(expiresIn),
      };
      return { body: answer };
    }
    if (url === amazon.TOKEN_URL) {
      if (
        !json ||
        header(init, "user-agent") !== amazon.AUTH_USER_AGENT ||
        refreshRefused ||
        body?.source_token !== "refresh-1" ||
        body?.source_token_type !== "refresh_token"
      ) {
        return {
          status: 400,
          body: {
            error: "invalid_grant",
            error_description: "The request has an invalid grant parameter",
          },
        };
      }
      return {
        body: {
          access_token: newAccessToken(),
          token_type: "bearer",
          expires_in: expiresIn,
        },
      };
    }
    if (url === amazon.ENTITLEMENTS_URL) {
      if (header(init, "x-amzn-token") !== validToken) {
        return { status: 400, body: exception("UnrecognizedClientException") };
      }
      if (
        !json ||
        init.method !== "POST" ||
        header(init, "user-agent") !== amazon.LAUNCHER_USER_AGENT ||
        header(init, "x-amz-target") !== amazon.ENTITLEMENTS_TARGET ||
        header(init, "content-encoding") !== "amz-1.0" ||
        body?.hardwareHash !== amazon.hardwareHash(registeredSerial)
      ) {
        return { status: 400, body: exception("ValidationException") };
      }
      return entitlements(body.nextToken);
    }
    if (url === amazon.DEREGISTER_URL) {
      deregistered.push(header(init, "authorization"));
      return deregisterFails
        ? { status: 500, body: "Internal error" }
        : { body: { response: { success: {} } } };
    }
    return { status: 404 };
  });

  // The user signs in on the page at `url` in their browser (or the
  // window): the address Amazon then sends the browser to.
  const signInOn = (url: string) => {
    challenge = queryParam(url, "openid.oa2.code_challenge") ?? "";
    return "https://www.amazon.com/?openid.assoc_handle=amzn_sonic_games_launcher&openid.mode=id_res&openid.oa2.authorization_code=good-code&openid.ns=x";
  };
  // The sign-in page the parser editor opens in the user's browser: the one
  // of the sign-in in progress.
  const browserSignInPage = () => {
    const manual = refresh.pendingLogin("amazon").manual;
    if (manual.kind !== "paste") {
      throw new Error("Amazon's sign-in can be finished with a paste");
    }
    return manual.url;
  };
  // As the parser editor does: opens the sign-in page, then finishes the
  // sign-in with what the user pasted.
  const signIn = () => {
    const redirect = signInOn(browserSignInPage());
    return refresh.completeLogin(refresh.pendingLogin("amazon"), {
      pasted: redirect,
    });
  };
  const entitlementRequests = () =>
    host.requests.filter((r) => r.url === amazon.ENTITLEMENTS_URL);

  const registered = storeClient("amazon");
  beforeAll(() => registerStoreClient(amazon.amazonClient));
  beforeEach(() => {
    issued = 0;
    validToken = "";
    expiresIn = 3600;
    challenge = "";
    registeredSerial = "";
    refreshRefused = false;
    deregisterFails = false;
    deregistered = [];
    entitlements = library;
    host.requests.length = 0;
    setStoreHost(host);
  });
  afterEach(() => refresh.deleteAccount("amazon"));
  afterAll(() => {
    if (registered) {
      registerStoreClient(registered);
    } else {
      unregisterStoreClient("amazon");
    }
    setStoreHost(readOnlyStoreHost);
  });

  it("signs in with the address pasted from the page the user opened, and lists the games", async () => {
    expect(await signIn()).toBe("Jane Player");
    const games = await refresh.refreshLibrary("amazon");
    expect(games.accountName).toBe("Jane Player");
    expect(games.games.map((g) => g.id)).toEqual([
      "amzn1.adg.product.11111111-1111-1111-1111-111111111111",
      "amzn1.adg.product.33333333-3333-3333-3333-333333333333",
    ]);
    // Two pages: the first without a token, the second with the first's.
    expect(
      entitlementRequests().map((r) => JSON.parse(r.init.body!).nextToken),
    ).toEqual([null, "page-2-token"]);
    // The serial Amazon registered is the one kept.
    expect(storage.loadSession("amazon", host)?.session.data).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      deviceSerial: registeredSerial,
    });
    // Nothing secret left in what's on disk in the clear.
    const info = JSON.stringify(storage.readSessionInfo("amazon"));
    expect(info).not.toContain("access-1");
    expect(info).not.toContain("refresh-1");
    expect(JSON.stringify(refresh.cachedLibrary("amazon"))).not.toContain(
      "access-1",
    );
  });

  it("the login window's redirect signs in too", async () => {
    const pending = refresh.pendingLogin("amazon");
    expect(
      await refresh.completeLogin(pending, {
        finalUrl: signInOn(pending.startUrl),
      }),
    ).toBe("Jane Player");
  });

  it("a paste from another sign-in's page is refused", async () => {
    // The user opened a sign-in page, then that sign-in was ended and a new
    // one started: the code isn't the new one's (PKCE).
    const redirect = signInOn(browserSignInPage());
    refresh.endPendingLogin("amazon");
    const err = await refresh
      .completeLogin(refresh.pendingLogin("amazon"), { pasted: redirect })
      .catch((e) => e);
    expect(err.message).toContain("Could not finish the Amazon sign-in");
    expect(err.message).toContain("Authorization code is invalid");
    expect(storage.readSessionInfo("amazon")).toBeNull();
    // That sign-in can still be finished with its own page.
    expect(await signIn()).toBe("Jane Player");
  });

  it("renews a token about to expire, and saves the new one", async () => {
    expiresIn = 60; // (within the renewal margin)
    await signIn();
    await refresh.refreshLibrary("amazon");
    const saved = storage.loadSession("amazon", host)!.session.data;
    expect(saved).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-1",
    });
    expect(saved.expiresAt).toBeGreaterThan(Date.now());
    expect(
      host.requests.filter((r) => r.url === amazon.TOKEN_URL),
    ).toHaveLength(1);
  });

  it("a token Amazon ended early is renewed once", async () => {
    await signIn();
    validToken = "ended-early";
    // (the renewal makes access-2 the valid one)
    const games = await refresh.refreshLibrary("amazon");
    expect(games.games).toHaveLength(2);
    expect(storage.loadSession("amazon", host)!.session.data.accessToken).toBe(
      "access-2",
    );
  });

  it("a token refused after its renewal asks to sign in again", async () => {
    await signIn();
    entitlements = () => ({
      status: 403,
      body: exception("AccessDeniedException"),
    });
    const err = await refresh.refreshLibrary("amazon").catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    // Renewed once, not over and over.
    expect(
      host.requests.filter((r) => r.url === amazon.TOKEN_URL),
    ).toHaveLength(1);
    expect(refresh.accountStatus("amazon").needsSignIn).toBe(true);
  });

  it("a refused refresh token asks to sign in again", async () => {
    expiresIn = 60;
    await signIn();
    refreshRefused = true;
    const err = await refresh.refreshLibrary("amazon").catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    const account = refresh.accountStatus("amazon");
    expect(account.needsSignIn).toBe(true);
    expect(account.lastError).toContain("invalid grant");
    expect(account.lastError).not.toContain("refresh-1");
    expect(account.lastError).not.toContain("access-");
  });

  it("an outage is no reason to sign in again, and keeps the list", async () => {
    await signIn();
    const before = await refresh.refreshLibrary("amazon");
    entitlements = () => ({ status: 503, body: "Service Unavailable" });
    const err = await refresh.refreshLibrary("amazon").catch((e) => e);
    expect(isTransient(err) && !isLoginRejected(err)).toBe(true);
    expect(refresh.accountStatus("amazon").needsSignIn).toBe(false);
    expect(refresh.cachedLibrary("amazon")).toEqual(before);
    // No renewal for an outage.
    expect(host.requests.filter((r) => r.url === amazon.TOKEN_URL)).toEqual([]);
  });

  it("a page that comes again is an error, and the list from before stays", async () => {
    await signIn();
    const before: OwnedLibrary = {
      accountName: "Jane Player",
      fetchedAt: 5,
      games: [ownedGame("amazon", "amzn1.adg.product.old", "Old Game")],
      partial: false,
    };
    storage.saveLibrary("amazon", before);
    entitlements = (nextToken) =>
      nextToken === null
        ? { body: PAGE_1 }
        : { body: { ...JSON.parse(PAGE_2), nextToken: "page-2-token" } };
    const err = await refresh.refreshLibrary("amazon").catch((e) => e);
    expect(err.message).toContain("sent the same page twice");
    expect(refresh.cachedLibrary("amazon")).toEqual(before);
  });

  it(`a nextToken that never ends stops after ${amazon.MAX_PAGES} pages`, async () => {
    await signIn();
    let page = 0;
    entitlements = () => ({
      body: { entitlements: [], nextToken: `page-${++page}` },
    });
    const err = await refresh.refreshLibrary("amazon").catch((e) => e);
    expect(err.message).toContain(
      `kept sending more pages after ${amazon.MAX_PAGES}`,
    );
    expect(entitlementRequests()).toHaveLength(amazon.MAX_PAGES);
    expect(refresh.cachedLibrary("amazon")).toBeNull();
  });

  it("an unreadable session asks to sign in again", async () => {
    storage.saveSession(
      "amazon",
      { accountName: null, data: { cookies: [] } },
      host,
    );
    await expect(refresh.refreshLibrary("amazon")).rejects.toSatisfy(
      (err: Error) =>
        isLoginRejected(err) && err.message.includes("Sign in again"),
    );
    expect(host.requests).toEqual([]);
  });

  it("a session with more than SRM reads is still read", async () => {
    await signIn();
    const saved = storage.loadSession("amazon", host)!.session;
    storage.saveSession(
      "amazon",
      {
        ...saved,
        data: {
          ...saved.data,
          clientId: "53455249414c234132554d56484f58375550345637",
          userId: "amzn1.account.TEST",
        },
      },
      host,
    );
    expect((await refresh.refreshLibrary("amazon")).games).toHaveLength(2);
  });

  it("signing out deregisters the device", async () => {
    await signIn();
    expect(await refresh.signOut("amazon")).toBeNull();
    expect(deregistered).toEqual(["Bearer access-1"]);
    const request = host.requests.find((r) => r.url === amazon.DEREGISTER_URL)!;
    expect(JSON.parse(request.init.body!)).toEqual({
      request_metadata: {
        app_name: "AGSLauncher for Windows",
        app_version: "1.0.0",
      },
    });
    expect(header(request.init, "user-agent")).toBe(amazon.AUTH_USER_AGENT);
    expect(storage.readSessionInfo("amazon")).toBeNull();
  });

  it("signing out renews an expired token first, and signs out when Amazon can't be told", async () => {
    expiresIn = 60;
    await signIn();
    deregisterFails = true;
    const warning = await refresh.signOut("amazon");
    expect(deregistered).toEqual(["Bearer access-2"]);
    expect(warning).toContain("may still list");
    expect(warning).not.toContain("access-");
    expect(storage.readSessionInfo("amazon")).toBeNull();
  });
});
