// The store accounts over IPC: StoresService (renderer) to the StoresStore
// in main, with a fake host (fake itch.io and GOG servers, a fake sign-in
// window). The UI sees the account change as it signs in, refreshes and
// signs out, and never gets a secret.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as paths from "../../src/paths";
import { Core } from "../../src/core/core";
import { hostCore } from "../../src/core/rpc-host";
import { CoreClient } from "../../src/renderer/core-client";
import { StoresService } from "../../src/renderer/services/stores.service";
import {
  LoginCancelled,
  readOnlyStoreHost,
  setStoreHost,
} from "../../src/lib/stores/host";
import * as refresh from "../../src/lib/stores/refresh";
import {
  registerStoreClient,
  storeClient,
  unregisterStoreClient,
} from "../../src/lib/stores/registry";
import { STORE_KEYS } from "../../src/lib/stores/types";
import {
  StoreAccountParser,
  setStoreAccountEnvironment,
} from "../../src/lib/parsers/store-account.parser";
import { makeConfig, makeSettings } from "../helpers/fixtures";
import { makeLogger, settleCoresAfterEach } from "../helpers/services-harness";
import { makeRpcPair } from "../helpers/rpc-pair";
import { makeFakeNetwork } from "../helpers/fake-network";
import { FakeStoreHost, storeFixture } from "../helpers/fake-store-host";

const ITCH_KEY = "AbC123";

const host = new FakeStoreHost(({ url, init }) => {
  const u = new URL(url);
  if (u.host === "api.itch.io") {
    if (init.headers?.Authorization !== `Bearer ${ITCH_KEY}`) {
      return { body: storeFixture("itch", "invalid_key.json") };
    }
    if (u.pathname === "/profile") {
      return { body: storeFixture("itch", "profile.json") };
    }
    return {
      body: storeFixture(
        "itch",
        u.searchParams.get("page") === "1"
          ? "owned_keys_page1.json"
          : "owned_keys_empty.json",
      ),
    };
  }
  if (u.host === "auth.gog.com") {
    return u.searchParams.get("code") === "good-code"
      ? {
          body: {
            access_token: "access-1",
            refresh_token: "refresh-1",
            user_id: "48628349957132247",
            expires_in: 3600,
          },
        }
      : { status: 400, body: { error: "invalid_grant" } };
  }
  if (u.host === "users.gog.com") {
    return { body: storeFixture("gog", "user.json") };
  }
  if (u.pathname === "/account/getFilteredProducts") {
    return {
      body: storeFixture(
        "gog",
        u.searchParams.get("page") === "1"
          ? "products_page1.json"
          : "products_page2.json",
      ),
    };
  }
  return { status: 404 };
});

