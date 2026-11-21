import {
  AccountStatus,
  ManualLogin,
  STORE_NAMES,
  StoreKey,
  accountStatus,
  completeLogin,
  forgetUnfinishedLogin,
  getStoreHost,
  hostRefreshes,
  isLoginCancelled,
  isStoreKey,
  onStoresChanged,
  pendingLogin,
  readSessionInfo,
  refreshIfStale,
  refreshLibrary,
  setLibraryMaxAge,
  setStoresOffline,
  signOut,
  storeClient,
} from "../lib/stores";
import { messageOf } from "../lib/stores/http";
import { Logger } from "../models";
import { APP } from "../variables";
import { ParsersStore } from "./parsers-store";
import { SettingsStore } from "./settings-store";

const HOUR_MS = 60 * 60 * 1000;

// A store account as the parser editor shows it (how to paste a sign-in
// is in `paste`).
export interface StoreAccountView extends Omit<AccountStatus, "manual"> {
  // This SRM fetches this store's library (the app does; its command line
  // only some).
  canRefresh: boolean;
  // SRM's sign-in window can be used.
  windowLogin: boolean;
  // How to sign in with the user's browser (in the UI's language), or null
  // when the store has no such way.
  paste: PasteLogin | null;
  // Sign-ins aren't safe at rest here (Linux without a keyring).
  secretsWarning: boolean;
}

export interface PasteLogin {
  // The sign-in page (only for display: openSignInPage opens the one tied
  // to the sign-in in progress).
  url: string;
  instructions: string;
  placeholder: string;
}

// A sign-in with SRM's window that is running.
interface WindowLogin {
  windowOpen: boolean;
  result: Promise<string | null>;
}

// The store accounts of the Store Account parsers: sign-in, the libraries
// and their refreshes (src/lib/stores does the work). One per Core.
export class StoresStore {
  // The sign-ins with SRM's window running, per store.
  private windowLogins = new Map<StoreKey, WindowLogin>();

  constructor(
    private logger: Logger,
    private settings: SettingsStore,
    private parsers: ParsersStore,
  ) {
    // (read when a library would be fetched by itself, so it's always the
    // setting as it is now: for the parsers' fetches and those at start)
    setStoresOffline(() => !!this.settings.get().offlineMode);
    // (not a number: the default)
    setLibraryMaxAge(
      () =>
        Number(this.settings.get().ownedGames?.libraryMaxAgeHours) * HOUR_MS,
    );
  }

  private get lang() {
    return APP.lang.stores.service;
  }

  private key(store: string): StoreKey {
    if (!isStoreKey(store)) {
      throw new Error(this.lang.unknownStore__i.interpolate({ store }));
    }
    return store;
  }

  // ---- state ----

  status(store: string): StoreAccountView {
    const key = this.key(store);
    const { manual, ...status } = accountStatus(key);
    const host = getStoreHost();
    let secretsWarning = false;
    try {
      secretsWarning = !!host.secretsWarning?.();
    } catch {
      // (only a warning)
    }
    return {
      ...status,
      canRefresh: hostRefreshes(host, key),
      windowLogin:
        status.available && status.webviewLogin && !!host.openLoginWindow,
      paste: status.available ? this.pasteLogin(key, manual) : null,
      secretsWarning,
    };
  }

  // Tells `listener` which store's account changed (sign-in, a refresh
  // starting or ending, sign-out); several changes in a row come as one.
  onChange(listener: (store: StoreKey) => void): () => void {
    const pending = new Set<StoreKey>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return onStoresChanged((store) => {
      pending.add(store);
      timer ??= setTimeout(() => {
        timer = undefined;
        const stores = [...pending];
        pending.clear();
        for (const changed of stores) {
          listener(changed);
        }
      }, 0);
    });
  }

  // ---- signing in and out ----

  // The sign-in through the user's browser for `store`, starting it (Amazon
  // ties its sign-in page to the sign-in in progress).
  beginLogin(store: string): PasteLogin | null {
    const key = this.key(store);
    return this.pasteLogin(key, pendingLogin(key).manual);
  }

  // Signs in with SRM's sign-in window, then fetches the games. Returns what
  // to tell the user, or null when they closed the window.
  //
  // One at a time per store: another "Sign in" while it runs (a new parser
  // editor of the same store) shows the window again and waits for the same
  // result, so the login is completed once (a store's login code can only
  // be used once).
  async loginWithWindow(store: string): Promise<string | null> {
    const key = this.key(store);
    const openWindow = getStoreHost().openLoginWindow;
    if (!openWindow) {
      throw new Error(this.lang.noLoginWindowHere);
    }
    const running = this.windowLogins.get(key);
    if (running) {
      // (only while it's open: once it has closed, asking again would open
      // another one, for another sign-in)
      if (running.windowOpen) {
        openWindow(pendingLogin(key)).catch(() => undefined);
      }
      return running.result;
    }
    const pending = pendingLogin(key);
    if (!pending.doneUrlPrefixes.length) {
      throw new Error(
        this.lang.noLoginWindow__i.interpolate({ store: STORE_NAMES[key] }),
      );
    }
    const entry: WindowLogin = { windowOpen: true, result: undefined! };
    entry.result = (async () => {
      let capture;
      try {
        capture = await openWindow(pending);
      } catch (err) {
        if (isLoginCancelled(err)) {
          // (a cookie store's window may have signed in before it was
          // closed)
          await forgetUnfinishedLogin(key);
          return null;
        }
        throw err;
      } finally {
        entry.windowOpen = false;
      }
      const name = await completeLogin(pending, capture);
      return this.afterSignIn(key, name);
    })();
    this.windowLogins.set(key, entry);
    const forget = () => {
      if (this.windowLogins.get(key) === entry) {
        this.windowLogins.delete(key);
      }
    };
    entry.result.then(forget, forget);
    return entry.result;
  }

