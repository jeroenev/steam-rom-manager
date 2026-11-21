// Humble Bundle accounts (ported from BoilR's humble.rs tests, moved to the
// site Humble launched in November 2026, plus a sign-in and refreshes
// against a fake Humble).
//
// The fixtures: library_page*.html.txt and *_chunk.js.txt are excerpts of
// the real, public library page (signed out) and its scripts, of 2026-11-21
// (.txt: as they were sent, not as Prettier would write them);
// session_status_anonymous.json is the real answer; library_action_*.txt are
// BoilR's testdata (orders.json) translated into answers of the library
// action, in the shape of the site's own mock data, as no signed-in answer
// has been seen yet.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { readOnlyStoreHost, setStoreHost } from "../../src/lib/stores/host";
import {
  BROWSER_USER_AGENT,
  HttpStatus,
  StoreHttp,
  isLoginRejected,
  isTransient,
} from "../../src/lib/stores/http";
import * as humble from "../../src/lib/stores/humble";
import {
  FlightFormatError,
  FlightServerError,
  flightRoot,
  flightValue,
  parseFlightRows,
} from "../../src/lib/stores/humble-flight";
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
  StoreContext,
  StoreCookie,
  StoreSession,
  ownedGame,
} from "../../src/lib/stores/types";
import {
  FakeAnswer,
  FakeRequest,
  FakeStoreHost,
  response,
  storeFixture,
} from "../helpers/fake-store-host";

const PAGE_1 = storeFixture("humble", "library_action_page1.txt");
const PAGE_2 = storeFixture("humble", "library_action_page2.txt");
const UNAUTHORIZED = storeFixture("humble", "library_action_unauthorized.txt");
const SERVER_ERROR = storeFixture("humble", "library_action_server_error.txt");
const ANONYMOUS = storeFixture("humble", "session_status_anonymous.json");
const LIBRARY_PAGE = storeFixture("humble", "library_page.html.txt");
const SIGNED_OUT_PAGE = storeFixture(
  "humble",
  "library_page_signed_out.html.txt",
);
const LIBRARY_CHUNK = storeFixture("humble", "library_chunk.js.txt");
const OTHER_CHUNK = storeFixture("humble", "other_chunk.js.txt");

// The id of filterUserLibrary in the scripts of 2026-11-21.
const ACTION_ID = "607622c68ed0fa8a71acd7ff343f9f3366703af38e";
const CHUNKS = "https://www.humblebundle.com/_next/static/chunks";

const ids = (games: readonly OwnedGame[]) => games.map((g) => g.id);

const items = () => [
  ...humble.parseLibraryAnswer(humble.LIBRARY_URL, PAGE_1).items,
  ...humble.parseLibraryAnswer(humble.LIBRARY_URL, PAGE_2).items,
];

// A library item whose downloads each have a download for every one of
// `platforms`; `games` are [id, title] pairs, `keys` the names of its
// third-party keys.
function item(
  pageId: string,
  games: [string, string][],
  keys: string[] = [],
  platforms: string[] = ["windows"],
): humble.LibraryItem {
  return {
    id: `item-${pageId}`,
    pageId,
    title: games[0]?.[1] ?? "",
    keys: keys.map((title) => ({ id: `key-${title}`, title, platforms: [] })),
    downloads: games.map(([id, title]) => ({ id, title, platforms })),
  };
}

// A context with no network: what a parser needs none of.
function offline(): StoreContext {
  return {
    http: new StoreHttp(async () => {
      throw new Error("no network in this test");
    }),
    now: () => 1000,
    log: () => undefined,
  };
}

