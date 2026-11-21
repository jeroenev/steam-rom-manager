// A StoreHost for tests: answers requests from a handler (no network), keeps
// "encrypted" secrets in a readable form, and records what was asked.
import * as fs from "fs";
import * as path from "path";
import {
  StoreHost,
  StoreRequestInit,
  StoreResponse,
} from "../../src/lib/stores/host";
import {
  LoginCapture,
  PendingLogin,
  StoreKey,
} from "../../src/lib/stores/types";

export interface FakeAnswer {
  status?: number;
  // A string as it is, anything else as JSON.
  body?: unknown;
  // Where the request ended up (a redirect); the requested URL by default.
  url?: string;
  headers?: Record<string, string>;
}

export interface FakeRequest {
  store: StoreKey;
  url: string;
  init: StoreRequestInit;
}

export type FakeHandler = (
  request: FakeRequest,
) => FakeAnswer | Error | Promise<FakeAnswer | Error>;

export class FakeStoreHost implements StoreHost {
  canRefresh = true;
  // (set by tests that need them)
  refreshes?: (store: StoreKey) => boolean;
  openLoginWindow?: (pending: PendingLogin) => Promise<LoginCapture>;
  secretsWarning?: () => string | undefined;
  requests: FakeRequest[] = [];
  opened: string[] = [];
  logs: string[] = [];

  constructor(public handler: FakeHandler = () => ({ status: 404 })) {}

  fetchFor(store: StoreKey) {
    return async (url: string, init: StoreRequestInit = {}) => {
      const request = { store, url, init };
      this.requests.push(request);
      // An abort ends the request also while the handler is still at it, as
      // a real fetch's does.
      const signal = init.signal;
      const aborted = () =>
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("This operation was aborted");
      if (signal?.aborted) {
        throw aborted();
      }
      const answer = await new Promise<FakeAnswer | Error>(
        (resolve, reject) => {
          const onAbort = () => reject(aborted());
          signal?.addEventListener("abort", onAbort, { once: true });
          Promise.resolve(this.handler(request))
            .then(resolve, reject)
            .finally(() => signal?.removeEventListener("abort", onAbort));
        },
      );
      if (answer instanceof Error) {
        throw answer;
      }
      return response(answer, url);
    };
  }

  protect(plain: string) {
    return `fake:${Buffer.from(plain).toString("base64")}`;
  }

  unprotect(text: string) {
    if (!text.startsWith("fake:")) {
      throw new Error("not encrypted by this host");
    }
    return Buffer.from(text.slice(5), "base64").toString();
  }

  async openExternal(url: string) {
    this.opened.push(url);
  }

  log(message: string) {
    this.logs.push(message);
  }
}

export function response(answer: FakeAnswer, url: string): StoreResponse {
  const status = answer.status ?? 200;
  const body =
    typeof answer.body === "string"
      ? answer.body
      : answer.body === undefined
        ? ""
        : JSON.stringify(answer.body);
  const headers = Object.fromEntries(
    Object.entries(answer.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    url: answer.url ?? url,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

// A fixture from test/fixtures/stores, as text.
export function storeFixture(store: StoreKey, file: string) {
  return fs.readFileSync(
    path.join(__dirname, "..", "fixtures", "stores", store, file),
    "utf8",
  );
}
