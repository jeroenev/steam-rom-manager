// SRM's login window, with Electron faked: what a cookie store's partition
// keeps once the window closes (only the store's own sites' data; a Google or
// Steam sign-in's goes).
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { dropOtherSitesData, isSiteCookie } from "../../src/main/store-login";
import { storeClient } from "../../src/lib/stores/registry";
import { COOKIE_STORES, STORE_KEYS } from "../../src/lib/stores/types";

describe("the login window", () => {
  it("knows a store's own cookies", () => {
    for (const domain of ["accounts.ea.com", ".ea.com", "signin.ea.com"]) {
      expect(isSiteCookie(domain, ["ea.com"])).toBe(true);
    }
    for (const domain of [
      "steamcommunity.com",
      ".google.com",
      "notea.com",
      "ea.com.example",
      "",
      ".",
    ]) {
      expect(isSiteCookie(domain, ["ea.com"])).toBe(false);
    }
    const battlenet = ["battle.net", "blizzard.com"];
    for (const domain of [".battle.net", "oauth.battle.net", "blizzard.com"]) {
      expect(isSiteCookie(domain, battlenet)).toBe(true);
    }
    expect(isSiteCookie(".apple.com", battlenet)).toBe(false);
  });

  it("every cookie store names its sites; token stores need none", () => {
    for (const store of STORE_KEYS) {
      const sites = storeClient(store)?.beginLogin().siteDomains;
      if (COOKIE_STORES.includes(store)) {
        expect(sites?.length, store).toBeGreaterThan(0);
        // Its sign-in start page is one of them.
        const start = new URL(storeClient(store)!.beginLogin().startUrl);
        expect(isSiteCookie(start.hostname, sites!), store).toBe(true);
      } else {
        expect(sites, store).toBeUndefined();
      }
    }
  });

  it("removes what other sites left in a cookie store's partition", async () => {
    const cookies = [
      { name: "sid", domain: ".ea.com", path: "/", secure: true },
      {
        name: "remid",
        domain: "accounts.ea.com",
        path: "/connect",
        secure: true,
      },
      {
        name: "steamLoginSecure",
        domain: "steamcommunity.com",
        path: "/",
        secure: true,
      },
      { name: "SID", domain: ".google.com", path: "/", secure: false },
      { name: "x", domain: "notea.com", path: "/p", secure: true },
    ];
    const calls: string[] = [];
    const cleared: any[] = [];
    const ses = {
      cookies: {
        get: async () => cookies,
        remove: async (url: string, name: string) => {
          calls.push(`remove ${url} ${name}`);
          if (name === "SID") {
            throw new Error("gone already");
          }
        },
        flushStore: async () => {
          calls.push("flush");
        },
      },
      clearStorageData: async (options: any) => {
        cleared.push(options);
      },
    };
    await dropOtherSitesData(
      ses as any,
      ["ea.com"],
      [
        "https://www.ea.com",
        "https://signin.ea.com",
        "https://store.steampowered.com",
        "https://accounts.google.com",
      ],
    );
    expect(calls).toEqual([
      "remove https://steamcommunity.com/ steamLoginSecure",
      "remove http://google.com/ SID",
      "remove https://notea.com/p x",
      "flush",
    ]);
    expect(cleared.map((o) => o.origin)).toEqual([
      "https://store.steampowered.com",
      "https://accounts.google.com",
    ]);
    // (their cookies are gone already: the store's own aren't touched)
    for (const options of cleared) {
      expect(options.storages).not.toContain("cookies");
    }
  });
});