describe("Humble Bundle", () => {
  it("starts the login window outside the done prefix", () => {
    const pending = humble.beginLogin();
    expect(pending.startUrl).toBe(
      "https://auth.humblebundle.com/self-service/login/browser?return_to=https%3A%2F%2Fwww.humblebundle.com%2Fhome%2Flibrary",
    );
    expect(pending.doneUrlPrefixes.length).toBeGreaterThan(0);
    for (const prefix of pending.doneUrlPrefixes) {
      expect(pending.startUrl.startsWith(prefix)).toBe(false);
      // (Ory's own sign-in pages)
      expect(
        "https://auth.humblebundle.com/login?flow=0b6f1c2a".startsWith(prefix),
      ).toBe(false);
      expect(humble.LIBRARY_URL.startsWith(prefix)).toBe(true);
      expect(
        "https://www.humblebundle.com/home/library?hmb_source=navbar".startsWith(
          prefix,
        ),
      ).toBe(true);
    }
    expect(pending.cookieUrls).toEqual([
      "https://www.humblebundle.com/",
      "https://auth.humblebundle.com/",
    ]);
    // The user agent of the store's requests, which Cloudflare ties its
    // cookies to.
    expect(pending.userAgent).toBe(BROWSER_USER_AGENT);
    expect(pending.manual).toMatchObject({
      kind: "paste",
      url: humble.LOGIN_URL,
    });
  });

  it("the library page sends a signed-out visitor to the same sign-in", () => {
    expect(humble.pageRedirect(SIGNED_OUT_PAGE, humble.LIBRARY_URL)).toBe(
      humble.LOGIN_URL,
    );
    expect(
      humble.pageRedirect(LIBRARY_PAGE, humble.LIBRARY_URL),
    ).toBeUndefined();
    expect(
      humble.pageRedirect(
        '<meta http-equiv="Refresh" content="0; URL=\'/home/purchases?a=1&amp;b=2\'">',
        humble.LIBRARY_URL,
      ),
    ).toBe("https://www.humblebundle.com/home/purchases?a=1&b=2");
  });

  it("only the sign-in is a bounce", () => {
    expect(humble.isSignInPage(humble.LOGIN_URL)).toBe(true);
    expect(
      humble.isSignInPage("https://auth.humblebundle.com/login?flow=abc"),
    ).toBe(true);
    expect(humble.isSignInPage("https://www.humblebundle.com/login")).toBe(
      true,
    );
    expect(
      humble.isSignInPage("https://www.humblebundle.com/login/?goto=%2Fhome"),
    ).toBe(true);
    expect(
      humble.isSignInPage("https://www.humblebundle.com/login/captcha"),
    ).toBe(true);
    // The query of another page may name the sign-in.
    expect(
      humble.isSignInPage(
        "https://www.humblebundle.com/home/library?goto=/login",
      ),
    ).toBe(false);
    expect(
      humble.isSignInPage(
        `https://www.humblebundle.com/home/library?return_to=${encodeURIComponent(humble.LOGIN_URL)}`,
      ),
    ).toBe(false);
    expect(humble.isSignInPage("https://www.humblebundle.com/loginhelp")).toBe(
      false,
    );
    expect(humble.isSignInPage("https://www.humblebundle.com/home/login")).toBe(
      false,
    );
    expect(humble.isSignInPage(humble.LIBRARY_URL)).toBe(false);
    // Not Humble's at all.
    expect(humble.isSignInPage("https://example.com/login")).toBe(false);
    expect(humble.isSignInPage("not a url")).toBe(false);
  });

  it("reads the session status", () => {
    const status = humble.SESSION_STATUS_URL;
    expect(humble.sessionStatus(status, ANONYMOUS)).toBe("anonymous");
    expect(humble.sessionStatus(status, '{"status":"authenticated"}')).toBe(
      "signed-in",
    );
    // Sent to the sign-in instead.
    expect(humble.sessionStatus(humble.LOGIN_URL, "<html></html>")).toBe(
      "anonymous",
    );
    // Not a session status: the library tells.
    expect(humble.sessionStatus(status, "<!DOCTYPE html><html>")).toBe(
      "unknown",
    );
    expect(humble.sessionStatus(status, '{"status":""}')).toBe("unknown");
    expect(humble.sessionStatus(status, "{}")).toBe("unknown");
  });

  it("an unreadable session asks to sign in again", async () => {
    const ctx: ListContext = {
      ...offline(),
      previous: [],
      checkpoint: async () => undefined,
    };
    // What BoilR kept: the old site's cookie, which the new site doesn't
    // take.
    const boilr: StoreSession = {
      accountName: null,
      data: { simpleauth_sess: '"abc|1"' },
    };
    const err = await humble.humbleClient
      .listLibrary(boilr, ctx)
      .catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    expect(err.message).toContain("Sign in again");
    const broken: StoreSession = {
      accountName: null,
      data: { signedInAt: 1, libraryActionId: 5 },
    };
    expect(
      isLoginRejected(
        await humble.humbleClient.listLibrary(broken, ctx).catch((e) => e),
      ),
    ).toBe(true);
  });

  it("reads a pasted Cookie header", () => {
    const cookies = (pasted: string) =>
      humble
        .parsePastedCookies(pasted)
        .map((c) => `${c.name}=${c.value}@${c.domain}`);
    expect(
      cookies('  ory_session_x=abc123; _simpleauth_sess="abc|123"\n'),
    ).toEqual([
      "ory_session_x=abc123@.humblebundle.com",
      '_simpleauth_sess="abc|123"@.humblebundle.com',
    ]);
    expect(cookies("Cookie: a=1; __Host-csrf=2; a=3")).toEqual([
      // (a __Host- cookie belongs to the one host)
      "__Host-csrf=2@www.humblebundle.com",
      "a=3@.humblebundle.com",
    ]);
    // A Set-Cookie line: its attributes aren't cookies.
    expect(
      cookies(
        "ory_session_x=abc; Path=/; Domain=.humblebundle.com; Secure; HttpOnly; SameSite=Lax",
      ),
    ).toEqual(["ory_session_x=abc@.humblebundle.com"]);
    // The request headers copied whole: only the Cookie line.
    expect(
      cookies(
        "accept: text/html,application/xhtml+xml;q=0.9\ncookie: s=1; t=2\nuser-agent: Mozilla/5.0",
      ),
    ).toEqual(["s=1@.humblebundle.com", "t=2@.humblebundle.com"]);
    for (const notAHeader of ["", "abc|123", '""', "two words", "a=; b="]) {
      expect(() => humble.parsePastedCookies(notAHeader)).toThrow(
        "Cookie request header",
      );
    }
  });

  it("finds the library action in the page's scripts", () => {
    expect(humble.pageScripts(LIBRARY_PAGE, humble.LIBRARY_URL)).toEqual([
      `${CHUNKS}/2qaqooemp1_gm.js`,
      `${CHUNKS}/0x0zf977kmyrx.js`,
      `${CHUNKS}/3yn0zfgjgg9bb.js`,
      `${CHUNKS}/0oisjwfq6apc1.js`,
      `${CHUNKS}/3_4pxbn-6rbuu.js`,
    ]);
    // Only the site's own Next.js scripts, once each.
    expect(
      humble.pageScripts(
        '<script src="https://cdn.example.com/_next/static/x.js"></script><script src="/_next/static/chunks/a.js?dpl=1&amp;v=2"></script><script src=/_next/static/chunks/a.js?dpl=1&v=2></script><script>inline()</script><link rel="stylesheet" href="/_next/static/chunks/a.css">',
        humble.LIBRARY_URL,
      ),
    ).toEqual([`${CHUNKS}/a.js?dpl=1&v=2`]);

    expect(humble.actionIdIn(LIBRARY_CHUNK, humble.LIBRARY_ACTION)).toBe(
      ACTION_ID,
    );
    expect(humble.actionIdIn(LIBRARY_CHUNK, "saveLibraryShowRedeemed")).toBe(
      "4046053fd4197d81e52124dfddf4759167feeffd36",
    );
    // Another action with "Library" in its name is not it.
    expect(
      humble.actionIdIn(OTHER_CHUNK, humble.LIBRARY_ACTION),
    ).toBeUndefined();
    // A webpack build writes the reference the same way.
    expect(
      humble.actionIdIn(
        'let x=(0,n.createServerReference)("7f0a1b2c3d",n.callServer,void 0,n.findSourceMapURL,"filterUserLibrary")',
        humble.LIBRARY_ACTION,
      ),
    ).toBe("7f0a1b2c3d");
  });

  it("asks for a page of the library as the library page does", () => {
    const body = humble.libraryActionBody(2, 50);
    const fields = [
      ...body.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g),
    ].map(([, name, value]) => [name, value]);
    expect(fields).toEqual([
      ["1_requestId", "2"],
      ["1_query", ""],
      ["1_sort", "mostRecent"],
      ["1_cursor", "100"],
      ["1_page", "2"],
      ["1_limit", "50"],
      ["1_hideRevealed", "false"],
      ["1_hideExpired", "false"],
      ["1_dateExpires", ""],
      [
        "0",
        '[{"results":[],"pagination":{"page":1,"totalPages":1,"totalDocs":0},"success":true},"$K1"]',
      ],
    ]);
    expect(body.startsWith(`--${humble.FORM_BOUNDARY}\r\n`)).toBe(true);
    expect(body.endsWith(`--${humble.FORM_BOUNDARY}--\r\n`)).toBe(true);
  });

  it("reads a page of the library", () => {
    const page1 = humble.parseLibraryAnswer(humble.LIBRARY_URL, PAGE_1);
    expect(page1.totalPages).toBe(2);
    expect(page1.totalDocs).toBe(12);
    expect(page1.items.map((i) => i.title)).toEqual([
      "FEZ",
      "FEZ Soundtrack",
      "Making Of: The Book",
      "Pocket Game",
      "Steam Only Game",
    ]);
    expect(page1.items[0]).toMatchObject({
      id: "li-fez-bundle",
      pageId: "pe-li-fez-bundle",
      keys: [],
      downloads: [
        {
          id: "fez_indiebundle",
          title: "FEZ",
          platforms: ["windows", "mac", "linux", "linux"],
        },
      ],
    });
    expect(page1.items[4].keys.map((k) => k.title)).toEqual([
      "Steam Only Game Steam Key",
    ]);
    // A bundle group has nothing in it, and a null item is empty (but still
    // one of the library's entries).
    const page2 = humble.parseLibraryAnswer(humble.LIBRARY_URL, PAGE_2);
    expect(page2.items).toHaveLength(7);
    expect(page2.items[5]).toMatchObject({
      id: "grp-indie-bundle",
      pageId: "grp-indie-bundle",
      keys: [],
      downloads: [],
    });
    expect(page2.items[6]).toEqual({
      id: "",
      pageId: "",
      title: "",
      keys: [],
      downloads: [],
    });
    // (an entitlement without an id)
    expect(page2.items[3].downloads[0].id).toBe("");
  });

  it("an answer that isn't the library is told apart from a refused login", () => {
    const parse = (body: string, url = humble.LIBRARY_URL) => {
      try {
        humble.parseLibraryAnswer(url, body);
      } catch (err) {
        return err as Error;
      }
      throw new Error("parsed");
    };
    // The sign-in instead of the library, or the site's own "unauthorized".
    for (const err of [
      parse("<!DOCTYPE html><html>Sign in</html>", humble.LOGIN_URL),
      parse(UNAUTHORIZED),
      parse(UNAUTHORIZED.replace('"UNAUTHORIZED"', '"SESSION_EXPIRED"')),
    ]) {
      expect(isLoginRejected(err)).toBe(true);
      expect(err.message).toContain("Sign in again");
    }
    // Answers that merely aren't what was expected say nothing about the
    // login.
    const notTheLibrary = [
      parse("<!DOCTYPE html><html>Maintenance</html>"),
      parse('0:{"a":"$@1"}\n1:{"success":true}\n'),
      parse('0:{"a":"$@1"}\n'),
      parse('0:{"b":"build"}\n'),
      parse('{"unexpected": true}'),
      parse(SERVER_ERROR),
      parse(UNAUTHORIZED.replace('"UNAUTHORIZED"', '"INVALID_REQUEST"')),
    ];
    for (const err of notTheLibrary) {
      expect(isLoginRejected(err)).toBe(false);
    }
    expect(notTheLibrary[1].message).toContain("missing field `results`");
    expect(notTheLibrary[5].message).toContain("error 2817435029");
    expect(notTheLibrary[6]).toBeInstanceOf(humble.ActionRefused);
    expect(notTheLibrary[6].message).toContain("INVALID_REQUEST");
  });

  it("keeps download links' queries out of errors", () => {
    // (an answer without results: its start ends up in the error)
    const err = (() => {
      try {
        humble.parseLibraryAnswer(
          humble.LIBRARY_URL,
          '0:{"a":"$@1"}\n1:{"web":"https://dl.humble.com/fez.exe?gamekey=xyz&t=signature","items":[]}\n',
        );
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toContain("missing field `results`");
    expect(err?.message).toContain("https://dl.humble.com/fez.exe");
    expect(err?.message).not.toContain("signature");
    expect(err?.message).not.toContain("gamekey=");
  });

  it("reads the answers of the library action", async () => {
    const read = (answer: FakeAnswer, url = humble.LIBRARY_URL) =>
      humble.readLibraryAnswer(response(answer, url)).catch((e) => e);
    expect(await read({ body: PAGE_1 })).toMatchObject({ totalDocs: 12 });
    // An action id the site no longer knows (a new release of the site).
    expect(
      await read({
        status: 404,
        headers: { "x-nextjs-action-not-found": "1" },
        body: "Server action not found.",
      }),
    ).toBe("unknown action");
    expect(await read({ status: 404, body: "Server action not found." })).toBe(
      "unknown action",
    );
    // A redirect to the sign-in, by the action or by the server.
    expect(
      isLoginRejected(
        await read({
          status: 303,
          headers: { "x-action-redirect": `${humble.LOGIN_URL};replace` },
        }),
      ),
    ).toBe(true);
    expect(
      isLoginRejected(
        await read(
          { body: "<html></html>" },
          "https://auth.humblebundle.com/login?flow=1",
        ),
      ),
    ).toBe(true);
    const elsewhere = await read({
      status: 303,
      headers: { "x-action-redirect": "/home/purchases?x=1;push" },
    });
    expect(isLoginRejected(elsewhere)).toBe(false);
    expect(elsewhere.message).toContain("/home/purchases");
    // A status that isn't a success keeps its kind.
    const outage = await read({ status: 503, body: "Service Unavailable" });
    expect(outage).toBeInstanceOf(HttpStatus);
    expect(isTransient(outage)).toBe(true);
    expect(isLoginRejected(await read({ status: 401 }))).toBe(true);
    const missing = await read({ status: 404, body: "<html>Not found</html>" });
    expect(missing).toBeInstanceOf(HttpStatus);
  });

  it("lists DRM-free games and skips keys and non-games", () => {
    const games = humble.ownedGames(items(), []);
    // Sorted by title: Another Game, FEZ, World of Goo (Linux only).
    expect(ids(games)).toEqual([
      "anothergame_store",
      "fez_indiebundle",
      "worldofgoo_linux",
    ]);
    const fez = games[1];
    expect(fez.title).toBe("FEZ");
    expect(fez.extra).toEqual({
      url: "https://www.humblebundle.com/home/library/pe-li-fez-bundle",
    });
    // Titles lose trademark signs.
    expect(games[0].title).toBe("Another Game");
  });

  it("the same game in two items is listed once", () => {
    const games = humble.ownedGames(items(), []);
    expect(games.filter((g) => g.title === "FEZ")).toHaveLength(1);
  });

  it("keys only hide their own game in their own item", () => {
    const games = humble.ownedGames(
      [
        item("b", [
          ["limbo", "Limbo"],
          ["fez", "FEZ"],
        ]),
        item(
          "a",
          [["other", "Other"]],
          ["Limbo Steam Key", "FEZ II Steam Key"],
        ),
        item(
          "c",
          [
            ["hue", "Hue"],
            ["braid", "Braid"],
          ],
          ["Huey Steam Key", "Braid (Steam)"],
        ),
      ],
      [],
    );
    expect(ids(games)).toEqual(["fez", "hue", "limbo", "other"]);
  });

  it("games without a Windows or Linux download are not listed", () => {
    const games = humble.ownedGames(
      [
        item("a", [["mac_only", "Mac Only"]], [], ["mac"]),
        item("b", [["both", "Mac And Windows"]], [], ["mac", "windows"]),
        item("c", [["penguin", "Linux Only"]], [], ["linux"]),
        item("d", [["other", "No PC"]], [], ["android", "audio", "ebook"]),
        item("e", [["nothing", "No Download"]], [], []),
        // A title with a Mac copy in one item and a Windows copy in another
        // is listed with the copy that runs here.
        item("f", [["split_a_mac", "Split"]], [], ["mac"]),
        item("g", [["split_b_windows", "Split"]], [], ["windows"]),
      ],
      [],
    );
    expect(ids(games)).toEqual(["penguin", "both", "split_b_windows"]);
  });

  it("a new purchase does not change a game's id", () => {
    const first = humble.ownedGames([item("m", [["game_b", "Game"]])], []);
    expect(ids(first)).toEqual(["game_b"]);

    // A later purchase with a larger id, and one with a smaller id: the id
    // stays.
    const larger = [
      item("a", [["game_c", "Game"]]),
      item("m", [["game_b", "Game"]]),
    ];
    expect(ids(humble.ownedGames(larger, first))).toEqual(["game_b"]);
    const smaller = [
      item("z", [["game_a", "Game"]]),
      item("m", [["game_b", "Game"]]),
    ];
    const second = humble.ownedGames(smaller, first);
    expect(ids(second)).toEqual(["game_b"]);
    // The game still points at the item it was listed with.
    expect(second[0].extra.url).toBe(
      "https://www.humblebundle.com/home/library/m",
    );
    // And so on, list after list.
    expect(ids(humble.ownedGames(smaller, second))).toEqual(["game_b"]);

    // Listed for the first time, a title takes its smallest id, whatever the
    // order of the items.
    expect(ids(humble.ownedGames(smaller, []))).toEqual(["game_a"]);
    const reversed = [
      item("m", [["game_b", "Game"]]),
      item("z", [["game_a", "Game"]]),
    ];
    expect(ids(humble.ownedGames(reversed, []))).toEqual(["game_a"]);

    // The copy the list used is gone (refunded): the id moves to a copy
    // that is left.
    const left = [
      item("z", [["game_c", "Game"]]),
      item("y", [["game_a", "Game"]]),
    ];
    expect(ids(humble.ownedGames(left, first))).toEqual(["game_a"]);
    // Another game's id in the previous list changes nothing.
    const other = [ownedGame("humble", "unrelated", "Unrelated")];
    expect(ids(humble.ownedGames(smaller, other))).toEqual(["game_a"]);
  });

  it("matches key names like Playnite", () => {
    expect(humble.isKeyFor("FEZ", "FEZ")).toBe(true);
    expect(humble.isKeyFor("FEZ Steam Key", "FEZ")).toBe(true);
    expect(humble.isKeyFor("Fez (Steam)", "FEZ")).toBe(true);
    expect(humble.isKeyFor("FEZ™ - Epic Games Key", "FEZ")).toBe(true);
    expect(humble.isKeyFor("FEZ II Steam Key", "FEZ")).toBe(false);
    expect(humble.isKeyFor("Limbonauts Steam Key", "Limbo")).toBe(false);
    expect(humble.isKeyFor("Chuchel Steam Key", "Hue")).toBe(false);
    expect(humble.isKeyFor("Anything", "")).toBe(false);
  });

  it("follows pages until the last, and never takes a list cut short", () => {
    const page = (n: number, totalPages: number): humble.LibraryPage => ({
      items: Array.from({ length: n }, (_, i) => item(`p${i}`, [])),
      totalPages,
      totalDocs: 0,
    });
    expect(humble.nextPage(page(5, 2), 1)).toBe(2);
    expect(humble.nextPage(page(5, 2), 2)).toBeNull();
    // An empty page ends the list.
    expect(humble.nextPage(page(0, 9), 3)).toBeNull();
    // While Humble doesn't say how many pages there are: until an empty one.
    expect(humble.nextPage(page(5, 0), 7)).toBe(8);

    // (an item that moved on to the next page while the pages came)
    const listed = [item("a", []), item("b", []), item("a", [])];
    expect(humble.completeItems(listed, 3).map((i) => i.pageId)).toEqual([
      "a",
      "b",
    ]);
    // Fewer entries than the library has: a page went missing.
    expect(() => humble.completeItems(listed, 4)).toThrow(
      "listed 3 of the 4 items",
    );
  });
});

describe("React Flight", () => {
  it("reads rows that refer to each other", () => {
    const text = "Großes Spiel™: an answer";
    const body =
      '0:{"a":"$@1","b":"build","i":false}\n' +
      '2:I[523832,["chunk.js"],"default"]\n' +
      '3:HL["/_next/static/x.css","style"]\n' +
      `4:T${Buffer.byteLength(text).toString(16)},${text}` +
      '1:{"list":[{"x":1},"$1:list:0"],"price":"$$5","none":"$undefined","long":"$4","date":"$D2024-03-05T17:00:00.000Z","big":"$n12345678901234567890","odd":["$NaN","$Infinity","$-Infinity","$-0"],"module":"$L2","map":"$Q5","nested":"$1:list:1:x"}\n';
    const rows = parseFlightRows(body);
    expect(rows.get(2)).toEqual({ kind: "other", tag: "I" });
    expect(rows.get(4)).toEqual({ kind: "text", value: text });
    const root: any = flightRoot(body);
    expect(root.b).toBe("build");
    expect(root.a).toEqual({
      list: [{ x: 1 }, { x: 1 }],
      price: "$5",
      none: undefined,
      long: text,
      date: "2024-03-05T17:00:00.000Z",
      big: "12345678901234567890",
      odd: [NaN, Infinity, -Infinity, -0],
      module: undefined,
      map: undefined,
      nested: 1,
    });
    expect(flightValue(rows, 4)).toBe(text);
  });

  it("a row that refers to itself doesn't go round forever", () => {
    expect(flightRoot('0:{"self":"$0","name":"x"}\n')).toEqual({
      self: undefined,
      name: "x",
    });
    // A part of a row that holds itself.
    expect(() => flightRoot('0:{"list":["$0:list"]}\n')).toThrow(
      "nested too deep",
    );
  });

  it("an error the server threw, and an answer cut off, are errors", () => {
    expect(() => flightRoot('0:{"a":"$@1"}\n1:E{"digest":"42"}\n')).toThrow(
      FlightServerError,
    );
    expect(() =>
      flightRoot('0:{"a":"$@1"}\n1:E{"message":"Boom","digest":"42"}\n'),
    ).toThrow("the server failed: Boom");
    expect(() => flightRoot('0:{"a":"$@1"}\n')).toThrow(FlightFormatError);
    expect(() => flightRoot('0:{"a":"$@1"}\n1:T10,short')).toThrow("cut off");
    expect(() => flightRoot("<!DOCTYPE html>")).toThrow(FlightFormatError);
    expect(() => flightRoot("0:{not json}\n")).toThrow(FlightFormatError);
  });
});

// A fake humblebundle.com. `signedIn` is what Humble's browser partition
// holds: the sign-in window signs in there, a paste puts cookies there.
class FakeHumble {
  signedIn = false;
  // The library action's id in the site's current release.
  actionId = ACTION_ID;
  // The id the library page's script names (a release that broke it).
  scriptActionId = ACTION_ID;
  // The largest page the site gives.
  maxPageSize = 1000;
  // The status endpoint is gone.
  noStatus = false;
  // Pages 1 and 2 of the library.
  pages = [PAGE_1, PAGE_2];

  reset() {
    Object.assign(this, new FakeHumble());
  }

  handle = ({ url, init }: FakeRequest): FakeAnswer => {
    const u = new URL(url);
    if (url === humble.SESSION_STATUS_URL) {
      if (this.noStatus) {
        return { status: 404, body: "<!DOCTYPE html><html></html>" };
      }
      return {
        body: this.signedIn ? '{"status":"authenticated"}' : ANONYMOUS,
      };
    }
    if (url === humble.LIBRARY_URL && (init.method ?? "GET") === "GET") {
      return { body: this.signedIn ? LIBRARY_PAGE : SIGNED_OUT_PAGE };
    }
    if (url === humble.LIBRARY_URL && init.method === "POST") {
      return this.libraryAction(init.headers ?? {}, init.body ?? "");
    }
    if (u.pathname === "/_next/static/chunks/0oisjwfq6apc1.js") {
      return { body: LIBRARY_CHUNK.replace(ACTION_ID, this.scriptActionId) };
    }
    if (u.pathname === "/_next/static/chunks/3_4pxbn-6rbuu.js") {
      return { body: OTHER_CHUNK };
    }
    if (u.pathname.startsWith("/_next/static/")) {
      return { body: "/* a script without actions */" };
    }
    return { status: 404 };
  };

  private libraryAction(headers: Record<string, string>, body: string) {
    if (headers["Next-Action"] !== this.actionId) {
      return {
        status: 404,
        headers: { "x-nextjs-action-not-found": "1" },
        body: "Server action not found.",
      };
    }
    const field = (name: string) =>
      body.match(
        new RegExp(`name="1_${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`),
      )?.[1];
    if (!this.signedIn) {
      return {
        headers: { "content-type": "text/x-component" },
        body: UNAUTHORIZED,
      };
    }
    if (Number(field("limit")) > this.maxPageSize) {
      return {
        headers: { "content-type": "text/x-component" },
        body: UNAUTHORIZED.replace('"UNAUTHORIZED"', '"INVALID_REQUEST"'),
      };
    }
    const page = this.pages[Number(field("page")) - 1];
    return {
      headers: { "content-type": "text/x-component" },
      body:
        page ??
        '0:{"a":"$@1"}\n1:{"results":[],"pagination":{"page":3,"totalPages":2,"totalDocs":12},"success":true}\n',
    };
  }
}

describe("Humble Bundle account", () => {
  const fake = new FakeHumble();
  const host = new FakeStoreHost(fake.handle);
  const registered = storeClient("humble");
  const WINDOW_CAPTURE = {
    finalUrl: humble.LIBRARY_URL,
    cookies: [
      { name: "__cf_bm", value: "cf", domain: ".humblebundle.com" },
      {
        name: "ory_session_humble",
        value: "SECRET-SESSION",
        domain: ".humblebundle.com",
      },
    ],
  };

  beforeAll(() => registerStoreClient(humble.humbleClient));
  beforeEach(() => {
    fake.reset();
    host.requests.length = 0;
    setStoreHost(host);
  });
  afterEach(() => refresh.deleteAccount("humble"));
  afterAll(() => {
    setStoreHost(readOnlyStoreHost);
    if (registered) {
      registerStoreClient(registered);
    } else {
      unregisterStoreClient("humble");
    }
  });

  // The window signed in in the partition, and hands its cookies over.
  const signIn = () => {
    fake.signedIn = true;
    return refresh.completeLogin(
      refresh.pendingLogin("humble"),
      WINDOW_CAPTURE,
    );
  };
  const requested = () =>
    host.requests.map(
      (r) =>
        `${r.init.method ?? "GET"} ${r.url.replace("https://www.humblebundle.com", "")}`,
    );
  const savedSession = () => storage.loadSession("humble", host)!.session;

  it("signs in from the window and lists the games", async () => {
    expect(await signIn()).toBeNull();
    const library = await refresh.refreshLibrary("humble");
    expect(ids(library.games)).toEqual([
      "anothergame_store",
      "fez_indiebundle",
      "worldofgoo_linux",
    ]);
    expect(requested()).toEqual([
      "GET /api/auth/session-status",
      "GET /api/auth/session-status",
      // The action's id, from the page's scripts, the last first.
      "GET /home/library",
      "GET /_next/static/chunks/3_4pxbn-6rbuu.js",
      "GET /_next/static/chunks/0oisjwfq6apc1.js",
      "POST /home/library",
      "POST /home/library",
    ]);
    const posts = host.requests.filter((r) => r.init.method === "POST");
    expect(posts[0].init.headers).toMatchObject({
      Accept: "text/x-component",
      // (as the site's own page sends it: Next.js checks it)
      Origin: "https://www.humblebundle.com",
      "Next-Action": ACTION_ID,
      "Content-Type": `multipart/form-data; boundary=${humble.FORM_BOUNDARY}`,
    });
    expect(posts[1].init.body).toContain('name="1_page"\r\n\r\n2\r\n');
    // The id is kept for the next time, with nothing secret.
    expect(savedSession().data).toEqual({
      signedInAt: expect.any(Number),
      libraryActionId: ACTION_ID,
    });
    expect(JSON.stringify(storage.readSessionInfo("humble"))).not.toContain(
      "SECRET-SESSION",
    );
    expect(JSON.stringify(savedSession())).not.toContain("SECRET-SESSION");

    // The next refresh goes straight to the library.
    host.requests.length = 0;
    await refresh.refreshLibrary("humble");
    expect(requested()).toEqual([
      "GET /api/auth/session-status",
      "POST /home/library",
      "POST /home/library",
    ]);
  });

  it("a window that signed in nowhere did not sign in", async () => {
    await expect(
      refresh.completeLogin(refresh.pendingLogin("humble"), {
        finalUrl: humble.LIBRARY_URL,
        cookies: [{ name: "x", value: "y", domain: "accounts.example.com" }],
      }),
    ).rejects.toThrow("no humblebundle.com cookies");
    // Cookies, but Humble calls the partition signed out.
    const err = await refresh
      .completeLogin(refresh.pendingLogin("humble"), WINDOW_CAPTURE)
      .catch((e) => e);
    expect(err.message).toContain("Signing in to Humble Bundle did not finish");
    expect(storage.readSessionInfo("humble")).toBeNull();
  });

  it("a signed-out partition asks to sign in again", async () => {
    await signIn();
    await refresh.refreshLibrary("humble");
    fake.signedIn = false;
    const err = await refresh.refreshLibrary("humble").catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    expect(refresh.accountStatus("humble").needsSignIn).toBe(true);
    // The list from before stays.
    expect(refresh.cachedLibrary("humble")?.games).toHaveLength(3);
  });

  it("without the session status, the signed-out library page tells", async () => {
    await signIn();
    fake.noStatus = true;
    fake.signedIn = false;
    const err = await refresh.refreshLibrary("humble").catch((e) => e);
    expect(isLoginRejected(err)).toBe(true);
    // And a known action's "unauthorized" does too.
    fake.signedIn = true;
    await refresh.refreshLibrary("humble");
    fake.signedIn = false;
    expect(
      isLoginRejected(await refresh.refreshLibrary("humble").catch((e) => e)),
    ).toBe(true);
  });

  it("looks the action up again after a new release of the site", async () => {
    await signIn();
    await refresh.refreshLibrary("humble");
    fake.actionId = fake.scriptActionId =
      "7f00112233445566778899aabbccddeeff00112233";
    host.requests.length = 0;
    const library = await refresh.refreshLibrary("humble");
    expect(library.games).toHaveLength(3);
    expect(requested()).toEqual([
      "GET /api/auth/session-status",
      "POST /home/library",
      "GET /home/library",
      "GET /_next/static/chunks/3_4pxbn-6rbuu.js",
      "GET /_next/static/chunks/0oisjwfq6apc1.js",
      "POST /home/library",
      "POST /home/library",
    ]);
    expect(savedSession().data.libraryActionId).toBe(fake.actionId);
  });

  it("an action the site doesn't take is no refused login", async () => {
    await signIn();
    fake.scriptActionId = "0000aaaabbbbccccddddeeeeffff000011112222";
    const err = await refresh.refreshLibrary("humble").catch((e) => e);
    expect(isLoginRejected(err)).toBe(false);
    expect(err.message).toContain("SRM needs an update");
    // A page whose scripts don't have it at all.
    fake.scriptActionId = ACTION_ID;
    fake.actionId = "other";
    const gone = await refresh.refreshLibrary("humble").catch((e) => e);
    expect(gone.message).toContain("SRM needs an update");
  });

  it("asks for pages as the library page does when larger ones are refused", async () => {
    fake.maxPageSize = humble.SITE_PAGE_SIZE;
    await signIn();
    const library = await refresh.refreshLibrary("humble");
    expect(library.games).toHaveLength(3);
    const limits = host.requests
      .filter((r) => r.init.method === "POST")
      .map((r) => r.init.body?.match(/name="1_limit"\r\n\r\n(\d+)/)?.[1]);
    expect(limits).toEqual([
      String(humble.PAGE_SIZE),
      String(humble.SITE_PAGE_SIZE),
      String(humble.SITE_PAGE_SIZE),
    ]);
  });

  it("a list shorter than the library says it is isn't saved", async () => {
    await signIn();
    const before = await refresh.refreshLibrary("humble");
    // The second page doesn't come: the first says it's the last.
    fake.pages = [PAGE_1.replace('"totalPages":2', '"totalPages":1')];
    const err = await refresh.refreshLibrary("humble").catch((e) => e);
    expect(err.message).toContain("listed 5 of the 12 items");
    expect(refresh.cachedLibrary("humble")?.games).toEqual(before.games);
  });

  it("a pasted Cookie header goes into the partition", async () => {
    const set: StoreCookie[] = [];
    const ctx: StoreContext = {
      http: new StoreHttp(host.fetchFor("humble")),
      now: () => 1234,
      log: () => undefined,
      setCookies: async (cookies: StoreCookie[]) => {
        set.push(...cookies);
        fake.signedIn = cookies.some((c) => c.name === "ory_session_humble");
      },
    };
    const pending = humble.beginLogin();
    const session = await humble.humbleClient.completeLogin(
      pending,
      { pasted: "ory_session_humble=SECRET-SESSION; __cf_bm=cf" },
      ctx,
    );
    expect(session).toEqual({ accountName: null, data: { signedInAt: 1234 } });
    expect(set).toEqual([
      {
        name: "ory_session_humble",
        value: "SECRET-SESSION",
        domain: ".humblebundle.com",
      },
      { name: "__cf_bm", value: "cf", domain: ".humblebundle.com" },
    ]);

    // Cookies Humble doesn't take.
    const refused = await humble.humbleClient
      .completeLogin(pending, { pasted: "other=1" }, ctx)
      .catch((e) => e);
    expect(isLoginRejected(refused)).toBe(true);
    expect(refused.message).toContain("did not finish");
    expect(refused.message).not.toContain("other=1");
    // A host that can't put cookies in the partition.
    await expect(
      humble.humbleClient.completeLogin(
        pending,
        { pasted: "ory_session_humble=SECRET-SESSION" },
        { http: ctx.http, now: ctx.now, log: ctx.log },
      ),
    ).rejects.toThrow("Sign in with SRM's sign-in window instead");
    await expect(
      refresh.completeLogin(refresh.pendingLogin("humble"), {
        pasted: "ory_session_humble=SECRET-SESSION",
      }),
    ).rejects.toThrow("Sign in with SRM's sign-in window instead");
  });

  it("a pasted Cookie header signs in through the app, into Humble's partition", async () => {
    const put: string[] = [];
    host.setCookies = async (store, cookies) => {
      put.push(...cookies.map((c) => `${store} ${c.name} ${c.domain}`));
      fake.signedIn = cookies.some((c) => c.name === "ory_session_humble");
    };
    try {
      expect(
        await refresh.completeLogin(refresh.pendingLogin("humble"), {
          pasted: "Cookie: ory_session_humble=SECRET-SESSION; __cf_bm=cf",
        }),
      ).toBeNull();
      expect(put).toEqual([
        "humble ory_session_humble .humblebundle.com",
        "humble __cf_bm .humblebundle.com",
      ]);
      const library = await refresh.refreshLibrary("humble");
      expect(library.games.length).toBeGreaterThan(0);
      expect(JSON.stringify(savedSession())).not.toContain("SECRET-SESSION");
    } finally {
      delete host.setCookies;
    }
  });
});
