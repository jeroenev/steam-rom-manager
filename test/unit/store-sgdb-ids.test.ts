// The id SteamGridDB knows an owned game by: what each store's client gives,
// as SteamGridDB takes it (/games/<platform>/<id>).
import { describe, expect, it } from "vitest";
import { sgdbPlatformIdOf } from "../../src/lib/stores/sgdb-ids";
import { ownedGame } from "../../src/lib/stores/types";

describe("sgdbPlatformIdOf", () => {
  it("Epic by appName, EA by offer id", () => {
    expect(
      sgdbPlatformIdOf(
        ownedGame("epic", "Sugar", "Rocket League", {
          namespace: "ns-rl",
          catalog_item_id: "cat-rl",
        }),
      ),
    ).toEqual({ platform: "egs", id: "Sugar" });
    expect(
      sgdbPlatformIdOf(
        ownedGame("ea", "OFB-EAST:52735", "Zuma's Revenge!", {
          content_id: "1002139",
        }),
      ),
    ).toEqual({ platform: "origin", id: "OFB-EAST:52735" });
  });

  it("Battle.net by the launcher's internal id, not the product code SteamGridDB doesn't know", () => {
    expect(
      sgdbPlatformIdOf(
        ownedGame("battlenet", "Pro", "Overwatch 2", {
          internal_id: "prometheus",
        }),
      ),
    ).toEqual({ platform: "bnet", id: "prometheus" });
    // A classic game, or one the product table lacks: no internal id.
    expect(
      sgdbPlatformIdOf(
        ownedGame("battlenet", "W3C", "Warcraft III: Reign of Chaos"),
      ),
    ).toBeUndefined();
  });

  it("GOG, Amazon, Humble and itch.io: SteamGridDB has no such platform", () => {
    for (const store of ["gog", "amazon", "humble", "itch"] as const) {
      expect(sgdbPlatformIdOf(ownedGame(store, "1", "A Game"))).toBeUndefined();
    }
  });
});
