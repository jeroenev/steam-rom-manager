# Steam ROM Manager's launch script (Windows). A wrapped shortcut runs the
# game's own file in launch-wrappers\<Steam user>\, which calls this with the
# game's settings. It runs the scripts set for each stage (pre-launch,
# post-launch, post-exit), starts the game and waits for it to exit, so Steam
# shows it as running until then.
#
# A failing or missing script is logged (launch.log) and skipped: the game
# still starts. Scripts get SRM_GAME_TITLE, SRM_STAGE and SRM_RUN_DIR (a
# folder for this launch's scripts to share files in) as environment
# variables.
#
# SRM writes this file when it saves to Steam; changes to it are overwritten.
param (
    [Parameter(Mandatory = $True)]$Config
)

$runDir = Join-Path ([IO.Path]::GetTempPath()) ("srm-launch-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$env:SRM_GAME_TITLE = $Config.title
$env:SRM_RUN_DIR = $runDir

function Write-Log([string]$message) {
    Try {
        $log = $Config.log
        If ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1MB) {
            Move-Item -LiteralPath $log -Destination "$log.old" -Force
        }
        $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Config.title, $message
        Add-Content -LiteralPath $log -Value $line -Encoding UTF8
    } Catch {}
}

function Wait-Seconds($seconds) {
    If ($seconds -gt 0) { Start-Sleep -Milliseconds ([int]([double]$seconds * 1000)) }
}

# Runs one script and waits for it. Never throws.
function Invoke-Step($step, [string]$stage) {
    $env:SRM_STAGE = $stage
    $script = [string]$step.script
    If (!$script) { Return }
    If (!(Test-Path -LiteralPath $script)) {
        Write-Log "${stage}: script not found, skipped: $script"
        Return
    }
    Write-Log "${stage}: running $script"
    Try {
        $stepArgs = @($step.args | Where-Object { $_ -ne $null })
        $global:LASTEXITCODE = 0
        If ([IO.Path]::GetExtension($script) -ieq ".ps1") {
            $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script @stepArgs 2>&1
        } Else {
            $output = & $script @stepArgs 2>&1
        }
        $code = $LASTEXITCODE
        ForEach ($line in @($output)) { Write-Log "  $line" }
        If ($code) { Write-Log "${stage}: $script failed (exit code $code); carrying on" }
    } Catch {
        Write-Log "${stage}: $script failed: $($_.Exception.Message); carrying on"
    }
}

# Pre-launch scripts wait (delay) after running; the others before.
function Invoke-Stage([string]$stage, $steps) {
    ForEach ($step in @($steps)) {
        If (!$step) { Continue }
        If ($stage -ne "pre-launch") { Wait-Seconds $step.delay }
        Invoke-Step $step $stage
        If ($stage -eq "pre-launch") { Wait-Seconds $step.delay }
    }
}

# The path of a program ($Process, or the one with id $Id), also of one
# running as administrator: Windows PowerShell reads Process.Path from the
# program's modules, which it can't for those. None for a program Windows
# won't tell about (a protected one, another user's). launcher-helpers.ps1
# has the same (keep the two the same).
$script:processPathError = $null
function Get-ProcessPathById([int]$Id) {
    If (!('SrmProcessPath' -as [type])) {
        If ($script:processPathError) { Return $null }
        Try {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SrmProcessPath {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "QueryFullProcessImageNameW")]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    public static string Get(int processId) {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) return null;
        try {
            StringBuilder path = new StringBuilder(32768);
            uint size = (uint)path.Capacity;
            return QueryFullProcessImageName(process, 0, path, ref size) ? path.ToString(0, (int)size) : null;
        } finally {
            CloseHandle(process);
        }
    }
}
'@
        } Catch {
            # (e.g. where PowerShell may not compile code: only paths that
            # Process.Path reads count then)
            $script:processPathError = $_.Exception.Message
            Write-Log "can't read the path of programs running as administrator: $($script:processPathError)"
            Return $null
        }
    }
    Return [SrmProcessPath]::Get($Id)
}

function Get-ProcessPath($Process) {
    If ($Process.Path) { Return [string]$Process.Path }
    Return Get-ProcessPathById $Process.Id
}

# The game's processes. With a game folder: this Windows session's programs
# running from it (or, where the path can't be read at all, named like the
# game's executable); another signed-in user's copy of the game isn't this
# launch's. Without: the started process and every process it started,
# followed through processes that have exited (Windows keeps a child's
# parent id).
$script:tracked = @{}
$script:session = [Diagnostics.Process]::GetCurrentProcess().SessionId
function Get-GameProcesses {
    If ($Config.game -and $Config.game.folder) {
        $folder = [IO.Path]::GetFullPath([string]$Config.game.folder).TrimEnd('\') + '\'
        $exeName = If ($Config.game.exeName) { [IO.Path]::GetFileNameWithoutExtension([string]$Config.game.exeName) } Else { $null }
        Return @(Get-Process | Where-Object { $_.SessionId -eq $script:session } | Where-Object {
            $path = Get-ProcessPath $_
            If ($path) { $path.StartsWith($folder, 'OrdinalIgnoreCase') } Else { $exeName -and $_.ProcessName -eq $exeName }
        } | ForEach-Object { $_.Id })
    }
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue)
    Do {
        $added = $False
        ForEach ($p in $all) {
            If (!$script:tracked.ContainsKey([int]$p.ProcessId) -and $script:tracked.ContainsKey([int]$p.ParentProcessId)) {
                $script:tracked[[int]$p.ProcessId] = $True
                $added = $True
            }
        }
    } While ($added)
    $alive = @{}
    ForEach ($p in $all) { $alive[[int]$p.ProcessId] = $True }
    Return @($script:tracked.Keys | Where-Object { $alive.ContainsKey($_) })
}

