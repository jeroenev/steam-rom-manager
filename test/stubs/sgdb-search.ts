// Stand-in for src/lib/image-providers/sgdb-search.ts, which queries
// SteamGridDB over the network. Calls are recorded so tests can assert on
// (and pin) how often lib code searches SteamGridDB.
import type { SgdbPlatformId } from "../../src/models/image-providers.model";
import { sgdbIdRegex } from "../../src/lib/image-providers/available-providers";

export const sgdbCalls: {
  method: string;
  title: string;
  // (only when the lookup had store ids)
  platformIds?: SgdbPlatformId[];
}[] = [];
export const sgdbIds: { [title: string]: number[] } = {};
// Games SteamGridDB knows by their id at a store: "<platform>/<id>" -> id.
export const sgdbStoreIds: { [platformAndId: string]: number } = {};
// Titles whose lookups reject, simulating SteamGridDB being unreachable.
export const sgdbFailures = new Set<string>();

export async function retrieveIdsFromTitle(
  title: string,
  platformIds: readonly SgdbPlatformId[] = [],
): Promise<number[]> {
  sgdbCalls.push({
    method: "retrieveIdsFromTitle",
    title,
    ...(platformIds.length && { platformIds: [...platformIds] }),
  });
  if (sgdbFailures.has(title)) {
    throw new Error("getaddrinfo ENOTFOUND www.steamgriddb.com");
  }
  // (as the real one: an explicit id first; see test/unit/sgdb-search.test.ts)
  if (sgdbIdRegex.test(title)) {
    return [parseInt(title.match(sgdbIdRegex)![1])];
  }
  for (const { platform, id } of platformIds) {
    const known = sgdbStoreIds[`${platform}/${id}`];
    if (known) {
      return [known];
    }
  }
  return sgdbIds[title] ?? [];
}

export async function retrievePossibleIds(title: string): Promise<any[]> {
  sgdbCalls.push({ method: "retrievePossibleIds", title });
  return (sgdbIds[title] ?? []).map((id) => ({ id, posterUrl: "" }));
}
