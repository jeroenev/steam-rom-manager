// Store accounts: sign in to a game store, keep the session, and list every
// game the account owns, installed or not. Ported from BoilR's boilr-stores
// crate, which follows Playnite's library plugins.
//
// Nothing in src/lib/stores imports Electron: what needs it (encryption, the
// login window, the network stack) comes in through the StoreHost (host.ts).

import type { StoreHttp } from "./http";

// A store SRM can sign in to. The key names the store's folder and is stored
// in parser configurations: never change one. (The same keys as BoilR.)
export type StoreKey =
  | "epic"
  | "gog"
  | "amazon"
  | "ea"
  | "battlenet"
  | "humble"
  | "itch";

export const STORE_KEYS: readonly StoreKey[] = [
  "epic",
  "gog",
  "amazon",
  "ea",
  "battlenet",
  "humble",
  "itch",
];

export const STORE_NAMES: Readonly<Record<StoreKey, string>> = {
  epic: "Epic Games Store",
  gog: "GOG",
  amazon: "Amazon Games",
  ea: "EA app",
  battlenet: "Battle.net",
  humble: "Humble Bundle",
  itch: "itch.io",
};

export function isStoreKey(value: unknown): value is StoreKey {
  return (STORE_KEYS as readonly unknown[]).includes(value);
}

// The stores whose login is a browser's cookies rather than tokens: the app
// keeps them in a browser partition of their own, which renews them as a
// browser would. (The others keep tokens or a key in session.json.)
export const COOKIE_STORES: readonly StoreKey[] = ["ea", "battlenet", "humble"];

// One game the account owns.
export interface OwnedGame {
  store: StoreKey;
  // The store's own id for the game, the one its launcher (and SRM's parser
  // for that launcher) uses, so an owned game and its installed copy can be
  // matched: Epic appName, GOG product id, Amazon product id, EA offer id,
  // Battle.net launcher code, Humble subproduct id (the old machine_name
  // where the site still sends one), itch game id.
  id: string;
  title: string;
  // What the install target needs besides the id; the keys are listed in
  // each store's module (e.g. Epic's namespace, a GOG slug, an itch url).
  extra: Record<string, string>;
}

// The owned games of one account, as last fetched (library.json).
export interface OwnedLibrary {
  accountName: string | null;
  // When it was fetched, in milliseconds since 1970.
  fetchedAt: number;
  games: OwnedGame[];
  // Some games couldn't be looked up (a catalog service was down): the list
  // is good to use, and is fetched again sooner (see refresh.ts).
  partial: boolean;
}

// A signed-in account. `data` belongs to the store's module (tokens, ids)
// and is stored encrypted; the account name is not a secret.
export interface StoreSession {
  accountName: string | null;
  data: { [key: string]: any };
}

// A cookie: from a login window, a store's browser partition, or a paste.
// Its value is secret: never log it.
export interface StoreCookie {
  name: string;
  value: string;
  domain: string;
}

// How a login can be finished without SRM's login window: the user signs
// in with their own browser and pastes one value back.
export type ManualLogin =
  | { kind: "unsupported" }
  | {
      kind: "paste";
      // The page to open in the browser.
      url: string;
      instructions: string;
      placeholder: string;
    };

// Everything a host needs to run a login, plus the state the store needs to
// finish it.
export interface PendingLogin {
  store: StoreKey;
  // Where the login window starts.
  startUrl: string;
  // The login is done once the window navigates to a URL starting with one
  // of these. The window doesn't load it: it hands it over as
  // LoginCapture.finalUrl. Empty: this store has no login window.
  doneUrlPrefixes: string[];
  // A done URL starting with one of these IS loaded, and the page's text is
  // handed over as LoginCapture.pageText (Epic's done page is JSON).
  pageTextUrlPrefixes: string[];
  // URLs whose cookies the window hands over when the login is done.
  cookieUrls: string[];
  manual: ManualLogin;
  // The user agent the login window uses, when the store needs a particular
  // one; otherwise the browser's own, without Electron's tokens.
  userAgent?: string;
  // Store-private state carried from beginLogin to completeLogin (e.g. a
  // PKCE verifier). Secret: never log it.
  state: { [key: string]: any };
}

