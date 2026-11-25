// The Ubisoft Connect store against the caches of the Ubisoft Connect signed
// in on this Windows machine: it decrypts them (DPAPI through PowerShell,
// then AES-GCM) and lists the account's games. Read-only; nothing is sent
// anywhere and nothing is saved. Prints titles and product ids only, never
// the user id. Opt-in, like the other live tests:
//   SRM_LIVE_UBISOFT=1
import { describe, expect, it } from "vitest";
import * as os from "os";
import { ubisoftClient } from "../../src/lib/stores/ubisoft";
import { ListContext } from "../../src/lib/stores/types";

describe.runIf(os.type() === "Windows_NT" && !!process.env.SRM_LIVE_UBISOFT)(
  "Ubisoft Connect's cache (this PC)",
  () => {
    it("lists the games of the account Ubisoft Connect signed in to last", async () => {
      const pending = ubisoftClient.beginLogin();
      expect(pending.manual).toEqual({ kind: "local" });
      const logged: string[] = [];
      const ctx = {
        now: () => Date.now(),
        log: (message: string) => logged.push(message),
        previous: [],
        checkpoint: async (): Promise<void> => undefined,
      } as unknown as ListContext;
      const session = await ubisoftClient.completeLogin(pending, {}, ctx);
      expect(session.accountName).toBeNull();
      const started = Date.now();
      const { games, fetchedAt } = await ubisoftClient.listLibrary(
        session,
        ctx,
      );
      expect(games.length).toBeGreaterThan(0);
      for (const game of games) {
        expect(game.id).toMatch(/^\d+$/);
        expect(game.title.trim()).not.toBe("");
        // (a localization key that wasn't resolved)
        expect(game.title).not.toMatch(/^(l\d+|NAME|GAMENAME)$/);
      }
      expect(fetchedAt).toBeLessThanOrEqual(Date.now());
      console.log(
        `${games.length} games in ${Date.now() - started} ms, cache of ${new Date(fetchedAt!).toISOString()}:\n` +
          games
            .map(
              (g) =>
                `  ${g.id}\t${g.title}${g.extra.space_id ? "" : "\t(no space_id)"}${g.extra.partner ? `\t(partner: ${g.extra.partner})` : ""}`,
            )
            .join("\n") +
          (logged.length ? `\nlog:\n  ${logged.join("\n  ")}` : ""),
      );
    });
  },
);
