// Which stores this version of SRM can sign in to. A store comes in with one
// import and one line here; until then its account shows as "not yet".

import { amazonClient } from "./amazon";
import { battlenetClient } from "./battlenet";
import { eaClient } from "./ea";
import { epicClient } from "./epic";
import { gogClient } from "./gog";
import { itchClient } from "./itch";
import { StoreClient, StoreKey } from "./types";

const clients = new Map<StoreKey, StoreClient>();

export function registerStoreClient(client: StoreClient) {
  clients.set(client.key, client);
}

// Tests replace a store's client, and take it out again.
export function unregisterStoreClient(store: StoreKey) {
  clients.delete(store);
}

export function storeClient(store: StoreKey): StoreClient | undefined {
  return clients.get(store);
}

registerStoreClient(epicClient);
registerStoreClient(gogClient);
registerStoreClient(amazonClient);
registerStoreClient(eaClient);
registerStoreClient(battlenetClient);
registerStoreClient(itchClient);
