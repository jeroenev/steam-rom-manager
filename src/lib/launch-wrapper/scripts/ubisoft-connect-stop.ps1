# Ubisoft Connect games, "Wait for the game to exit" (post-exit): closes a
# Ubisoft Connect that this launch started (see ubisoft-connect-start.ps1),
# so Steam stops showing the game as running, and changes its close setting
# back. Nothing is closed when Ubisoft Connect was already open, or when the
# game never started (it may be updating the game, or waiting for a
# sign-in).
#   Ubisoft Connect logs no end of its cloud sync: it gets 5 seconds after
#   the game (a save was uploaded within 2 seconds in testing). Then, unless
#   the game runs again, its "Ubisoft Connect" windows are asked to close,
#   which quits it while its close setting says so, and what is left is
#   ended after 15 seconds.
#   Its setting is changed back once it has exited (it writes its settings
#   when it exits); if it still runs, a later launch does it.
# Based on BoilR's launch-and-wait (https://github.com/PhilipK/BoilR).
param (
    [string]$GameFolder, # the game's install folder
    [double]$GraceSeconds = 5,
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
If (!(Test-Marker $RunDir 'ubisoft-connect-started')) {
    Write-Host 'Ubisoft Connect was open before the launch: leaving it open'
    Exit 0
}

If (!(Test-Marker $RunDir 'ubisoft-game-started')) {
    Write-Host 'The game did not start: leaving Ubisoft Connect open'
} Else {
    Write-Host "Giving Ubisoft Connect $GraceSeconds seconds for cloud saves"
    If ($GraceSeconds -gt 0) { Start-Sleep -Milliseconds ([int]($GraceSeconds * 1000)) }
    If (Test-GameRunning $GameFolder) {
        Write-Host 'The game runs again: leaving Ubisoft Connect open'
    } Else {
        # (asked only when that quits it; it would hide in the tray)
        $title = If (Test-SettingLine $SettingsFile $quit) { $WindowTitle } Else { '' }
        Close-Launcher -ProcessName $ProcessName -Title $title -Seconds $CloseSeconds
    }
}

If (Test-Marker $RunDir 'ubisoft-setting-changed') {
    If (Test-LauncherRunning $ProcessName) {
        Write-Host "Ubisoft Connect still runs: '$quit' stays until a later launch changes it back"
    } ElseIf (Set-SettingLine $SettingsFile $quit $hide) {
        Remove-Marker $StateDir $lasting
        Write-Host "Changed '$quit' back to '$hide' in $SettingsFile"
    } Else {
        Write-Host "Could not change '$quit' back in $SettingsFile"
    }
}
