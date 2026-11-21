// The store clients' HTTP helpers (ported from BoilR's http.rs tests).
import { describe, expect, it } from "vitest";
import {
  HttpStatus,
  StoreHttp,
  cleanTitle,
  domainMatches,
  isLoginRejected,
  isTransient,
  loginRejected,
  paginate,
  queryParam,
  redact,
  snippet,
  statusOf,
  transient,
  withoutQuery,
  wrapErr,
} from "../../src/lib/stores/http";
import { FakeStoreHost } from "../helpers/fake-store-host";

const status = (code: number) =>
  new HttpStatus(code, "https://store.example/api", "");

describe("store HTTP helpers", () => {
  it("redacts secrets in URLs and JSON", () => {
    const message = `400 Bad Request from https://auth.gog.com/token?client_id=1&refresh_token=SECRET: {"error":"invalid_grant","refresh_token": "SECRET2","access_token":"SEC\\"RET3","count":2}`;
    const redacted = redact(message);
    expect(redacted).not.toContain("SECRET");
    expect(redacted).not.toContain("RET3");
    expect(redacted).toContain("https://auth.gog.com/token ");
    expect(redacted).toContain('"error":"invalid_grant"');
    expect(redacted).toContain('"count":2');
    // Cut-off JSON, as in a snippet.
    expect(redact('{"gamekey":"abc')).toBe('{"gamekey":"…"');
    expect(redact("see (https://x.com/a?k=1#f) ok")).toBe(
      "see (https://x.com/a) ok",
    );
    expect(
      withoutQuery(
        "https://u:p@humblebundle.com/api/v1/order/K?all_tpkds=true#x",
      ),
    ).toBe("https://humblebundle.com/api/v1/order/K");
  });

  it("reads query parameters", () => {
    expect(
      queryParam(
        "https://embed.gog.com/on_login_success?origin=client&code=XYZ",
        "code",
      ),
    ).toBe("XYZ");
  });

  it("only a refused login asks to sign in again", () => {
    expect(isLoginRejected(status(401))).toBe(true);
    expect(isLoginRejected(loginRejected("signed out"))).toBe(true);
    // Wrapping keeps the kind.
    const wrapped = wrapErr(status(401), "Could not load the library");
    expect(isLoginRejected(wrapped)).toBe(true);
    expect(statusOf(wrapped)).toBe(401);
    expect(wrapped.message).toContain("Could not load the library");
    // A bot block, an outage and a rate limit say nothing about the login.
    for (const other of [403, 429, 500, 502, 503]) {
      expect(isLoginRejected(status(other))).toBe(false);
    }
    expect(isLoginRejected(transient("no connection"))).toBe(false);
    expect(isLoginRejected(new Error("sign in again"))).toBe(false);
  });

  it("outages and rate limits are transient", () => {
    for (const code of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isTransient(status(code))).toBe(true);
    }
    for (const code of [400, 401, 403, 404]) {
      expect(isTransient(status(code))).toBe(false);
    }
    expect(isTransient(transient("timed out"))).toBe(true);
    expect(isTransient(new Error("unexpected answer"))).toBe(false);
  });

  it("says what a status means", () => {
    expect(status(401).message).toContain("Sign in again");
    expect(status(503).message).toBe(
      "503 Service Unavailable from https://store.example/api: ",
    );
  });

  it("keeps snippets short and redacted", () => {
    const body = `{"access_token":"SECRET","filler":"${"x".repeat(5000)}"}`;
    const shown = snippet(body);
    expect(shown).not.toContain("SECRET");
    expect(Array.from(shown)).toHaveLength(300);
  });

  // Pages of a list: page n holds [n] and is followed by next(n).
  const pages = (maxPages: number, next: (page: number) => number | null) =>
    paginate("The test store", 1, maxPages, async (page: number) => [
      [page],
      next(page),
    ]);

  it("paging ends on the last page", async () => {
    expect(await pages(10, (page) => (page < 3 ? page + 1 : null))).toEqual([
      1, 2, 3,
    ]);
  });

  it("a list cut short is an error, not a shorter list", async () => {
    // More pages than allowed.
    await expect(pages(3, (page) => page + 1)).rejects.toThrow(
      "more pages after 3",
    );
    // The store keeps answering with the same cursor.
    await expect(pages(10, (page) => Math.min(page, 2))).rejects.toThrow(
      "same page twice",
    );
    // A failing page fails the list.
    const failed = paginate("The test store", 1, 10, async (page: number) => {
      if (page === 2) {
        throw status(503);
      }
      return [[page], page + 1];
    });
    await expect(failed).rejects.toSatisfy(isTransient);
  });

  it("titles lose trademark signs and extra spaces", () => {
    expect(cleanTitle("  FEZ™  ")).toBe("FEZ");
    expect(cleanTitle("The Sims®  4 ©")).toBe("The Sims 4");
    expect(cleanTitle("Plain Title")).toBe("Plain Title");
  });

  it("matches cookie domains", () => {
    expect(domainMatches(".humblebundle.com", "www.humblebundle.com")).toBe(
      true,
    );
    expect(domainMatches("humblebundle.com", "humblebundle.com")).toBe(true);
    expect(domainMatches(".humblebundle.com", "nothumblebundle.com")).toBe(
      false,
    );
  });

  it("sends requests with a browser's user agent and errors of the right kind", async () => {
    const host = new FakeStoreHost(({ url }) => {
      if (url.includes("down")) {
        return { status: 503, body: '{"access_token":"SECRET"}' };
      }
      if (url.includes("offline")) {
        return new TypeError("fetch failed");
      }
      return { body: { ok: 1 } };
    });
    const http = new StoreHttp(host.fetchFor("gog"));
    expect(await http.sendJson("https://store.example/a")).toEqual({ ok: 1 });
    expect(host.requests[0].init.headers["User-Agent"]).toMatch(/^Mozilla/);
    // A store's own user agent wins.
    await http.send("https://store.example/b", {
      headers: { "user-agent": "Launcher/1" },
    });
    expect(host.requests[1].init.headers).toEqual({
      "user-agent": "Launcher/1",
    });

    const down = await http
      .send("https://store.example/down?token=SECRET")
      .catch((err) => err);
    expect(down).toBeInstanceOf(HttpStatus);
    expect(isTransient(down)).toBe(true);
    expect(down.message).not.toContain("SECRET");

    const offline = await http
      .send("https://store.example/offline?token=SECRET")
      .catch((err) => err);
    expect(isTransient(offline)).toBe(true);
    expect(offline.message).toContain("fetch failed");
    expect(offline.message).not.toContain("SECRET");

    // Not JSON: says what came instead, without secrets.
    host.handler = () => ({ body: '<html>{"session":"SECRET"}</html>' });
    const notJson = await http
      .sendJson("https://store.example/c?key=SECRET")
      .catch((err) => err);
    expect(notJson.message).toContain(
      "Unexpected response from https://store.example/c:",
    );
    expect(notJson.message).toContain("<html>");
    expect(notJson.message).not.toContain("SECRET");
  });

  it("ends a request that hangs: its timeout, the refresh's deadline, the caller's signal", async () => {
    // A store that never answers.
    const host = new FakeStoreHost(() => new Promise(() => {}));
    const hangs = async (
      http: StoreHttp,
      abort: () => void = () => undefined,
      init = {},
    ) => {
      const sent = http.send("https://store.example/slow?token=SECRET", init);
      abort();
      const err = await sent.catch((e) => e);
      expect(isTransient(err)).toBe(true);
      expect(err.message).not.toContain("SECRET");
      const request = host.requests[host.requests.length - 1];
      expect(request.init.signal!.aborted).toBe(true);
    };

    await hangs(new StoreHttp(host.fetchFor("gog"), { timeoutMs: 20 }));
    const deadline = new AbortController();
    await hangs(
      new StoreHttp(host.fetchFor("gog"), { signal: deadline.signal }),
      () => deadline.abort(),
    );
    // Both signals count: the refresh's and the request's own.
    const caller = new AbortController();
    await hangs(
      new StoreHttp(host.fetchFor("gog"), {
        signal: new AbortController().signal,
      }),
      () => caller.abort(),
      { signal: caller.signal },
    );
    expect(host.requests).toHaveLength(3);
  });
});
