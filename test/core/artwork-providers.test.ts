import { describe, expect, it } from "vitest";
import { ArtworkProviders } from "../../src/core/artwork-providers";
import { SgdbClient } from "../../src/core/sgdb-client";
import { HttpError } from "../../src/core/http";
import { SgdbPlatformId } from "../../src/models";
import {
  fakeSgdbApi as fakeApi,
  sgdbApiPaths as paths,
} from "../helpers/fake-sgdb";

function lookup(
  providers: ArtworkProviders,
  title: string,
  imageType: string,
  provider: "sgdb" | "steamCDN",
  apis: object = {},
  platformIds: SgdbPlatformId[] = [],
) {
  return new Promise<{ event: string; data: any }[]>((resolve) => {
    const events: { event: string; data: any }[] = [];
    providers.retrieveUrls(
      title,
      imageType,
      apis as any,
      provider,
      (event, data) => {
        events.push({ event, data });
        if (event === "completed") resolve(events);
      },
      platformIds,
    );
  });
}

const epic = (id: string): SgdbPlatformId => ({ platform: "egs", id });

describe("ArtworkProviders", () => {
  it("SteamGridDB: searches, then queries the artwork type with the parser's options", async () => {
    const api = fakeApi();
    const events = await lookup(
      new ArtworkProviders(api.fetch),
      "Some Game",
      "long",
      "sgdb",
      { nsfw: true, imageMotionTypes: ["static"] },
    );
    expect(events.map((e) => e.event)).toEqual(["image", "completed"]);
    expect(events[0].data.content).toEqual({
      imageProvider: "SteamGridDB",
      imageUrl: "https://cdn/grid-460x215,920x430.png",
      imageGameId: "42",
      imageArtworkId: "1",
      imageUploader: "alice",
      loadStatus: "notStarted",
    });
    const gridRequest = api.requests.find((r) => r.url.includes("/grids/"));
    expect(new URL(gridRequest.url).searchParams.get("nsfw")).toBe("any");
    expect(new URL(gridRequest.url).searchParams.get("humor")).toBe("false");
    expect(gridRequest.auth).toMatch(/^Bearer /);
  });

  it("uses an explicit ${gameid:N} without searching", async () => {
    const api = fakeApi();
    await lookup(
      new ArtworkProviders(api.fetch),
      "${gameid:42}",
      "hero",
      "sgdb",
    );
    expect(api.requests.some((r) => r.url.includes("/search/"))).toBe(false);
  });

  it("reports no match once per title (on the long type) and completes", async () => {
    const api = fakeApi();
    const providers = new ArtworkProviders(api.fetch);
    const long = await lookup(providers, "Unknown Game", "long", "sgdb");
    const hero = await lookup(providers, "Unknown Game", "hero", "sgdb");
    expect(long.map((e) => e.event)).toEqual(["error", "completed"]);
    expect(long[0].data.error).toContain("no matching games");
    expect(hero.map((e) => e.event)).toEqual(["completed"]);
  });

  it("reports HTTP errors with status and url", async () => {
    const api = fakeApi({ failGrids: 500 });
    const events = await lookup(
      new ArtworkProviders(api.fetch),
      "Some Game",
      "tall",
      "sgdb",
    );
    expect(events[0]).toMatchObject({
      event: "error",
      data: { provider: "sgdb", title: "Some Game", error: 500 },
    });
    expect(events[0].data.url).toContain("/grids/game/42");
    expect(events.at(-1).event).toBe("completed");
  });

  it("Steam CDN: icon and header urls; missing artwork is reported", async () => {
    const api = fakeApi();
    const providers = new ArtworkProviders(api.fetch);
    const icon = await lookup(providers, "Some Game", "icon", "steamCDN");
    expect(icon[0].data.content.imageUrl).toBe(
      "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/220/abc.ico",
    );
    const long = await lookup(providers, "Some Game", "long", "steamCDN");
    expect(long[0].data.content.imageUrl).toBe(
      "https://shared.steamstatic.com/store_item_assets/steam/apps/220/header.jpg",
    );
    const hero = await lookup(providers, "Some Game", "hero", "steamCDN");
    expect(hero.map((e) => e.event)).toEqual(["error", "completed"]);
  });

  it("Steam CDN: artwork Steam doesn't have (null or absent) is quietly none, not an error", async () => {
    // (was: "Cannot read properties of null (reading 'image2x')")
    const api = fakeApi();
    const providers = new ArtworkProviders(api.fetch);
    for (const type of ["logo", "tall"]) {
      const events = await lookup(providers, "Some Game", type, "steamCDN");
      expect(
        events.map((e) => e.event),
        type,
      ).toEqual(["completed"]);
    }
  });

  it("a store id SteamGridDB knows: its game, without a title search", async () => {
    const api = fakeApi();
    const events = await lookup(
      new ArtworkProviders(api.fetch),
      "Unknown Game",
      "hero",
      "sgdb",
      {},
      [epic("Sugar")],
    );
    expect(events.map((e) => e.event)).toEqual(["image", "completed"]);
    expect(events[0].data.content).toMatchObject({
      imageUrl: "https://cdn/hero.png",
      imageGameId: "42",
      imageArtworkId: "2",
    });
    expect(paths(api.requests)).toEqual([
      "/games/egs/Sugar",
      "/heroes/game/42",
    ]);
    expect(api.requests[0].auth).toMatch(/^Bearer /);
  });

  it("a store id SteamGridDB doesn't know (or can't be asked): the next one, then the title; no error for the id", async () => {
    const api = fakeApi();
    const events = await lookup(
      new ArtworkProviders(api.fetch),
      "Some Game",
      "hero",
      "sgdb",
      {},
      [{ platform: "bnet", id: "Pro" }, epic("Unreachable")],
    );
    expect(events.map((e) => e.event)).toEqual(["image", "completed"]);
    expect(events[0].data.content.imageGameId).toBe("42");
    expect(paths(api.requests)).toEqual([
      "/games/bnet/Pro",
      "/games/egs/Unreachable",
      "/search/autocomplete/Some%20Game",
      "/heroes/game/42",
    ]);

    // Neither the ids nor the title: the title's "no match", as before.
    const none = await lookup(
      new ArtworkProviders(fakeApi().fetch),
      "Unknown Game",
      "long",
      "sgdb",
      {},
      [{ platform: "bnet", id: "Pro" }],
    );
    expect(none.map((e) => e.event)).toEqual(["error", "completed"]);
    expect(none[0].data.error).toContain('title "Unknown Game"');
  });

  it("EA's offer ids go out encoded", async () => {
    const api = fakeApi();
    const events = await lookup(
      new ArtworkProviders(api.fetch),
      "Unknown Game",
      "hero",
      "sgdb",
      {},
      [{ platform: "origin", id: "OFB-EAST:52735" }],
    );
    expect(events[0].data.content.imageGameId).toBe("42");
    expect(api.requests[0].url).toBe(
      "https://www.steamgriddb.com/api/v2/games/origin/OFB-EAST%3A52735",
    );
  });

  it("an explicit ${gameid:N} (the user's pick) wins over a store id", async () => {
    const api = fakeApi();
    await lookup(
      new ArtworkProviders(api.fetch),
      "${gameid:42}",
      "hero",
      "sgdb",
      {},
      [epic("Sugar")],
    );
    expect(paths(api.requests)).toEqual(["/heroes/game/42"]);
  });

  it("one lookup per store id for every artwork type and provider; Steam CDN finds the game by it too", async () => {
    const api = fakeApi();
    const providers = new ArtworkProviders(api.fetch);
    const [long, hero, icon] = await Promise.all([
      lookup(providers, "Unknown Game", "long", "sgdb", {}, [epic("Sugar")]),
      lookup(providers, "Unknown Game", "hero", "sgdb", {}, [epic("Sugar")]),
      lookup(providers, "Unknown Game", "icon", "steamCDN", {}, [
        epic("Sugar"),
      ]),
    ]);
    expect(long[0].event).toBe("image");
    expect(hero[0].event).toBe("image");
    expect(icon[0].data.content.imageUrl).toBe(
      "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/220/abc.ico",
    );
    expect(
      paths(api.requests).filter((p) => p.startsWith("/games/egs/")),
    ).toEqual(["/games/egs/Sugar"]);
    expect(paths(api.requests).some((p) => p.startsWith("/search/"))).toBe(
      false,
    );
  });

  it("stopUrlDownload drops results of lookups already started", async () => {
    const api = fakeApi();
    const providers = new ArtworkProviders(api.fetch);
    const events: string[] = [];
    let stopped = 0;
    providers.stopEvent.subscribe(() => stopped++);
    providers.retrieveUrls("Some Game", "long", {} as any, "sgdb", (e) =>
      events.push(e),
    );
    providers.stopUrlDownload();
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([]);
    expect(stopped).toBe(1);
    expect(
      (await lookup(providers, "Some Game", "long", "sgdb")).map(
        (e) => e.event,
      ),
    ).toEqual(["image", "completed"]);
  });
});

describe("SgdbClient", () => {
  it("unwraps data and turns API errors into exceptions", async () => {
    const api = fakeApi();
    const client = new SgdbClient(api.fetch);
    expect(await client.searchGame("Some Game")).toEqual([{ id: 42 }]);
    await expect(client.getLogos({ type: "game", id: 7 })).rejects.toThrow(
      "not found",
    );
  });

  it("finds a game by its id at a store; an id it doesn't know is a 404", async () => {
    const api = fakeApi();
    const client = new SgdbClient(api.fetch);
    expect(await client.getGameByPlatformId("egs", "Sugar")).toEqual({
      id: 42,
      name: "A Game",
    });
    const error = await client
      .getGameByPlatformId("bnet", "Pro")
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(404);
  });
});
