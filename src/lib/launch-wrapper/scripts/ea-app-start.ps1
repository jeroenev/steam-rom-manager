# EA app games, "Wait for the game to exit" (pre-launch, and -Mark at
# post-launch). Steam's overlay only reaches a game that Steam's own process
# tree started. When the EA app is closed, the launch starts it inside that
# tree and the game gets the overlay, but Steam then shows the game as
# running until the EA app closes: so ea-app-stop.ps1 closes an EA app this
# launch started, after the game. An EA app that was already open takes the
# game over outside Steam's tree (no overlay) and is left alone.
#   (pre-launch): notes whether this launch starts the EA app. With -Restart,
#     an open EA app is closed first, so the game always gets the overlay
#     (this stops its downloads); not when this game already runs, nor while
#     another game the EA app started runs (it would lose the EA app).
#   -Mark (post-launch): notes that the game started, and how long the EA
#     app's log is: only what it logs after that counts for the cloud sync
#     after the game.
# Based on BoilR's launch-and-wait (https://github.com/PhilipK/BoilR).
param (
    [string]$GameFolder, # the game's install folder
    [string]$ExeName, # the game's executable, when known
    [switch]$Restart,
    [switch]$Mark,
    [string]$Log = "$env:LOCALAPPDATA\Electronic Arts\EA Desktop\Logs\EADesktop.log",
    [string]$ProcessName = 'EADesktop',
    [string]$WindowTitle = 'EA',
    [double]$CloseSeconds = 15,
    [string]$RunDir = $env:SRM_RUN_DIR
)
. (Join-Path $PSScriptRoot 'launcher-helpers.ps1')
# (a Windows service in the EA app's folder: never ended)
$except = @('EABackgroundService')
If (!$RunDir) {
    Write-Host 'Not run by SRM''s launch script (no SRM_RUN_DIR): nothing to do'
    Exit 0
}

If ($Mark) {
    Set-Marker $RunDir 'ea-game-started'
    Set-Marker $RunDir 'ea-log-length' ([string](Get-LogLength $Log))
    # (in case the EA app's main program is gone before the rest, after the game)
    Set-Marker $RunDir 'ea-app-folders' (@(Get-LauncherFolders $ProcessName) -join "`n")
    Exit 0
}

If (Test-LauncherRunning $ProcessName) {
    If (!$Restart) {
        Write-Host 'The EA app is open: it takes the game over and stays open (no Steam overlay)'
        Exit 0
    }
    If (Test-GameRunning $GameFolder $ExeName) {
        Write-Host 'The game already runs: leaving the EA app open'
        Exit 0
    }
    If (Test-LauncherGameRunning $ProcessName @() $except) {
        Write-Host 'Another game the EA app started runs: leaving the EA app open (no Steam overlay)'
        Exit 0
    }
    Write-Host 'Closing the open EA app, so that this launch starts it (Steam overlay)'
    Close-Launcher -ProcessName $ProcessName -Title $WindowTitle -Seconds $CloseSeconds -Except $except
    If (Test-LauncherRunning $ProcessName) {
        Write-Host 'The EA app is still open: it takes the game over and stays open'
        Exit 0
    }
}
Set-Marker $RunDir 'ea-app-started'
Write-Host 'This launch starts the EA app; it is closed after the game'
