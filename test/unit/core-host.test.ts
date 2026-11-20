// The window's IPC to the Core: only SRM's own window may call it. A store's
// sign-in page runs in a window too (with no preload, so no IPC at all);
// should a message come from it anyway, it is refused.
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { isFromWindow, windowTransport } from "../../src/main/core-host";
import { rpcChannels } from "../../src/core/rpc";

function fakeIpc() {
  const handlers = new Map<string, (event: any, req: any) => any>();
  return {
    handlers,
    ipc: {
      handle: (channel: string, handler: any) => handlers.set(channel, handler),
      on: (channel: string, handler: any) => handlers.set(channel, handler),
    } as any,
  };
}

function fakeWindow() {
  const sent: [string, any][] = [];
  return {
    sent,
    window: {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: any) => sent.push([channel, payload]),
      },
    } as any,
  };
}

describe("the window's IPC", () => {
  it("knows SRM's window from any other", () => {
    const { window } = fakeWindow();
    expect(isFromWindow({ sender: window.webContents }, () => window)).toBe(
      true,
    );
    expect(isFromWindow({ sender: {} }, () => window)).toBe(false);
    expect(isFromWindow({ sender: window.webContents }, () => null)).toBe(
      false,
    );
  });

  it("answers SRM's window and refuses other senders", async () => {
    const { ipc, handlers } = fakeIpc();
    const { window, sent } = fakeWindow();
    const transport = windowTransport(ipc, () => window);
    const calls: any[] = [];
    transport.handleAsync(rpcChannels.call, async (req) => {
      calls.push(req);
      return "done";
    });
    transport.handleSync(rpcChannels.callSync, (req) => {
      calls.push(req);
      return { result: "synced", seq: 1 };
    });
    const req = { target: "stores", method: "status", args: ["gog"] };

    const loginPage = { sender: { id: 99 } } as any;
    await expect(
      Promise.resolve().then(() =>
        handlers.get(rpcChannels.call)(loginPage, req),
      ),
    ).rejects.toThrow("only SRM's window");
    handlers.get(rpcChannels.callSync)(loginPage, req);
    expect(loginPage.returnValue).toEqual({
      error: "Not allowed: only SRM's window can use SRM",
      seq: 0,
    });
    expect(calls).toEqual([]);

    const ours = { sender: window.webContents } as any;
    expect(await handlers.get(rpcChannels.call)(ours, req)).toBe("done");
    handlers.get(rpcChannels.callSync)(ours, req);
    expect(ours.returnValue).toEqual({ result: "synced", seq: 1 });
    expect(calls).toEqual([req, req]);

    // Events wait for the window's UI to connect (its first sync call).
    transport.send(rpcChannels.event, { name: "ready" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([[rpcChannels.event, { name: "ready" }]]);
  });

  it("queues events until the window's UI connects", async () => {
    const { ipc, handlers } = fakeIpc();
    const { window, sent } = fakeWindow();
    const transport = windowTransport(ipc, () => window);
    transport.handleSync(rpcChannels.callSync, () => ({ result: 1, seq: 0 }));
    transport.send(rpcChannels.event, { name: "early" });
    expect(sent).toEqual([]);
    // (another window's call doesn't count as the UI connecting)
    handlers.get(rpcChannels.callSync)({ sender: {} }, {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([]);
    handlers.get(rpcChannels.callSync)({ sender: window.webContents }, {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([[rpcChannels.event, { name: "early" }]]);
  });
});
