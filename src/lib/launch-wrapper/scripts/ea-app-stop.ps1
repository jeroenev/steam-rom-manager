# EA app games, "Wait for the game to exit" (post-exit): closes an EA app
# that this launch started (see ea-app-start.ps1), so Steam stops showing the
# game as running. Nothing is closed when the EA app was already open, or
# when the game never started (the EA app may be updating it, or waiting for
# a sign-in).
#   First waits until the EA app's log says its cloud sync after the game is
#   done: up to 10 seconds for the sync to start (games without cloud saves
#   have none), then up to a minute for it to end. Asked to close during the
#   sync, the EA app would show a dialog and stay open.
#   Then, unless the game runs again, asks the EA app's "EA" windows to close
#   (it quits cleanly), and ends what is left after 15 seconds.
# Based on BoilR's launch-and-wait (https://github.com/PhilipK/BoilR).
param (
    [string]$GameFolder, # the game's install folder
    [string]$ExeName, # the game's executable, when known
    [string]$Log = "$env:LOCALAPPDATA\Electronic Arts\EA Desktop\Logs\EADesktop.log",
    [string]$SyncStarted = 'Cloud Sync entry point post game',
    [string]$SyncDone = 'handleTerminalCloudSyncStatus',
    [double]$SyncStartSeconds = 10,
    [double]$SyncSeconds = 60,
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
If (!(Test-Marker $RunDir 'ea-app-started')) {
    Write-Host 'The EA app was open before the launch: leaving it open'
    Exit 0
}
If (!(Test-Marker $RunDir 'ea-game-started')) {
    Write-Host 'The game did not start: leaving the EA app open'
    Exit 0
}

# Only what the log got since the game started counts: the EA app also
# syncs before a game.
$start = 0L
[void][long]::TryParse((Get-Marker $RunDir 'ea-log-length'), [ref]$start)
Write-Host 'Waiting for the EA app to sync cloud saves'
$waiting = Get-Date
While ($True) {
    $written = Get-LogSince $Log $start
    If ($written.Contains($SyncDone)) {
        Write-Host "The EA app's cloud sync is done"
        Break
    }
    $syncing = $written.Contains($SyncStarted)
    $limit = If ($syncing) { $SyncSeconds } Else { $SyncStartSeconds }
    If (((Get-Date) - $waiting).TotalSeconds -ge $limit) {
        If ($syncing) {
            Write-Host "The EA app's cloud sync did not end within $limit seconds"
        } Else {
            Write-Host "No cloud sync started within $limit seconds"
        }
        Break
    }
    Start-Sleep -Milliseconds 500
}

If (Test-GameRunning $GameFolder $ExeName) {
    Write-Host 'The game runs again: leaving the EA app open'
    Exit 0
}
$folders = @((Get-Marker $RunDir 'ea-app-folders') -split "`n" | Where-Object { $_ })
Close-Launcher -ProcessName $ProcessName -Title $WindowTitle -Seconds $CloseSeconds -Folders $folders -Except $except
