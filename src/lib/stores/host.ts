// What the store code needs from the app around it, injected at start-up
// like setDefaultFetch (src/core/http.ts): the Electron main process gives
// safeStorage, its network stack and login windows; the standalone command
// line (plain Node) has none of those and uses cached libraries only; tests
// use a fake (test/helpers/fake-store-host.ts).

import { LoginCapture, PendingLogin, StoreCookie, StoreKey } from "./types";

// A response, as much of it as the stores read: unlike SRM's own Fetch, the
// stores need the URL a request ended up at (GOG answers a dead token with a
// redirect to its sign-in page) and the headers.
export interface StoreResponse {
  status: number;
  ok: boolean;
  // After redirects.
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface StoreRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type StoreFetch = (
  url: string,
  init?: StoreRequestInit,
) => Promise<StoreResponse>;

export interface StoreHost {
  // Whether this host may talk to the stores (sign in, refresh). The
  // standalone command line may not: it uses what the app last fetched.
  readonly canRefresh: boolean;
  // Whether it may refresh this store's library, when it can't refresh
  // every store (the app's command line has no cookie partitions, and may
  // be unable to read the window's sign-ins). Unset: every store.
  refreshes?(store: StoreKey): boolean;
  // The network for one store: token stores use the app's network stack,
  // cookie stores (EA, Battle.net, Humble) their own browser partition.
  fetchFor(store: StoreKey): StoreFetch;
  // Encrypts a secret for storage on disk, and back (Electron safeStorage).
  // Both throw where there is no secret storage.
  protect(plain: string): string;
  unprotect(protectedText: string): string;
  // Why secrets aren't safe at rest here, if they aren't (Linux without a
  // keyring: safeStorage's "basic_text"). Shown next to the account.
  secretsWarning?(): string | undefined;
  // Runs SRM's login window for a store; resolves when the done URL is
  // reached, rejects with LoginCancelled when the user closes the window.
  openLoginWindow?(pending: PendingLogin): Promise<LoginCapture>;
  // Opens a page in the user's browser.
  openExternal(url: string): Promise<void>;
  // Cookie stores: puts cookies (a pasted session) in the store's partition,
  // reads the ones it sends to `url` (values included: secret, never log
  // them), and empties it on sign-out.
  setCookies?(store: StoreKey, cookies: StoreCookie[]): Promise<void>;
  cookies?(store: StoreKey, url: string): Promise<StoreCookie[]>;
  clearStoreData?(store: StoreKey): Promise<void>;
  // A warning for the log (already without secrets).
  log?(message: string): void;
}

// The user closed the login window: no sign-in, and nothing went wrong.
export class LoginCancelled extends Error {
  name = "LoginCancelled";
}

export function isLoginCancelled(err: unknown) {
  return err instanceof Error && err.name === "LoginCancelled";
}

// Whether `host` may refresh this store's library.
export function hostRefreshes(host: StoreHost, store: StoreKey) {
  return host.canRefresh && (host.refreshes?.(store) ?? true);
}

const noSecrets = () => {
  throw new Error("This SRM can't read or keep store sign-ins.");
};

// Until a host is set, and for the standalone command line: no network, no
// secrets; cached libraries can still be read.
export const readOnlyStoreHost: StoreHost = {
  canRefresh: false,
  fetchFor: () => async () => {
    throw new Error("This SRM doesn't fetch store libraries.");
  },
  protect: noSecrets,
  unprotect: noSecrets,
  openExternal: async () => {
    throw new Error("This SRM can't open a browser.");
  },
};

let storeHost: StoreHost = readOnlyStoreHost;

export function setStoreHost(host: StoreHost) {
  storeHost = host;
}

export function getStoreHost(): StoreHost {
  return storeHost;
}
