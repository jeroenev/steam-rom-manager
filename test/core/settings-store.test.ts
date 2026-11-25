import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as paths from "../../src/paths";
import { SettingsStore } from "../../src/core/settings-store";
import * as modifiers from "../../src/core/modifiers";
import { StoresStore } from "../../src/core/stores-store";
import { DEFAULT_OWNED_GAMES } from "../../src/models";
import {
  LIBRARY_MAX_AGE_MS,
  libraryMaxAgeMs,
  setLibraryMaxAge,
} from "../../src/lib/stores";
import { makeLogger } from "../helpers/services-harness";

describe("SettingsStore", () => {
  beforeEach(() => fs.rmSync(paths.userSettings, { force: true }));

  const errors = (log: { level: string }[]) =>
    log.filter((l) => l.level === "error");

  it("uses defaults without a settings file, and saves them", async () => {
    const { service: logger, log } = makeLogger();
    const store = new SettingsStore(logger);
    const settings = await store.load();
    expect((settings as any).version).toBe(modifiers.appSettings.latestVersion);
    expect(errors(log)).toEqual([]);
    settings.batchDownloadSize = 7;
    await store.save();
    const written = JSON.parse(fs.readFileSync(paths.userSettings, "utf8"));
    expect(written.batchDownloadSize).toBe(7);
  });

  it("keeps a valid file", async () => {
    fs.writeFileSync(
      paths.userSettings,
      JSON.stringify({
        version: modifiers.appSettings.latestVersion,
        offlineMode: true,
        batchDownloadSize: 12,
      }),
    );
    const store = new SettingsStore(makeLogger().service);
    const settings = await store.load();
    expect(settings.offlineMode).toBe(true);
    expect(settings.batchDownloadSize).toBe(12);
    expect(store.savingIsDisabled).toBe(false);
  });

  it("never overwrites a schema-invalid file", async () => {
    const original = JSON.stringify({
      version: modifiers.appSettings.latestVersion,
      batchDownloadSize: "lots",
    });
    fs.writeFileSync(paths.userSettings, original);
    const { service: logger, log } = makeLogger();
    const store = new SettingsStore(logger);
    await store.load();
    expect(errors(log).length).toBeGreaterThan(0);
    await store.save();
    expect(fs.readFileSync(paths.userSettings, "utf8")).toBe(original);
  });

  it("never overwrites an unreadable file (was: reset to defaults on next save)", async () => {
    fs.writeFileSync(paths.userSettings, '{ "offlineMode": tr');
    const { service: logger, log } = makeLogger();
    const store = new SettingsStore(logger);
    await store.load();
    expect(errors(log).length).toBeGreaterThan(0);
    await store.save();
    expect(fs.readFileSync(paths.userSettings, "utf8")).toBe(
      '{ "offlineMode": tr',
    );
  });

  describe("owned games (ownedGames)", () => {
    it("start with the defaults", async () => {
      const settings = await new SettingsStore(makeLogger().service).load();
      expect(settings.ownedGames).toEqual({
        storeOrder: [
          "gog",
          "epic",
          "amazon",
          "ea",
          "battlenet",
          "ubisoft",
          "humble",
          "itch",
        ],
        multiStore: "preferred",
        confirmAbove: 100,
        libraryMaxAgeHours: 6,
      });
      expect(settings.ownedGames).toEqual(DEFAULT_OWNED_GAMES);
      // (a copy: changing the settings leaves the defaults alone)
      settings.ownedGames.storeOrder.push("epic");
      expect(DEFAULT_OWNED_GAMES.storeOrder).toHaveLength(8);
    });

    it("settings from before them (version 11) get the defaults, and keep the rest", async () => {
      fs.writeFileSync(
        paths.userSettings,
        JSON.stringify({
          version: 11,
          offlineMode: true,
          batchDownloadSize: 12,
        }),
      );
      const store = new SettingsStore(makeLogger().service);
      const settings = await store.load();
      expect((settings as any).version).toBe(12);
      expect(settings.ownedGames).toEqual(DEFAULT_OWNED_GAMES);
      expect(settings.offlineMode).toBe(true);
      expect(settings.batchDownloadSize).toBe(12);
      expect(store.savingIsDisabled).toBe(false);
    });

    it("what a file sets is kept, the rest filled in", async () => {
      fs.writeFileSync(
        paths.userSettings,
        JSON.stringify({
          version: 11,
          ownedGames: { storeOrder: ["epic"], confirmAbove: 0 },
        }),
      );
      const settings = await new SettingsStore(makeLogger().service).load();
      expect(settings.ownedGames).toEqual({
        storeOrder: ["epic"],
        multiStore: "preferred",
        confirmAbove: 0,
        libraryMaxAgeHours: 6,
      });
      // (no object at all, from before: the defaults, and saving stays on)
      fs.writeFileSync(
        paths.userSettings,
        JSON.stringify({ version: 11, ownedGames: null }),
      );
      const store = new SettingsStore(makeLogger().service);
      expect((await store.load()).ownedGames).toEqual(DEFAULT_OWNED_GAMES);
      expect(store.savingIsDisabled).toBe(false);
    });

    it("a library's age before it's fetched again comes from them", async () => {
      fs.writeFileSync(
        paths.userSettings,
        JSON.stringify({
          version: modifiers.appSettings.latestVersion,
          ownedGames: { libraryMaxAgeHours: 2 },
        }),
      );
      const logger = makeLogger().service;
      const settings = new SettingsStore(logger);
      await settings.load();
      try {
        new StoresStore(logger, settings, {
          getAll: (): unknown[] => [],
        } as any);
        expect(libraryMaxAgeMs()).toBe(2 * 60 * 60 * 1000);
        // (the live setting)
        settings.get().ownedGames.libraryMaxAgeHours = 12;
        expect(libraryMaxAgeMs()).toBe(12 * 60 * 60 * 1000);
      } finally {
        setLibraryMaxAge(LIBRARY_MAX_AGE_MS);
      }
    });
  });

  it("notifies change listeners", async () => {
    const store = new SettingsStore(makeLogger().service);
    await store.load();
    const seen: number[] = [];
    const off = store.onChange((s) => seen.push(s.batchDownloadSize));
    store.get().batchDownloadSize = 3;
    store.changed();
    off();
    store.changed();
    expect(seen).toEqual([3]);
  });
});
