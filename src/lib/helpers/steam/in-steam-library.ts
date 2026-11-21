// Whether a folder is a game Steam installed (in a library's
// steamapps\common). Other launchers know the games bought through Steam
// too: the EA app's have installer data that Windows lists, Ubisoft
// Connect's are in its list of installed games. Steam already lists those
// games.
export function inSteamLibrary(location: string) {
  return /(^|[\\/])steamapps[\\/]+common([\\/]|$)/i.test(location);
}