describe("store accounts over IPC", () => {
  const settled = settleCoresAfterEach(afterEach);
  const events: string[] = [];

  beforeEach(() => {
    setStoreHost(host);
    host.canRefresh = true;
    host.opened.length = 0;
    delete host.openLoginWindow;
    events.length = 0;
    fs.rmSync(paths.userSettings, { force: true });
    fs.rmSync(paths.userConfigurations, { force: true });
  });
  afterEach(async () => {
    for (const store of STORE_KEYS) {
      await refresh.deleteAccount(store);
    }
  });
  afterAll(() => setStoreHost(readOnlyStoreHost));

  async function makeService() {
    const core = new Core({
      logger: makeLogger().service,
      fetch: makeFakeNetwork(),
    });
    settled(core).start({ presets: false, refresh: false });
    const { host: hostSide, client } = makeRpcPair();
    hostCore(core, hostSide);
    const coreClient = new CoreClient(client);
    coreClient.on("stores:changed", ({ store }) => events.push(store));
    await core.ready.parsers;
    return { core, service: new StoresService({ client: coreClient } as any) };
  }

  // Lets events cross (they're delivered on later turns).
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("itch.io: signs in with a pasted key, refreshes, signs out", async () => {
    const { service } = await makeService();
    const before = service.status("itch");
    expect(before).toMatchObject({
      store: "itch",
      available: true,
      signedIn: false,
      windowLogin: false,
      canRefresh: true,
      secretsWarning: false,
    });
    expect(before.paste?.instructions).toContain("API keys page");

    const paste = service.beginLogin("itch");
    expect(paste?.url).toBe("https://itch.io/user/settings/api-keys");
    await service.openSignInPage("itch");
    expect(host.opened).toEqual(["https://itch.io/user/settings/api-keys"]);

    await expect(service.submitPaste("itch", "not a key")).rejects.toThrow(
      "not an itch.io API key",
    );
    // A key itch.io refuses: the UI shows the store's words, without the
    // IPC wrapping or the error's kind (LoginRejected) in front of them.
    const refused = await service.submitPaste("itch", "WrongKey9").then(
      () => null,
      (err) => err,
    );
    expect(service.errorText(refused)).toBe(
      "itch.io rejected the API key (invalid key). Create a new key at https://itch.io/user/settings/api-keys and sign in again.",
    );
    expect(service.status("itch").signedIn).toBe(false);
    const message = await service.submitPaste("itch", ` ${ITCH_KEY}\n`);
    expect(message).toMatch(
      /^Signed in to itch\.io as leafo\. The account owns \d+ games\.$/,
    );
    await settle();
    expect(events).toContain("itch");

    const after = service.status("itch");
    expect(after).toMatchObject({
      signedIn: true,
      accountName: "leafo",
      lastError: null,
      needsSignIn: false,
      refreshing: false,
    });
    expect(after.gameCount).toBeGreaterThan(0);
    // No secret reaches the UI.
    expect(JSON.stringify(after)).not.toContain(ITCH_KEY);

    expect(await service.refresh("itch")).toMatch(
      /^itch\.io: the account owns \d+ games\.$/,
    );
    expect(await service.signOut("itch")).toBe("Signed out of itch.io.");
    expect(service.status("itch")).toMatchObject({
      signedIn: false,
      gameCount: null,
    });
  });

  it("GOG: signs in with the sign-in window; closing it is no error", async () => {
    const { service } = await makeService();
    expect(service.status("gog").windowLogin).toBe(false);
    await expect(service.loginWithWindow("gog")).rejects.toThrow(
      "can't open a sign-in window",
    );

    host.openLoginWindow = async () => {
      throw new LoginCancelled("Sign-in window closed");
    };
    expect(service.status("gog").windowLogin).toBe(true);
    expect(await service.loginWithWindow("gog")).toBeNull();
    expect(service.status("gog").signedIn).toBe(false);

    const asked: string[] = [];
    host.openLoginWindow = async (pending) => {
      asked.push(pending.startUrl);
      return {
        finalUrl:
          "https://embed.gog.com/on_login_success?origin=client&code=good-code",
      };
    };
    const message = await service.loginWithWindow("gog");
    expect(asked[0]).toMatch(/^https:\/\/auth\.gog\.com\/auth\?/);
    expect(message).toMatch(
      /^Signed in to GOG as .+\. The account owns \d+ games\.$/,
    );
    expect(service.status("gog")).toMatchObject({
      signedIn: true,
      lastError: null,
    });
  });

  it("a second sign-in while the window is open shows it again and completes the login once", async () => {
    const { service } = await makeService();
    const asked: unknown[] = [];
    let close!: (capture: { finalUrl: string }) => void;
    const window = new Promise<{ finalUrl: string }>((resolve) => {
      close = resolve;
    });
    host.openLoginWindow = (pending) => {
      asked.push(pending);
      return window;
    };
    host.requests.length = 0;
    // (another parser editor of the same store, with its own Sign in)
    const first = service.loginWithWindow("gog");
    const second = service.loginWithWindow("gog");
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1]).toBe(asked[0]);
    close({
      finalUrl:
        "https://embed.gog.com/on_login_success?origin=client&code=good-code",
    });
    const [one, two] = await Promise.all([first, second]);
    expect(one).toMatch(
      /^Signed in to GOG as .+\. The account owns \d+ games\.$/,
    );
    expect(two).toBe(one);
    // The single-use code went to GOG once.
    expect(
      host.requests.filter(
        (request) => new URL(request.url).host === "auth.gog.com",
      ),
    ).toHaveLength(1);

    // Done: the next sign-in is a new one, with a window of its own.
    host.openLoginWindow = async (pending) => {
      asked.push(pending);
      throw new LoginCancelled("Sign-in window closed");
    };
    expect(await service.loginWithWindow("gog")).toBeNull();
    expect(asked).toHaveLength(3);
  });

  it("a cookie store's sign-in window closed before the end leaves nothing in its partition", async () => {
    const { service } = await makeService();
    const cleared: string[] = [];
    host.clearStoreData = async (store) => {
      cleared.push(store);
    };
    try {
      host.openLoginWindow = async () => {
        throw new LoginCancelled("Sign-in window closed");
      };
      expect(await service.loginWithWindow("ea")).toBeNull();
      // (a token store's window threw its partition away itself)
      expect(await service.loginWithWindow("gog")).toBeNull();
      expect(cleared).toEqual(["ea"]);
    } finally {
      delete host.clearStoreData;
    }
  });

  it("stores that come later say so; unknown stores are refused", async () => {
    const { service } = await makeService();
    const epic = storeClient("epic");
    unregisterStoreClient("epic");
    try {
      expect(service.status("epic")).toMatchObject({
        available: false,
        windowLogin: false,
        paste: null,
      });
      await expect(service.refresh("epic")).rejects.toThrow(
        "comes with a later version of SRM",
      );
    } finally {
      if (epic) {
        registerStoreClient(epic);
      }
    }
    expect(() => service.status("steam")).toThrow("Unknown store: steam");
  });

  it("every store's account is available, with its own way to sign in", async () => {
    const { service } = await makeService();
    host.openLoginWindow = async () => {
      throw new LoginCancelled("Sign-in window closed");
    };
    const ways = Object.fromEntries(
      STORE_KEYS.map((store) => {
        const status = service.status(store);
        expect(status.available).toBe(true);
        return [store, { window: status.windowLogin, paste: !!status.paste }];
      }),
    );
    expect(ways).toEqual({
      epic: { window: true, paste: true },
      gog: { window: true, paste: true },
      amazon: { window: true, paste: true },
      ea: { window: true, paste: false },
      battlenet: { window: true, paste: false },
      humble: { window: true, paste: true },
      itch: { window: false, paste: true },
    });
    // The instructions come in the UI's language (langStrings only), one
    // set per store that signs in by a paste.
    for (const store of STORE_KEYS.filter((key) => ways[key].paste)) {
      const paste = service.status(store).paste!;
      expect(paste.instructions).not.toBe("");
      expect(paste.placeholder).not.toBe("");
    }
    expect(service.status("humble").paste?.instructions).toContain(
      "Cookie request header",
    );
  });

  it("at start, fetches the old libraries of the stores enabled parsers use, unless offline", async () => {
    const config = (store: string, disabled = false) =>
      makeConfig({
        parserType: "Store Account",
        configTitle: store,
        parserId: store,
        parserInputs: { storeAccount: store },
        disabled,
      });
    fs.writeFileSync(
      paths.userConfigurations,
      JSON.stringify([config("itch"), config("gog", true)]),
    );
    // Signed in to both, libraries never fetched.
    await refresh.completeLogin(refresh.pendingLogin("itch"), {
      pasted: ITCH_KEY,
    });
    await refresh.completeLogin(refresh.pendingLogin("gog"), {
      pasted: "good-code",
    });
    fs.writeFileSync(
      paths.userSettings,
      JSON.stringify(makeSettings({ offlineMode: true })),
    );
    const offline = await makeService();
    expect(offline.core.stores.storesInUse()).toEqual(["itch"]);
    await offline.core.stores.refreshInBackground();
    expect(offline.service.status("itch").gameCount).toBeNull();

    fs.writeFileSync(
      paths.userSettings,
      JSON.stringify(makeSettings({ offlineMode: false })),
    );
    const online = await makeService();
    await online.core.stores.refreshInBackground();
    expect(online.service.status("itch").gameCount).toBeGreaterThan(0);
    // (its parser is disabled)
    expect(online.service.status("gog").gameCount).toBeNull();
  });

  it("offline mode keeps the Store Account parser off the network: it uses the games fetched before", async () => {
    await refresh.completeLogin(refresh.pendingLogin("itch"), {
      pasted: ITCH_KEY,
    });
    const fetched = await refresh.refreshLibrary("itch");
    expect(fetched.games.length).toBeGreaterThan(0);
    // Six hours and more later: old.
    refresh.setStoreClock(() => Date.now() + refresh.LIBRARY_MAX_AGE_MS * 2);
    setStoreAccountEnvironment({
      launchers: () => ({
        osType: "Linux",
        heroicStores: [],
        opener: "/usr/bin/xdg-open",
        flatpak: "/usr/bin/flatpak",
      }),
      installed: async () => [],
    });
    const parse = () =>
      new StoreAccountParser().execute([], {
        storeAccount: "itch",
        storeSkipPrereleases: false,
        storeSkipInstalledElsewhere: false,
        storeSkipSteamInstalled: false,
      });
    try {
      fs.writeFileSync(
        paths.userSettings,
        JSON.stringify(makeSettings({ offlineMode: true })),
      );
      await makeService();
      host.requests.length = 0;
      const offline = await parse();
      expect(host.requests).toEqual([]);
      expect(offline.success.map((s) => s.extractedTitle)).toEqual(
        fetched.games.map((g) => g.title),
      );

      // (the same, online: fetched again)
      fs.writeFileSync(
        paths.userSettings,
        JSON.stringify(makeSettings({ offlineMode: false })),
      );
      await makeService();
      await parse();
      expect(host.requests.length).toBeGreaterThan(0);
    } finally {
      refresh.setStoreClock();
      setStoreAccountEnvironment();
    }
  });
});
