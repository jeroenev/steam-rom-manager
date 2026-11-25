// The store accounts' host in the Electron app, with Electron faked: which
// cookies a request sends, how a pasted sign-in is kept, and how a cookie
// store's partition (in memory only) is saved with the session and put back
// after a restart or in the command line, with the core (refresh.ts) around
// it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// A cookie as Chromium's cookie store gives it.
interface FakeCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expirationDate?: number;
  sameSite: string;
}

const electron = vi.hoisted(() => {
  // Each partition's cookies, as Chromium keeps them in memory.
  const jars = new Map<string, FakeCookie[]>();
  const jar = (partition: string) => {
    let cookies = jars.get(partition);
    if (!cookies) {
      cookies = [];
      jars.set(partition, cookies);
    }
    return cookies;
  };
  const sameHost = (cookie: FakeCookie, host: string) => {
    const domain = cookie.domain.replace(/^\./, "");
    return cookie.hostOnly
      ? host === domain
      : host === domain || host.endsWith(`.${domain}`);
  };
  const calls: string[] = [];
  const state = {
    // Holds every cookie set until it's resolved (null: none held).
    setGate: null as Promise<void> | null,
    // Called when a set waits at the gate.
    atGate: (): void => undefined,
    // The safeStorage key isn't this SRM's (another machine, or the command
    // line's own on Windows).
    otherKey: false,
    // What a request does: answer 200, or never answer ("hang"). It may
    // set cookies first, as a store's answer does.
    onRequest: (_options: any): "answer" | "hang" => "answer",
  };
  const sessions = new Map<string, any>();
  const fromPartition = (partition: string): any => {
    let ses = sessions.get(partition);
    if (ses) {
      return ses;
    }
    ses = {
      partition,
      cookies: {
        get: async (filter: { url?: string }) => {
          let cookies = jar(partition);
          if (filter.url) {
            const url = new URL(filter.url);
            cookies = cookies.filter(
              (c) =>
                sameHost(c, url.hostname) && url.pathname.startsWith(c.path),
            );
          }
          return cookies.map((c) => ({ ...c }));
        },
        set: async (details: any) => {
          if (state.setGate) {
            state.atGate();
            await state.setGate;
          }
          calls.push(`${partition} set ${details.name}`);
          const url = new URL(details.url);
          if (details.secure && url.protocol !== "https:") {
            throw new Error("A secure cookie needs a secure URL");
          }
          if (details.name === "refused") {
            throw new Error("Chromium refuses this one");
          }
          const domain = details.domain
            ? details.domain.startsWith(".")
              ? details.domain
              : `.${details.domain}`
            : url.hostname;
          const cookie: FakeCookie = {
            name: details.name,
            value: details.value,
            domain,
            hostOnly: !details.domain,
            path: details.path ?? "/",
            secure: !!details.secure,
            httpOnly: !!details.httpOnly,
            session: details.expirationDate === undefined,
            sameSite: details.sameSite ?? "lax",
          };
          if (details.expirationDate !== undefined) {
            cookie.expirationDate = details.expirationDate;
          }
          const cookies = jar(partition);
          const same = cookies.findIndex(
            (c) =>
              c.name === cookie.name &&
              c.domain === cookie.domain &&
              c.path === cookie.path,
          );
          if (same >= 0) {
            cookies.splice(same, 1);
          }
          cookies.push(cookie);
        },
        remove: async (url: string, name: string) => {
          const host = new URL(url).hostname;
          const cookies = jar(partition);
          jars.set(
            partition,
            cookies.filter((c) => !(c.name === name && sameHost(c, host))),
          );
        },
        flushStore: async () => {
          calls.push(`${partition} flush`);
        },
      },
      clearStorageData: async (options?: { storages?: string[] }) => {
        if (!options?.storages || options.storages.includes("cookies")) {
          jars.set(partition, []);
        }
        calls.push(`${partition} clear`);
      },
      clearCache: async (): Promise<void> => undefined,
    };
    sessions.set(partition, ses);
    return ses;
  };

  const requests: any[] = [];
  // A net.request that answers 200 with an empty body once it's ended, or
  // never (state.onRequest). It records the cookies its partition had then.
  const request = (options: any) => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    return {
      on: (event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
      },
      setHeader: (): void => undefined,
      write: (): void => undefined,
      abort: (): void => undefined,
      followRedirect: (): void => undefined,
      end: (): void => {
        const partition = options.session?.partition;
        requests.push({
          ...options,
          cookies: partition
            ? jar(partition)
                .map((c) => c.name)
                .sort()
            : [],
        });
        if (state.onRequest(options) === "hang") {
          return;
        }
        const responseHandlers: Record<string, (...args: any[]) => void> = {};
        handlers.response?.({
          statusCode: 200,
          headers: {},
          on: (event: string, handler: (...args: any[]) => void) => {
            responseHandlers[event] = handler;
          },
        });
        responseHandlers.end?.();
      },
    };
  };

  // safeStorage: a reversible scramble, so nothing is in plain text.
  const scramble = (bytes: Buffer) => Buffer.from(bytes.map((b) => b ^ 0x5a));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    setUsePlainTextEncryption: (): void => undefined,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (plain: string) => scramble(Buffer.from(plain, "utf8")),
    decryptString: (encrypted: Buffer) => {
      if (state.otherKey) {
        throw new Error("Error while decrypting the ciphertext provided");
      }
      return scramble(encrypted).toString("utf8");
    },
  };

  return {
    jars,
    jar,
    calls,
    state,
    requests,
    fromPartition,
    module: {
      net: { request },
      session: { fromPartition },
      safeStorage,
      shell: {},
      BrowserWindow: class {},
    },
  };
});

