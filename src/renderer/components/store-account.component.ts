import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  OnDestroy,
} from "@angular/core";
import { StoresService } from "../services/stores.service";
import type { PasteLogin, StoreAccountView } from "../../core/stores-store";
import { isStoreKey } from "../../lib/stores/types";
import { APP } from "../../variables";

// A store account in the parser editor (a Store Account parser's "account"
// input): who is signed in, how many games the account owns and when they
// were fetched, what went wrong last; and sign in, sign in with the
// browser (then paste what the store shows) or use the store's launcher on
// this PC, refresh, sign out. It follows
// the account as it changes (a refresh in the background, another parser
// of the same store).
@Component({
  selector: "ng-store-account",
  templateUrl: "../templates/store-account.component.html",
  styleUrls: ["../styles/store-account.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StoreAccountComponent implements OnChanges, OnDestroy {
  @Input() store: string | null = null;
  status: StoreAccountView | null = null;
  busy = false;
  // What the last action came to.
  message: { text: string; error: boolean } | null = null;
  // The sign-in with the user's browser, while its paste box is open.
  paste: PasteLogin | null = null;
  pasted = "";
  private stopListening: () => void;

  constructor(
    private stores: StoresService,
    private changeRef: ChangeDetectorRef,
  ) {
    this.stopListening = this.stores.onChange((store) => {
      if (store === this.store) {
        this.reload();
      }
    });
  }

  get lang() {
    return APP.lang.stores.component;
  }

  ngOnChanges() {
    this.paste = null;
    this.pasted = "";
    this.message = null;
    this.reload();
  }

  ngOnDestroy() {
    this.stopListening();
  }

  // When the games were fetched, in the user's terms.
  fetchedWhen(fetchedAt: number | null) {
    return fetchedAt ? new Date(fetchedAt).toLocaleString() : "";
  }

  signIn() {
    this.run(() => this.stores.loginWithWindow(this.store));
  }

  // Uses the account the store's launcher on this PC is signed in to.
  signInLocally() {
    this.run(() => this.stores.loginLocally(this.store));
  }

  // Opens the sign-in page in the browser and the box for what the store
  // shows after it.
  signInWithBrowser() {
    this.run(async () => {
      this.paste = this.stores.beginLogin(this.store);
      this.pasted = "";
      if (this.paste) {
        await this.stores.openSignInPage(this.store);
      }
      return null;
    });
  }

  openSignInPage() {
    this.run(async () => {
      await this.stores.openSignInPage(this.store);
      return null;
    });
  }

  submitPaste() {
    const pasted = this.pasted.trim();
    if (!pasted) {
      return;
    }
    this.run(async () => {
      const text = await this.stores.submitPaste(this.store, pasted);
      this.paste = null;
      this.pasted = "";
      return text;
    });
  }

  cancelPaste() {
    this.paste = null;
    this.pasted = "";
  }

  refresh() {
    this.run(() => this.stores.refresh(this.store));
  }

  signOut() {
    this.run(async () => {
      const text = await this.stores.signOut(this.store);
      this.paste = null;
      return text;
    });
  }

  private reload() {
    try {
      this.status = isStoreKey(this.store)
        ? this.stores.status(this.store)
        : null;
    } catch (e) {
      this.status = null;
      this.message = { text: this.stores.errorText(e), error: true };
    }
    this.changeRef.markForCheck();
  }

  private async run(action: () => Promise<string | null>) {
    if (this.busy || !isStoreKey(this.store)) {
      return;
    }
    const store = this.store;
    this.busy = true;
    this.message = null;
    this.changeRef.markForCheck();
    try {
      const text = await action();
      if (text && store === this.store) {
        this.message = { text, error: false };
      }
    } catch (e) {
      if (store === this.store) {
        this.message = { text: this.stores.errorText(e), error: true };
      }
    } finally {
      this.busy = false;
      this.reload();
    }
  }
}
