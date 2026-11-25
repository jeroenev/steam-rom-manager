import { Injectable } from "@angular/core";
import { CoreClientService } from "./core-client.service";
import type { PasteLogin, StoreAccountView } from "../../core/stores-store";

// The store accounts of Store Account parsers, owned by the StoresStore in
// the main process. Sign-ins happen there (SRM's sign-in window, or the
// user's browser and a pasted value): the UI never holds a secret.
@Injectable()
export class StoresService {
  private listeners = new Set<(store: string) => void>();

  constructor(private coreClient: CoreClientService) {
    this.coreClient.client.on("stores:changed", ({ store }) => {
      for (const listener of this.listeners) {
        listener(store);
      }
    });
  }

  private call(method: string, ...args: any[]) {
    return this.coreClient.client.call("stores", method, ...args);
  }

  // Tells `listener` which store's account changed.
  onChange(listener: (store: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(store: string): StoreAccountView {
    return this.coreClient.client.callSync("stores", "status", store);
  }

  beginLogin(store: string): PasteLogin | null {
    return this.coreClient.client.callSync("stores", "beginLogin", store);
  }

  // What to tell the user; null when they closed the sign-in window.
  loginWithWindow(store: string): Promise<string | null> {
    return this.call("loginWithWindow", store);
  }

  openSignInPage(store: string): Promise<void> {
    return this.call("openSignInPage", store);
  }

  submitPaste(store: string, pasted: string): Promise<string> {
    return this.call("submitPaste", store, pasted);
  }

  loginLocally(store: string): Promise<string> {
    return this.call("loginLocally", store);
  }

  refresh(store: string): Promise<string> {
    return this.call("refresh", store);
  }

  signOut(store: string): Promise<string> {
    return this.call("signOut", store);
  }

  // A failed call's message, without Electron's "Error invoking remote
  // method" wrapping.
  errorText(e: unknown) {
    return String((e as any)?.message ?? e).replace(
      /^Error invoking remote method '[^']*': (Error: )?/,
      "",
    );
  }
}
