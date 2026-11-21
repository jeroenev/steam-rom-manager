// Before a save that adds many games the store accounts own but haven't
// installed (Store Account parsers) to Steam, the app asks first; the
// command line says so in its log instead, and goes on. Runs in the UI too.
import { PreviewData, PreviewDataApp } from "../models";

// The Store Account apps of `previewData` that saving adds to Steam as new
// shortcuts (one per Steam user).
function ownedToAdd(
  previewData: PreviewData | undefined | null,
): PreviewDataApp[] {
  const apps: PreviewDataApp[] = [];
  for (const steamDirectory in previewData ?? {}) {
    for (const userId in previewData[steamDirectory]) {
      for (const app of Object.values(
        previewData[steamDirectory][userId].apps,
      )) {
        if (
          app.parserType === "Store Account" &&
          app.status === "add" &&
          app.notInSteam
        ) {
          apps.push(app);
        }
      }
    }
  }
  return apps;
}

// How many Store Account shortcuts saving `previewData` adds that Steam
// doesn't have yet.
export function ownedShortcutsToAdd(
  previewData: PreviewData | undefined | null,
): number {
  return ownedToAdd(previewData).length;
}

// After a save: those shortcuts are in Steam now, so saving the same list
// again doesn't ask again.
export function ownedShortcutsSaved(
  previewData: PreviewData | undefined | null,
) {
  for (const app of ownedToAdd(previewData)) {
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
