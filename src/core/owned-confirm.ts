// Before a save that adds many games the store accounts own but haven't
// installed (Store Account parsers) to Steam, the app asks first; the
// command line says so in its log instead, and goes on. Runs in the UI too.
import { PreviewData, PreviewDataApp } from "../models";

// The Store Account apps of `previewData` that saving adds to Steam as new
// shortcuts: one per Steam user that doesn't have the game yet, with its
// app id (the same game's for every user: it's made from program and
// title).
function ownedToAdd(
  previewData: PreviewData | undefined | null,
): { appID: string; app: PreviewDataApp }[] {
  const apps: { appID: string; app: PreviewDataApp }[] = [];
  for (const steamDirectory in previewData ?? {}) {
    for (const userId in previewData[steamDirectory]) {
      for (const [appID, app] of Object.entries(
        previewData[steamDirectory][userId].apps,
      )) {
        if (
          app.parserType === "Store Account" &&
          app.status === "add" &&
          app.notInSteam
        ) {
          apps.push({ appID, app });
        }
      }
    }
  }
  return apps;
}

// How many games saving `previewData` adds through Store Account shortcuts
// that Steam doesn't have yet (for at least one Steam user): each game
// once, however many Steam users get it, since the limit it's compared
// with (ownedGames.confirmAbove) is a number of games.
export function ownedShortcutsToAdd(
  previewData: PreviewData | undefined | null,
): number {
  return new Set(ownedToAdd(previewData).map(({ appID }) => appID)).size;
}

// After a save: those shortcuts are in Steam now, so saving the same list
// again doesn't ask again.
export function ownedShortcutsSaved(
  previewData: PreviewData | undefined | null,
) {
  for (const { app } of ownedToAdd(previewData)) {
    app.notInSteam = false;
  }
}

// Whether a save that adds `count` of them asks first: when there are more
// than `confirmAbove` (the setting ownedGames.confirmAbove); 0 never asks.
export function confirmOwnedShortcuts(
  count: number,
  confirmAbove: number,
): boolean {
  return (
    Number.isFinite(confirmAbove) && confirmAbove > 0 && count > confirmAbove
  );
}
