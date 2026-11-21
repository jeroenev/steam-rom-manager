// An in-memory stand-in for Electron IPC between a Core host and the UI.
// Every message is structured-cloned, as with real IPC, so anything that
// can't cross the process boundary (functions, class instances) fails here.
import { HostTransport } from "../../src/core/rpc-host";
import { ClientTransport } from "../../src/renderer/core-client";

export function makeRpcPair() {
  const asyncHandlers = new Map<string, (req: any) => Promise<any>>();
  const syncHandlers = new Map<string, (req: any) => any>();
  const listeners = new Map<string, Set<(payload: any) => void>>();

  const host: HostTransport = {
    handleAsync: (channel, handler) => asyncHandlers.set(channel, handler),
    handleSync: (channel, handler) => syncHandlers.set(channel, handler),
    send: (channel, payload) => {
      const copy = structuredClone(payload);
      setImmediate(() => {
        for (const listener of listeners.get(channel) ?? []) listener(copy);
      });
    },
  };
  const client: ClientTransport = {
    invoke: async (channel, req) => {
      let result: any;
      try {
        result = await asyncHandlers.get(channel)(structuredClone(req));
      } catch (err) {
        // As Electron: the main side replies with the error's toString(),
        // and ipcRenderer.invoke throws a new Error with it.
        throw new Error(`Error invoking remote method '${channel}': ${err}`);
      }
      return structuredClone(result);
    },
    sendSync: (channel, req) =>
      structuredClone(syncHandlers.get(channel)(structuredClone(req))),
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
    },
  };
  return { host, client };
}
