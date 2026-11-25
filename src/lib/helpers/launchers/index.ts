// Where each store's launcher keeps its installed games, and the programs
// SRM starts them with: shared by the platform parsers and the owned-games
// code (src/lib/stores), so both agree. (The EA app's games are found by
// the EA Desktop parser's own search, src/lib/parsers/ea-desktop.)
export * from "./windows";
export * from "./epic";
export * from "./legendary";
export * from "./gog-galaxy";
export * from "./amazon-games";
export * from "./battle-net";
export * from "./itch";
export * from "./heroic";
export * from "./ubisoft";