// What a login produced: from the window (finalUrl, pageText, cookies) or
// from the user (pasted). Secret: never log it.
export interface LoginCapture {
  finalUrl?: string;
  pageText?: string;
  cookies?: StoreCookie[];
  pasted?: string;
}

// The state of one store account, for display.
export interface AccountStatus {
  store: StoreKey;
  name: string;
  // Whether this version of SRM can sign in to this store yet.
  available: boolean;
  signedIn: boolean;
  accountName: string | null;
  gameCount: number | null;
  fetchedAt: number | null;
  partial: boolean;
  // How to sign in without the login window. Its url is only for display:
  // open the one pendingLogin() returns, which can be tied to the login in
  // progress.
  manual: ManualLogin;
  // Whether SRM's login window can sign in to this store.
  webviewLogin: boolean;
  // Why the last refresh failed, while none has worked since.
  lastError: string | null;
  // The store no longer accepts the saved login: sign in again.
  needsSignIn: boolean;
  // A refresh is running in this process.
  refreshing: boolean;
}

// What a store's module gets to talk to the store.
export interface StoreContext {
  http: StoreHttp;
  // Milliseconds since 1970 (tests set the clock).
  now(): number;
  // A warning for the log; secrets are taken out first.
  log(message: string): void;
  // Cookie stores, where the host has their browser partitions: the cookies
  // the partition sends to `url`, values included (Battle.net's XSRF-TOKEN).
  // Secret: never log them.
  cookies?(url: string): Promise<StoreCookie[]>;
  // Cookie stores, where the host has their browser partitions: puts cookies
  // (a pasted sign-in) into the store's partition.
  setCookies?(cookies: StoreCookie[]): Promise<void>;
}

// What listLibrary gets besides the session.
export interface ListContext extends StoreContext {
  // The games of the last list of this same account (empty on a first
  // fetch): a module carries over what it couldn't look up this time.
  previous: readonly OwnedGame[];
  // Saves a session whose tokens were just renewed, before the games are
  // listed: GOG and Epic end the old refresh token when it's used, so the
  // new one must survive SRM closing during a long fetch. Fails (account
  // changed) when the user signed out or in again meanwhile.
  checkpoint(session: StoreSession): Promise<void>;
}

export interface ListResult {
  games: OwnedGame[];
  // See OwnedLibrary.partial.
  partial?: boolean;
}

// What every store's module implements. Modules are stateless: everything
// they keep is in the session.
export interface StoreClient {
  readonly key: StoreKey;
  // A new login. (refresh.ts keeps one per store until it's finished.)
  beginLogin(): PendingLogin;
  // Finishes a login: the session to save.
  completeLogin(
    pending: PendingLogin,
    capture: LoginCapture,
    ctx: StoreContext,
  ): Promise<StoreSession>;
  // Renews short-lived tokens (token stores). listLibrary calls it itself
  // when the tokens are about to expire or the store refuses them.
  refreshSession?(
    session: StoreSession,
    ctx: StoreContext,
  ): Promise<StoreSession>;
  // Lists the owned games. May update `session` in place (renewed tokens,
  // the account name): the refresh saves it, also when listing fails.
  listLibrary(session: StoreSession, ctx: ListContext): Promise<ListResult>;
  // Tells the store SRM's login is no longer needed, where it has a way.
  signOut?(session: StoreSession, ctx: StoreContext): Promise<void>;
}

export function ownedGame(
  store: StoreKey,
  id: string,
  title: string,
  extra: Record<string, string> = {},
): OwnedGame {
  return { store, id, title, extra };
}
