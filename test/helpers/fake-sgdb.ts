// A fake SteamGridDB API + Steam CDN, for the artwork providers and the
// SteamGridDB lookups of lib code (sgdb-search). `requests` records what was
// asked.
import { Fetch } from "../../src/core/http";

export function fakeSgdbApi(opts: { failGrids?: number } = {}) {
  const requests: { url: string; method: string; auth?: string }[] = [];
  const ok = (data: any) => ({ success: true, data });
  const fetch: Fetch = async (url, init) => {
    requests.push({
      url,
      method: init?.method ?? "GET",
      auth: init?.headers?.Authorization,
    });
    const respond = (body: any, status = 200) => ({
      ok: status < 300,
      status,
      statusText: String(status),
      json: async () => body,
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const u = new URL(url);
    if (u.hostname === "shared.steamstatic.com") {
      return respond(null, u.pathname.includes("missing") ? 404 : 200);
    }
    const p = decodeURIComponent(u.pathname.replace("/api/v2", ""));
    // Games SteamGridDB knows by their id at a store: Rocket League at Epic,
    // Zuma's Revenge! at EA (an offer id with a colon).
    if (p === "/games/egs/Sugar" || p === "/games/origin/OFB-EAST:52735") {
      return respond(ok({ id: 42, name: "A Game" }));
    }
    if (p === "/games/egs/Unreachable") {
      throw new Error("getaddrinfo ENOTFOUND www.steamgriddb.com");
    }
    if (p.startsWith("/search/autocomplete/")) {
      const term = p.slice("/search/autocomplete/".length);
      return respond(ok(term === "Unknown Game" ? [] : [{ id: 42 }]));
    }
    if (p === "/grids/game/42") {
      if (opts.failGrids) return respond({ success: false }, opts.failGrids);
      return respond(
        ok([
          {
            id: 1,
            url: `https://cdn/grid-${u.searchParams.get("dimensions")}.png`,
            author: { name: "alice" },
          },
        ]),
      );
    }
    if (p === "/heroes/game/42") {
      return respond(
        ok([{ id: 2, url: "https://cdn/hero.png", author: { name: "bob" } }]),
      );
    }
    if (p === "/games/id/42") {
      return respond(
        ok({
          external_platform_data: {
            steam: [
              {
                id: 220,
                metadata: {
                  clienticon: "abc",
                  header_image_full: { english: "header.jpg" },
                  library_hero_full: { image: { english: "missing.jpg" } },
                  // (Steam has no logo for it: its entry is null)
                  library_logo_full: null,
                },
              },
            ],
          },
        }),
      );
    }
    return respond({ success: false, errors: ["not found"] }, 404);
  };
  return { fetch, requests };
}

// The API paths of `requests`, in order.
export const sgdbApiPaths = (requests: { url: string }[]) =>
  requests.map((r) => new URL(r.url).pathname.replace("/api/v2", ""));