# Whether a program of this session runs that the parser names as the
# launcher taking the game's start over (game.handOff, names without .exe:
# Ubisoft Connect's UbisoftGameLauncher, which a game's first program can
# start before it exits).
function Test-HandOff {
    $names = @($Config.game.handOff | Where-Object { $_ } | ForEach-Object { [string]$_ })
    If (!$names.Count) { Return $False }
    Return [bool]@(Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $script:session }).Count
}

# Waits until no game process is left (and none comes back for a few
# seconds: some games restart themselves).
function Wait-GameExit {
    $goneSince = $null
    While (!$goneSince -or ((Get-Date) - $goneSince).TotalSeconds -lt 5) {
        If (@(Get-GameProcesses).Count) { $goneSince = $null } ElseIf (!$goneSince) { $goneSince = Get-Date }
        Start-Sleep -Seconds 2
    }
}

Try {
    Write-Log "launching"
    Invoke-Stage "pre-launch" $Config.preLaunch

    $started = $null
    $startFailed = $False
    Try {
        $start = @{ FilePath = [string]$Config.file; PassThru = $True }
        If ($Config.arguments) { $start.ArgumentList = [string]$Config.arguments }
        If ($Config.workingDirectory -and (Test-Path -LiteralPath $Config.workingDirectory)) {
            $start.WorkingDirectory = [string]$Config.workingDirectory
        }
        $started = Start-Process @start
        If ($started) { $script:tracked[[int]$started.Id] = $True }
        Write-Log "started $($Config.file) $($Config.arguments)"
    } Catch {
        # (e.g. a launcher link whose launcher is gone: nothing will start
        # the game, so there's nothing to wait for)
        $startFailed = $True
        Write-Log "could not start the game: $($_.Exception.Message)"
    }

    $running = $False
    If (!$startFailed -and $Config.game -and $Config.game.folder) {
        # The launcher was started and starts the game: wait for it (3
        # minutes at most, or what the parser sets: a launcher may update the
        # game or ask to sign in first) and for its start-up to settle: the
        # same programs 3 seconds apart (2 minutes at most, and not past that
        # time). A game that is gone again by then may come back (some
        # restart themselves); if it doesn't, it ran and exited (it crashed,
        # or quit at once), and the launcher is closed as after any game.
        # But while a program runs that the parser names as its launcher
        # taking the game's start over (handOff), the game's first program
        # only handed the game to the launcher, which may still update it or
        # stall: the game hasn't started, so wait on for it.
        $minutes = 3
        If ($Config.game.startTimeoutMinutes -gt 0) { $minutes = [double]$Config.game.startTimeoutMinutes }
        $timeout = (Get-Date).AddMinutes($minutes)
        $goneLogged = $False
        $handOffLogged = $False
        While (!$running -and (Get-Date) -lt $timeout) {
            If (!@(Get-GameProcesses).Count) {
                Start-Sleep -Seconds 1
                Continue
            }
            $settleUntil = (Get-Date).AddMinutes(2)
            If ($settleUntil -gt $timeout) { $settleUntil = $timeout }
            $handedOff = $False
            Do {
                $before = (@(Get-GameProcesses) | Sort-Object) -join ","
                Start-Sleep -Seconds 3
                $after = (@(Get-GameProcesses) | Sort-Object) -join ","
                If (!$after -and (Test-HandOff)) {
                    # (only when it still runs a moment later: it can outlive
                    # a game that ended by half a second)
                    Start-Sleep -Seconds 2
                    $after = (@(Get-GameProcesses) | Sort-Object) -join ","
                    $handedOff = !$after -and (Test-HandOff)
                }
                If (!$after -and !$handedOff -and !$goneLogged) {
                    $goneLogged = $True
                    Write-Log "the game closed again during start-up; waiting for it to come back (2 minutes at most)"
                }
            } Until (($after -and $before -eq $after) -or $handedOff -or (Get-Date) -gt $settleUntil)
            $running = !$handedOff
            If ($handedOff -and !$handOffLogged) {
                $handOffLogged = $True
                Write-Log "the game handed its start to its launcher (which may still update it); waiting for it to start"
            } ElseIf (!$after) {
                Write-Log "the game didn't come back: it ran and exited"
            }
        }
    } Else {
        $running = [bool]$started
    }

    If ($running) {
        Write-Log "game started"
        Invoke-Stage "post-launch" $Config.postLaunch
        Wait-GameExit
        Write-Log "game exited"
    } Else {
        Write-Log "the game didn't start; skipping post-launch scripts"
    }
    Invoke-Stage "post-exit" $Config.postExit
} Catch {
    Write-Log "launch script error: $($_.Exception.Message)"
} Finally {
    Remove-Item -LiteralPath $runDir -Recurse -Force -ErrorAction SilentlyContinue
}