  // Opens the sign-in page in the user's browser; the user pastes what the
  // store shows (submitPaste).
  async openSignInPage(store: string): Promise<void> {
    const key = this.key(store);
    const pending = pendingLogin(key);
    if (pending.manual.kind !== "paste") {
      throw new Error(
        this.lang.noBrowserLogin__i.interpolate({ store: STORE_NAMES[key] }),
      );
    }
    await getStoreHost().openExternal(pending.manual.url);
  }

  // Finishes a sign-in with what the user pasted, then fetches the games.
  async submitPaste(store: string, pasted: string): Promise<string> {
    const key = this.key(store);
    const pending = pendingLogin(key);
    const name = await completeLogin(pending, {
      pasted: String(pasted ?? "").trim(),
    });
    return this.afterSignIn(key, name);
  }

  // Fetches the games now (the user asked: a much shorter list is taken).
  async refresh(store: string): Promise<string> {
    const key = this.key(store);
    const library = await refreshLibrary(key);
    return this.lang.refreshed__i.interpolate({
      store: STORE_NAMES[key],
      count: library.games.length,
    });
  }

  // Signs out; returns what to tell the user (with a warning when the
  // store couldn't be told).
  async signOut(store: string): Promise<string> {
    const key = this.key(store);
    const warning = await signOut(key);
    return (
      warning ?? this.lang.signedOut__i.interpolate({ store: STORE_NAMES[key] })
    );
  }

  // A first fetch: what the account owns is what the user wants to know
  // next. A failed one doesn't undo the sign-in.
  private async afterSignIn(store: StoreKey, name: string | null) {
    const storeName = STORE_NAMES[store];
    const signedIn = name
      ? this.lang.signedInAs__i.interpolate({ store: storeName, name })
      : this.lang.signedIn__i.interpolate({ store: storeName });
    try {
      const library = await refreshLibrary(store);
      return `${signedIn} ${this.lang.gamesFound__i.interpolate({
        count: library.games.length,
      })}`;
    } catch (err) {
      return `${signedIn} ${this.lang.firstFetchFailed__i.interpolate({
        error: messageOf(err),
      })}`;
    }
  }

  // What to paste is only in langStrings (stores.paste), in the UI's
  // language: a store that signs in by a paste needs its entry there.
  private pasteLogin(store: StoreKey, manual: ManualLogin): PasteLogin | null {
    if (manual.kind !== "paste") {
      return null;
    }
    const paste = APP.lang.stores.paste as {
      instructions: Record<string, string | undefined>;
      placeholder: Record<string, string | undefined>;
    };
    return {
      url: manual.url,
      instructions: paste.instructions[store] ?? "",
      placeholder: paste.placeholder[store] ?? "",
    };
  }

  // ---- in the background ----

  // The stores the enabled Store Account parsers list.
  storesInUse(): StoreKey[] {
    const stores = new Set<StoreKey>();
    for (const config of this.parsers.getAll()) {
      const store = config.parserInputs?.storeAccount;
      if (
        !config.disabled &&
        config.parserType === "Store Account" &&
        isStoreKey(store)
      ) {
        stores.add(store);
      }
    }
    return [...stores];
  }

  // Fetches the libraries of the stores in use that got old, all at once,
  // without waiting for them (the app at start). Nothing in offline mode.
  // A failure is recorded with the account, which shows it.
  refreshInBackground(): Promise<void> {
    if (this.settings.get().offlineMode) {
      return Promise.resolve();
    }
    const host = getStoreHost();
    const refreshes = this.storesInUse()
      .filter(
        (store) =>
          !!storeClient(store) &&
          hostRefreshes(host, store) &&
          this.signedIn(store),
      )
      .map((store) =>
        refreshIfStale(store).then(
          () => undefined,
          (err) => this.logger.info(`${STORE_NAMES[store]}: ${messageOf(err)}`),
        ),
      );
    return Promise.all(refreshes).then(() => undefined);
  }

  private signedIn(store: StoreKey) {
    try {
      return !!readSessionInfo(store);
    } catch {
      return false;
    }
  }
}
