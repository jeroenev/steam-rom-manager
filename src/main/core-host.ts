import { ipcMain, BrowserWindow, IpcMain } from "electron";
import { Core } from "../core/core";
import {
  HostTransport,
  createForwardingLogger,
  hostCore,
} from "../core/rpc-host";
import { rpcChannels } from "../core/rpc";
import { appTarget } from "./app-target";

// Whether an IPC message comes from SRM's own window. Other windows (a
// store's sign-in page) have no preload and so no IPC, but that is not to
// be relied on: what they send is refused here too.
export function isFromWindow(
  event: { sender: unknown },
  getWindow: () => BrowserWindow | null,
) {
  const window = getWindow();
  return (
    !!window && !window.isDestroyed() && event.sender === window.webContents
  );
}

// The IPC side of the window's connection to the Core: only SRM's window
// may call. Events are queued until the window's UI connects.
export function windowTransport(
  ipc: Pick<IpcMain, "handle" | "on">,
  getWindow: () => BrowserWindow | null,
): HostTransport {
  let connected = false;
  const queue: [string, any][] = [];
  const send = (channel: string, payload: any) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  };
  const refused = "Not allowed: only SRM's window can use SRM";
  return {
    handleAsync: (channel, handler) =>
      ipc.handle(channel, (event, req) => {
        if (!isFromWindow(event, getWindow)) {
          throw new Error(refused);
        }
        return handler(req);
      }),
    handleSync: (channel, handler) =>
      ipc.on(channel, (event, req) => {
        if (!isFromWindow(event, getWindow)) {
          event.returnValue = { error: refused, seq: 0 };
          return;
        }
        if (!connected) {
          connected = true;
          setImmediate(() => {
            for (const [ch, payload] of queue.splice(0)) send(ch, payload);
          });
        }
        event.returnValue = handler(req);
      }),
    send: (channel, payload) => {
      if (connected) send(channel, payload);
      else queue.push([channel, payload]);
    },
  };
}

// Creates the GUI's Core in this (main) process and serves it to the
// window over IPC.
export function startCoreForWindow(getWindow: () => BrowserWindow | null) {
  const forwarding = createForwardingLogger();
  const core = new Core({ logger: forwarding.logger });
  core.start();
  core.fuzzy.startAutoSave();
  hostCore(core, windowTransport(ipcMain, getWindow), forwarding, {
    app: appTarget(getWindow),
  });
  return core;
}

export { rpcChannels };
