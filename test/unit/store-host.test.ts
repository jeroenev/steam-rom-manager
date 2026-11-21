// The store accounts' host in the Electron app, with Electron faked: which
// cookies a request sends, and how a pasted sign-in is kept.
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const requests: any[] = [];
  const cookieCalls: string[] = [];
  // A net.request that answers 200 with an empty body once it's ended.
  const request = (options: any) => {
    requests.push(options);
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
  const fromPartition = (partition: string): any => ({
    cookies: {
      set: async (details: any) => {
        cookieCalls.push(`${partition} set ${details.name}`);
      },
      flushStore: async () => {
        cookieCalls.push(`${partition} flush`);
      },
    },
  });
  return {
    requests,
    cookieCalls,
    module: {
      app: { isPackaged: true },
      net: { request },
      session: { fromPartition },
      safeStorage: {},
      shell: {},
      BrowserWindow: class {},
    },
  };
});

vi.mock("electron", () => electron.module);
vi.mock("electron-log", () => ({ warn: (): void => undefined }));

import {
  PASTED_COOKIE_LIFETIME_S,
  electronStoreHost,
  pastedCookieDetails,
  requestThrough,
} from "../../src/main/store-host";

describe("the Electron store host", () => {
  beforeEach(() => {
    electron.requests.length = 0;
    electron.cookieCalls.length = 0;
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

  it("a pasted cookie outlives SRM and is out of the pages' scripts' reach", () => {
    const now = Date.UTC(2026, 10, 21, 12, 0, 0, 500);
    expect(
      pastedCookieDetails(
        { name: "_simpleauth_sess", value: "v", domain: ".humblebundle.com" },
        now,
      ),
    ).toEqual({
      url: "https://humblebundle.com/",
      name: "_simpleauth_sess",
      value: "v",
      domain: ".humblebundle.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expirationDate: Math.floor(now / 1000) + 365 * 24 * 60 * 60,
    });
    // A host's own cookie (a __Host- one can't name a domain).
    expect(
      pastedCookieDetails(
        { name: "__Host-x", value: "v", domain: "www.humblebundle.com" },
        now,
      ),
    ).toMatchObject({
      url: "https://www.humblebundle.com/",
      domain: undefined,
    });
    // (Chromium keeps no cookie longer than 400 days)
    expect(PASTED_COOKIE_LIFETIME_S).toBeLessThanOrEqual(400 * 24 * 60 * 60);
  });

  it("puts a pasted sign-in on disk at once, in the store's own partition", async () => {
    const host = electronStoreHost();
    await host.setCookies!("humble", [
      { name: "a", value: "1", domain: ".humblebundle.com" },
      { name: "b", value: "2", domain: ".humblebundle.com" },
    ]);
    expect(electron.cookieCalls).toEqual([
      "persist:srm-store-humble set a",
      "persist:srm-store-humble set b",
      "persist:srm-store-humble flush",
    ]);
  });
});
