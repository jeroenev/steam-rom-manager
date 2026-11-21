// The id SteamGridDB knows an owned game by, for the stores its API has as
// platforms (BoilR's store_platform). The artwork providers look the game up
// by it before they search its title.
//
// What SteamGridDB takes (/games/<platform>/<id>, checked against it):
// - Epic (egs): the appName, OwnedGame.id (Fortnite, Sugar, Salt);
// - EA (origin): the offer id, OwnedGame.id (Origin.OFR.50.0001000,
//   OFB-EAST:52735);
// - Battle.net (bnet): the launcher's internal id, extra.internal_id
//   (prometheus, hs_beta, diablo3), not the product code in OwnedGame.id:
//   SteamGridDB knows neither Pro nor WTCG nor D3. Classic games and games
//   the product table lacks have no internal id: their title is searched.
// GOG, Amazon, Humble and itch.io: SteamGridDB has no such platform.
import type { SgdbPlatformId } from "../../models/image-providers.model";
import { OwnedGame } from "./types";

export function sgdbPlatformIdOf(game: OwnedGame): SgdbPlatformId | undefined {
  const of = (platform: SgdbPlatformId["platform"], id: string | undefined) =>
    id ? { platform, id } : undefined;
  switch (game.store) {
    case "epic":
      return of("egs", game.id);
    case "ea":
      return of("origin", game.id);
    case "battlenet":
      return of("bnet", game.extra.internal_id);
    default:
      return undefined;
  }
}