vi.mock("electron", () => electron.module);
vi.mock("electron-log", () => ({ warn: (): void => undefined }));

import {
  cookieDetails,
  electronStoreHost,
  exportCookies,
  importCookies,
  pastedCookieDetails,
  requestThrough,
  storePartition,
} from "../../src/main/store-host";
import { STORE_KEYS, SavedCookie } from "../../src/lib/stores/types";

const LATER = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
const EARLIER = Math.floor(Date.now() / 1000) - 60;

// What the EA sign-in window leaves in EA's partition: EA's own cookies (one
// for accounts.ea.com's /connect only, one for all of ea.com, kept only
// until the browser closes) and a Google single sign-on's.
async function signInWindowCookies() {
  const ses = electron.fromPartition("srm-store-ea");
  await ses.cookies.set({
    url: "https://accounts.ea.com/connect",
    name: "remid",
    value: "remid-secret",
    path: "/connect",
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction",
    expirationDate: LATER,
  });
  await ses.cookies.set({
    url: "https://www.ea.com/",
    domain: ".ea.com",
    name: "sid",
    value: "sid-secret",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
  await ses.cookies.set({
    url: "https://accounts.google.com/",
    domain: ".google.com",
    name: "SID",
    value: "google-secret",
    secure: true,
    httpOnly: true,
  });
}

// EA's cookies as the window left them (Chromium's view).
const EA_COOKIES: FakeCookie[] = [
  {
    name: "remid",
    value: "remid-secret",
    domain: "accounts.ea.com",
    hostOnly: true,
    path: "/connect",
    secure: true,
    httpOnly: true,
    session: false,
    expirationDate: LATER,
    sameSite: "no_restriction",
  },
  {
    name: "sid",
    value: "sid-secret",
    domain: ".ea.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    session: true,
    sameSite: "lax",
  },
];

const byName = <T extends { name: string }>(cookies: T[]) =>
  [...cookies].sort((a, b) => a.name.localeCompare(b.name));

// SRM starting: fresh modules (nothing known about any partition), and
// Chromium's memory empty. `commandLine`: the app's command line.
async function startSrm(options: { commandLine?: boolean } = {}) {
  vi.resetModules();
  electron.jars.clear();
  const storeHost = await import("../../src/main/store-host");
  const hostModule = await import("../../src/lib/stores/host");
  const refresh = await import("../../src/lib/stores/refresh");
  const storage = await import("../../src/lib/stores/storage");
  const registry = await import("../../src/lib/stores/registry");
  const host = storeHost.electronStoreHost(options);
  hostModule.setStoreHost(host);
  // EA's sign-in as it is (its sites), with a sign-in and a library that
  // only send a request.
  const ea = registry.storeClient("ea")!;
  const listed: { ended: boolean } = { ended: false };
  registry.registerStoreClient({
    ...ea,
    completeLogin: async () => ({
      accountName: "player",
      data: { signedInAt: 1 },
    }),
    listLibrary: async (_session, ctx) => {
      try {
        await ctx.http.send("https://service-aggregation-layer.juno.ea.com/");
        return { games: [{ store: "ea", id: "1", title: "Game", extra: {} }] };
      } finally {
        listed.ended = true;
      }
    },
  });
  return { host, refresh, storage, listed };
}

type Srm = Awaited<ReturnType<typeof startSrm>>;

async function signIn(srm: Srm) {
  await signInWindowCookies();
  await srm.refresh.completeLogin(srm.refresh.pendingLogin("ea"), {
    cookies: [
      { name: "remid", value: "remid-secret", domain: "accounts.ea.com" },
    ],
  });
}

// Waits until the refresh's work, still running after it was stopped, has
// committed (or not) what it had.
async function settled(srm: Srm) {
  for (let i = 0; i < 200 && !srm.listed.ended; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  await srm.storage.withAccountLock("ea", () => undefined);
}

describe("the Electron store host", () => {
  beforeEach(() => {
    electron.requests.length = 0;
    electron.calls.length = 0;
    electron.jars.clear();
    electron.state.setGate = null;
    electron.state.otherKey = false;
    electron.state.onRequest = () => "answer";
  });

  it("a request sends the partition's cookies, unless it carries its own", async () => {
    const ses = { partition: "srm-store-epic" } as any;
    const fetch = requestThrough(ses);
    const answer = await fetch("https://www.epicgames.com/id/api/redirect", {
      headers: { Cookie: "a=1" },
      credentials: "omit",
    });
    expect(answer.ok).toBe(true);
    await fetch("https://library-service.live.use1a.on.epicgames.com/");
    expect(electron.requests.map((r) => r.credentials)).toEqual([
      "omit",
      "include",
    ]);
    expect(electron.requests.every((r) => r.session === ses)).toBe(true);
  });

  it("every store's partition is in memory only", () => {
    for (const store of STORE_KEYS) {
      expect(storePartition(store)).toBe(`srm-store-${store}`);
    }
    // (and nothing names a partition Chromium keeps on disk)
    const src = path.join(__dirname, "..", "..", "src");
    for (const dir of ["main", path.join("lib", "stores")]) {
      for (const file of fs.readdirSync(path.join(src, dir))) {
        if (file.endsWith(".ts")) {
          const code = fs.readFileSync(path.join(src, dir, file), "utf8");
          expect(code, file).not.toContain("persist:");
        }
      }
    }
  });

  it("a pasted cookie is out of the pages' scripts' reach, as a session cookie", () => {
    expect(
      pastedCookieDetails({
        name: "_simpleauth_sess",
        value: "v",
        domain: ".humblebundle.com",
      }),
    ).toEqual({
      url: "https://humblebundle.com/",
      name: "_simpleauth_sess",
      value: "v",
      domain: ".humblebundle.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
    // A host's own cookie (a __Host- one can't name a domain).
    const own = pastedCookieDetails({
      name: "__Host-x",
      value: "v",
      domain: "www.humblebundle.com",
    });
    expect(own).toMatchObject({ url: "https://www.humblebundle.com/" });
    expect(own).not.toHaveProperty("domain");
  });

  it("puts a pasted sign-in in the store's own partition", async () => {
    const host = electronStoreHost();
    await host.setCookies!("humble", [
      { name: "a", value: "1", domain: ".humblebundle.com" },
      { name: "b", value: "2", domain: ".humblebundle.com" },
    ]);
    expect(electron.calls).toEqual([
      "srm-store-humble set a",
      "srm-store-humble set b",
    ]);
  });

  it("exports a store's own cookies and imports them back as they were: host-only and domain, session and persistent", async () => {
    await signInWindowCookies();
    const saved = await exportCookies(electron.fromPartition("srm-store-ea"), [
      "ea.com",
    ]);
    // Google's single sign-on isn't the store's.
    expect(byName(saved)).toEqual<SavedCookie[]>([
      {
        name: "remid",
        value: "remid-secret",
        domain: "accounts.ea.com",
        hostOnly: true,
        path: "/connect",
        secure: true,
        httpOnly: true,
        sameSite: "no_restriction",
        expirationDate: LATER,
      },
      {
        name: "sid",
        value: "sid-secret",
        domain: ".ea.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      },
    ]);
    // A host-only cookie goes back without a domain, a domain cookie with
    // its own; a session cookie without an expiry.
    expect(cookieDetails(saved.find((c) => c.name === "remid")!)).toEqual({
      url: "https://accounts.ea.com/connect",
      name: "remid",
      value: "remid-secret",
      path: "/connect",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
      expirationDate: LATER,
    });
    const sid = cookieDetails(saved.find((c) => c.name === "sid")!);
    expect(sid).toMatchObject({ url: "https://ea.com/", domain: ".ea.com" });
    expect(sid).not.toHaveProperty("expirationDate");

    // Into another partition (SRM started again): the same cookies.
    const fresh = electron.fromPartition("srm-store-restarted");
    await fresh.cookies.set({ url: "https://www.ea.com/", name: "stale" });
    await importCookies(fresh, saved);
    expect(byName(electron.jar("srm-store-restarted"))).toEqual(EA_COOKIES);
  });

  it("leaves out an expired cookie, and one Chromium refuses", async () => {
    const cookie = (name: string, expirationDate?: number): SavedCookie => ({
      name,
      value: "v",
      domain: ".ea.com",
      hostOnly: false,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      ...(expirationDate === undefined ? {} : { expirationDate }),
    });
    const ses = electron.fromPartition("srm-store-ea");
    const now = Date.UTC(2026, 10, 21);
    await importCookies(
      ses,
      [
        cookie("expired", now / 1000 - 1),
        cookie("refused"),
        cookie("valid", now / 1000 + 60),
        cookie("session"),
      ],
      now,
    );
    expect(electron.jar("srm-store-ea").map((c) => c.name)).toEqual([
      "valid",
      "session",
    ]);
  });

  describe("with the core", () => {
    let srm: Srm;
    afterEach(async () => {
      electron.state.setGate = null;
      electron.state.onRequest = () => "answer";
      await srm?.refresh.deleteAccount("ea");
    });

    it("a sign-in is saved, encrypted, with the session, and back in the partition before the first request after a restart", async () => {
      srm = await startSrm();
      await signIn(srm);
      // On disk only encrypted, and only EA's cookies.
      const onDisk = fs.readFileSync(srm.storage.sessionFile("ea"), "utf8");
      for (const secret of ["remid-secret", "sid-secret", "google-secret"]) {
        expect(onDisk).not.toContain(secret);
      }
      const saved = srm.storage.loadSessionCookies("ea", srm.host)!;
      expect(byName(saved.cookies).map((c) => [c.name, c.hostOnly])).toEqual([
        ["remid", true],
        ["sid", false],
      ]);

      // SRM starts again: Chromium kept nothing.
      srm = await startSrm();
      expect(electron.jar("srm-store-ea")).toEqual([]);
      await srm.refresh.refreshLibrary("ea");
      // The first request already sent the sign-in, session cookie included.
      expect(electron.requests[0].cookies).toEqual(["remid", "sid"]);
      expect(byName(electron.jar("srm-store-ea"))).toEqual(EA_COOKIES);
      // Put back once: the next refresh goes on with what the partition has.
      electron.calls.length = 0;
      await srm.refresh.refreshLibrary("ea");
      expect(electron.calls).toEqual([]);
    });

    it("a refresh saves the cookies the store renewed, keeping the session's rev; another SRM's are put back", async () => {
      srm = await startSrm();
      await signIn(srm);
      const before = srm.storage.readSessionInfo("ea")!;
      // EA renews its session cookie as it hands out a token.
      electron.state.onRequest = (options) => {
        electron.jar(options.session.partition)[1] = {
          ...EA_COOKIES[1],
          value: "sid-renewed",
        };
        return "answer";
      };
      await srm.refresh.refreshLibrary("ea");
      const after = srm.storage.readSessionInfo("ea")!;
      expect(after.rev).toBe(before.rev);
      expect(after.cookiesRev).not.toBe(before.cookiesRev);
      const saved = srm.storage.loadSessionCookies("ea", srm.host)!.cookies;
      expect(saved.find((c) => c.name === "sid")?.value).toBe("sid-renewed");

      // Another SRM (the command line) saved newer cookies, one of which
      // has expired since: the next refresh puts them back first, but that
      // one.
      electron.state.onRequest = () => "answer";
      srm.storage.saveSessionCookies(
        "ea",
        [
          { ...saved[0], value: "from-the-command-line" },
          { ...saved[1], name: "old", expirationDate: EARLIER },
        ],
        srm.host,
      );
      await srm.refresh.refreshLibrary("ea");
      expect(electron.requests[electron.requests.length - 1].cookies).toEqual([
        saved[0].name,
      ]);
      expect(electron.jar("srm-store-ea")[0].value).toBe(
        "from-the-command-line",
      );
    });

    it("the command line refreshes a cookie store whose sign-in it can read", async () => {
      srm = await startSrm();
      await signIn(srm);
      srm = await startSrm({ commandLine: true });
      expect(srm.host.refreshes!("ea")).toBe(true);
      expect(srm.host.refreshes!("humble")).toBe(false); // (not signed in)
      expect((await srm.refresh.refreshLibrary("ea")).games).toHaveLength(1);
      expect(electron.requests[0].cookies).toEqual(["remid", "sid"]);
      // Another key (Windows: the command line's own) reads nothing.
      electron.state.otherKey = true;
      expect(srm.host.refreshes!("ea")).toBe(false);
    });

    it("signing out during a refresh brings nothing back, in the partition or on disk", async () => {
      srm = await startSrm();
      await signIn(srm);
      srm = await startSrm();
      // EA renews a cookie, then doesn't answer.
      electron.state.onRequest = (options) => {
        electron.jar(options.session.partition).push({
          ...EA_COOKIES[1],
          name: "renewed",
        });
        return "hang";
      };
      let requested: () => void;
      const sent = new Promise<void>((resolve) => (requested = resolve));
      const onRequest = electron.state.onRequest;
      electron.state.onRequest = (options) => {
        requested();
        return onRequest(options);
      };
      const refreshing = srm.refresh.refreshLibrary("ea");
      refreshing.catch(() => undefined);
      await sent;
      expect(await srm.refresh.signOut("ea")).toBeNull();
      await expect(refreshing).rejects.toSatisfy(srm.refresh.isAccountChanged);
      await settled(srm);
      expect(electron.jar("srm-store-ea")).toEqual([]);
      expect(fs.existsSync(srm.storage.sessionFile("ea"))).toBe(false);
    });

    it("signing out while the saved cookies are being put back brings nothing back", async () => {
      srm = await startSrm();
      await signIn(srm);
      srm = await startSrm();
      electron.state.onRequest = () => "hang";
      // Putting the cookies back stops halfway, until let go.
      let letGo: () => void;
      electron.state.setGate = new Promise<void>(
        (resolve) => (letGo = resolve),
      );
      let putting: () => void;
      const halfway = new Promise<void>((resolve) => (putting = resolve));
      electron.state.atGate = () => putting();
      const refreshing = srm.refresh.refreshLibrary("ea");
      refreshing.catch(() => undefined);
      await halfway;
      // (the sign-out waits for the cookies to be in, then empties it all)
      const signingOut = srm.refresh.signOut("ea");
      setTimeout(() => letGo(), 50);
      expect(await signingOut).toBeNull();
      await expect(refreshing).rejects.toSatisfy(srm.refresh.isAccountChanged);
      await settled(srm);
      expect(electron.jar("srm-store-ea")).toEqual([]);
      expect(fs.existsSync(srm.storage.sessionFile("ea"))).toBe(false);
    });

    it("a sign-in that doesn't finish leaves the partition empty, or with the account's saved cookies", async () => {
      srm = await startSrm();
      // Not signed in: what the window left goes.
      await signInWindowCookies();
      await srm.refresh.forgetUnfinishedLogin("ea");
      expect(electron.jar("srm-store-ea")).toEqual([]);

      // Signed in (signing in again): the account's cookies, as saved.
      await signIn(srm);
      const ses = electron.fromPartition("srm-store-ea");
      await ses.cookies.set({
        url: "https://www.ea.com/",
        domain: ".ea.com",
        name: "sid",
        value: "another-account",
        secure: true,
        httpOnly: true,
      });
      await srm.refresh.forgetUnfinishedLogin("ea");
      expect(byName(electron.jar("srm-store-ea"))).toEqual(EA_COOKIES);
    });
  });
});
