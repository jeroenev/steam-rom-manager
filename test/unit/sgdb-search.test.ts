// The real SteamGridDB lookup of lib code (the file parser's artwork
// backups, Fix match): test/setup.ts replaces the module with a stub for
// every other test, so this one loads the actual module, against a fake
// SteamGridDB. An explicit ${gameid:N} wins; then the game SteamGridDB knows
// by a store id, the first it knows; then the title's search.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Fetch, getDefaultFetch, setDefaultFetch } from "../../src/core/http";
import { fakeSgdbApi, sgdbApiPaths } from "../helpers/fake-sgdb";

type SgdbSearch = typeof import("../../src/lib/image-providers/sgdb-search");

describe("retrieveIdsFromTitle (the real module)", () => {
  let real: SgdbSearch;
  let api: ReturnType<typeof fakeSgdbApi>;
  let previous: Fetch;

  beforeAll(async () => {
    real = await vi.importActual<SgdbSearch>(
      "../../src/lib/image-providers/sgdb-search",
    );
  });
  beforeEach(() => {
    previous = getDefaultFetch();
    api = fakeSgdbApi();
    setDefaultFetch(api.fetch);
  });
  afterEach(() => setDefaultFetch(previous));

  it("the game SteamGridDB knows by its Epic id, without a search", async () => {
    expect(
      await real.retrieveIdsFromTitle("Rocket League", [
        { platform: "egs", id: "Sugar" },
      ]),
    ).toEqual([42]);
    expect(sgdbApiPaths(api.requests)).toEqual(["/games/egs/Sugar"]);
  });

  it("an id SteamGridDB doesn't know (404): the title's search", async () => {
    expect(
      await real.retrieveIdsFromTitle("Overwatch", [
        { platform: "bnet", id: "Pro" },
      ]),
    ).toEqual([42]);
    expect(sgdbApiPaths(api.requests)).toEqual([
      "/games/bnet/Pro",
      "/search/autocomplete/Overwatch",
    ]);
  });

  it("an id that can't be looked up (no network): the title's search, no error", async () => {
    await expect(
      real.retrieveIdsFromTitle("A Game", [
        { platform: "egs", id: "Unreachable" },
      ]),
    ).resolves.toEqual([42]);
    expect(sgdbApiPaths(api.requests)).toEqual([
      "/games/egs/Unreachable",
      "/search/autocomplete/A%20Game",
    ]);
  });

  it("the first id SteamGridDB knows wins", async () => {
    expect(
      await real.retrieveIdsFromTitle("A Game", [
        { platform: "bnet", id: "Pro" },
        { platform: "egs", id: "Sugar" },
      ]),
    ).toEqual([42]);
    expect(sgdbApiPaths(api.requests)).toEqual([
      "/games/bnet/Pro",
      "/games/egs/Sugar",
    ]);
  });

  it("an explicit ${gameid:N} wins over store ids, with no request", async () => {
    expect(
      await real.retrieveIdsFromTitle("${gameid:7}", [
        { platform: "egs", id: "Sugar" },
      ]),
    ).toEqual([7]);
    expect(api.requests).toEqual([]);
  });

  it("EA's offer id goes out encoded (its colon)", async () => {
    expect(
      await real.retrieveIdsFromTitle("Zuma's Revenge!", [
        { platform: "origin", id: "OFB-EAST:52735" },
      ]),
    ).toEqual([42]);
    expect(new URL(api.requests[0].url).pathname).toBe(
      "/api/v2/games/origin/OFB-EAST%3A52735",
    );
  });

  it("no store ids: the title's search", async () => {
    expect(await real.retrieveIdsFromTitle("Unknown Game")).toEqual([]);
    expect(sgdbApiPaths(api.requests)).toEqual([
      "/search/autocomplete/Unknown%20Game",
    ]);
  });
});
