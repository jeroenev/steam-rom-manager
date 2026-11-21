# Ubisoft Connect games, "Wait for the game to exit" (pre-launch, and -Mark
# at post-launch). Steam's overlay only reaches a game that Steam's own
# process tree started. When Ubisoft Connect is closed, the launch starts it
# inside that tree and the game gets the overlay, but Steam then shows the
# game as running until Ubisoft Connect closes: so ubisoft-connect-stop.ps1
# closes a Ubisoft Connect this launch started, after the game. One that was
# already open takes the game over outside Steam's tree (no overlay) and is
# left alone.
#   (pre-launch): notes whether this launch starts Ubisoft Connect. If so,
#     and its settings.yaml has "closebehavior: CloseBehavior_Minimize" (the
#     default: its window's close button only hides it), changes that to
#     CloseBehavior_Close for this launch, so that it can be asked to quit
#     after the game; ubisoft-connect-stop.ps1 changes it back. Only while
#     Ubisoft Connect is closed: it writes its settings when it exits. A
#     marker in the launch-wrappers folder remembers the change until it's
#     undone, should a launch be cut short (Steam's Stop ends this script).
#     With -Restart, an open Ubisoft Connect is closed first, so the game
#     always gets the overlay (this stops its downloads); not when this game
#     already runs, nor while another game Ubisoft Connect started runs (it
#     would lose Ubisoft Connect). It's ended, unless its setting lets a
#     close request quit it.
#   -Mark (post-launch): notes that the game started.
# Based on BoilR's launch-and-wait (https://github.com/PhilipK/BoilR).
param (
    [string]$GameFolder, # the game's install folder
    [switch]$Restart,
    [switch]$Mark,
    [string]$SettingsFile = "$env:LOCALAPPDATA\Ubisoft Game Launcher\settings.yaml",
    [string]$ProcessName = 'upc',
    [string]$WindowTitle = 'Ubisoft Connect',
    [double]$CloseSeconds = 15,
    [string]$StateDir, # for the lasting marker; the launch-wrappers folder
    [string]$RunDir = $env:SRM_RUN_DIR
)
. (Join-Path $PSScriptRoot 'launcher-helpers.ps1')
If (!$StateDir) { $StateDir = Split-Path $PSScriptRoot -Parent }
$hide = 'closebehavior: CloseBehavior_Minimize'
$quit = 'closebehavior: CloseBehavior_Close'
$lasting = 'ubisoft-connect-closebehavior-changed.txt'
If (!$RunDir) {
    Write-Host 'Not run by SRM''s launch script (no SRM_RUN_DIR): nothing to do'
    Exit 0
}

If ($Mark) {
    Set-Marker $RunDir 'ubisoft-game-started'
    Exit 0
}

If (Test-LauncherRunning $ProcessName) {
    If (!$Restart) {
        Write-Host 'Ubisoft Connect is open: it takes the game over and stays open (no Steam overlay)'
        Exit 0
    }
    If (Test-GameRunning $GameFolder) {
        Write-Host 'The game already runs: leaving Ubisoft Connect open'
        Exit 0
    }
    If (Test-LauncherGameRunning $ProcessName) {
        Write-Host 'Another game Ubisoft Connect started runs: leaving Ubisoft Connect open (no Steam overlay)'
        Exit 0
    }
    Write-Host 'Closing the open Ubisoft Connect, so that this launch starts it (Steam overlay)'
    # (asked only when that quits it; it would hide in the tray)
    $title = If (Test-SettingLine $SettingsFile $quit) { $WindowTitle } Else { '' }
    Close-Launcher -ProcessName $ProcessName -Title $title -Seconds $CloseSeconds
    If (Test-LauncherRunning $ProcessName) {
        Write-Host 'Ubisoft Connect is still open: it takes the game over and stays open'
        Exit 0
    }
}
Set-Marker $RunDir 'ubisoft-connect-started'
Write-Host 'This launch starts Ubisoft Connect; it is closed after the game'

$changedBefore = Test-Marker $StateDir $lasting
If (Test-SettingLine $SettingsFile $hide) {
    # (the lasting marker first: a launch cut short in between leaves a
    # marker without a change, which the next launch clears)
    Set-Marker $StateDir $lasting $SettingsFile
    If (Set-SettingLine $SettingsFile $hide $quit) {
        Set-Marker $RunDir 'ubisoft-setting-changed'
        Write-Host "Changed '$hide' to '$quit' in $SettingsFile for this launch"
    } Else {
        Remove-Marker $StateDir $lasting
        Write-Host "Could not change '$hide' in $SettingsFile"
    }
} ElseIf ($changedBefore -and (Test-SettingLine $SettingsFile $quit)) {
    # an earlier launch was cut short before it changed the line back
    Set-Marker $RunDir 'ubisoft-setting-changed'
    Write-Host "'$quit' in $SettingsFile was left by an earlier launch; it's changed back after this one"
} Else {
    Remove-Marker $StateDir $lasting
    Write-Host "Ubisoft Connect's close setting isn't '$hide': left as it is"
}
