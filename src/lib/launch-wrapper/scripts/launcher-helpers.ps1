# Shared by the EA app and Ubisoft Connect scripts ("Wait for the game to
# exit"), which dot-source it. Those close a launcher that the launch started
# once the game has exited, and leave one that was already open alone.
#
# Steps of one launch tell each other what happened through marker files in
# SRM_RUN_DIR. Process ids are only used within a moment, never kept between
# steps.
# Based on BoilR's launch-and-wait (https://github.com/PhilipK/BoilR).

# Marker files: in this launch's folder, or (for what must outlast a launch)
# in the launch-wrappers folder. Written as UTF-8 without a byte order mark.
function Set-Marker([string]$Folder, [string]$Name, [string]$Value = '') {
    [IO.File]::WriteAllText((Join-Path $Folder $Name), $Value)
}

function Test-Marker([string]$Folder, [string]$Name) {
    Test-Path -LiteralPath (Join-Path $Folder $Name)
}

function Get-Marker([string]$Folder, [string]$Name) {
    Try { [IO.File]::ReadAllText((Join-Path $Folder $Name)) } Catch { '' }
}

function Remove-Marker([string]$Folder, [string]$Name) {
    Remove-Item -LiteralPath (Join-Path $Folder $Name) -Force -ErrorAction SilentlyContinue
}

# The programs of this Windows session (named $Name, or all). Another
# signed-in user's launcher or game isn't this launch's: it can't be asked
# to close, nor ended, and its launcher doesn't take this user's game over.
function Get-SessionProcesses([string]$Name) {
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $all = If ($Name) { Get-Process -Name $Name -ErrorAction SilentlyContinue } Else { Get-Process }
    Return @($all | Where-Object { $_.SessionId -eq $session })
}

# The path of a program ($Process, or the one with id $Id), also of one
# running as administrator: Windows PowerShell reads Process.Path from the
# program's modules, which it can't for those. None for a program Windows
# won't tell about (a protected one, another user's). SRM's launch script
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
            Write-Host "Can't read the path of programs running as administrator: $($script:processPathError)"
            Return $null
        }
    }
    Return [SrmProcessPath]::Get($Id)
}

function Get-ProcessPath($Process) {
    If ($Process.Path) { Return [string]$Process.Path }
    Return Get-ProcessPathById $Process.Id
}

# Whether a program from the game's folder (or a folder below it) runs. A
# program whose path can't be read at all (a protected one) counts when it's
# named like the game's executable.
function Test-GameRunning([string]$GameFolder, [string]$ExeName) {
    If (!$GameFolder) { Return $False }
    $folder = [IO.Path]::GetFullPath($GameFolder).TrimEnd('\') + '\'
    $name = If ($ExeName) { [IO.Path]::GetFileNameWithoutExtension($ExeName) } Else { $null }
    Return [bool]@(Get-SessionProcesses | Where-Object {
        $path = Get-ProcessPath $_
        If ($path) { $path.StartsWith($folder, 'OrdinalIgnoreCase') } Else { $name -and $_.ProcessName -eq $name }
    }).Count
}

function Test-LauncherRunning([string]$ProcessName) {
    Return [bool]@(Get-SessionProcesses $ProcessName).Count
}

# The folders the launcher's main program ($ProcessName) runs from, as
# Windows reports them (through the real folder where the installed one is a
# link, as the EA app's is).
function Get-LauncherFolders([string]$ProcessName) {
    Return @(Get-SessionProcesses $ProcessName | ForEach-Object { Get-ProcessPath $_ } | Where-Object { $_ } |
        ForEach-Object { [IO.Path]::GetDirectoryName($_) } | Sort-Object -Unique)
}

# The launcher's programs: its main program, and every program directly in
# one of $Folders. Not those in folders below them, where games can be
# installed, nor those named in $Except (the EA app's Windows service).
function Get-LauncherProcesses([string]$ProcessName, [string[]]$Folders, [string[]]$Except) {
    Return @(Get-SessionProcesses | Where-Object {
        ($Except -notcontains $_.ProcessName) -and (
            ($_.ProcessName -eq $ProcessName) -or $(
                $path = Get-ProcessPath $_
                $path -and ($Folders -contains [IO.Path]::GetDirectoryName($path))))
    })
}

# Whether a program that the launcher started still runs from outside the
# launcher's own folders: another game, started from the launcher's window or
# by another launch that found the launcher open. The launcher won't close
# then (the EA app says "Close your game, first", Ubisoft Connect aborts its
# shutdown), and ending it would take that game's launcher away (and its
# cloud sync). The launcher's own programs are those in its folders or below
# them, but not below a "games" folder there (where Ubisoft Connect installs
# games by default); programs in Windows' folder (consoles, error reports)
# don't count either. One whose path can't be read at all (a protected
# one) counts: better to leave the launcher open.
function Test-LauncherGameRunning([string]$ProcessName, [string[]]$Folders = @(), [string[]]$Except = @()) {
    $Folders = @(@(Get-LauncherFolders $ProcessName) + $Folders | Where-Object { $_ } | Sort-Object -Unique)
    $ids = @(Get-LauncherProcesses $ProcessName $Folders $Except | ForEach-Object { $_.Id })
    If (!$ids.Count) { Return $False }
    $windows = [Environment]::GetFolderPath('Windows').TrimEnd('\') + '\'
    $own = @($Folders | ForEach-Object { $_.TrimEnd('\') + '\' })
    Return [bool]@(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath -ErrorAction SilentlyContinue | Where-Object {
        If (($ids -notcontains [int]$_.ParentProcessId) -or ($ids -contains [int]$_.ProcessId)) { Return $False }
        $path = [string]$_.ExecutablePath
        If (!$path) { $path = [string](Get-ProcessPathById ([int]$_.ProcessId)) }
        If (!$path) { Return $True }
        If ($path.StartsWith($windows, 'OrdinalIgnoreCase')) { Return $False }
        Return !@($own | Where-Object {
            $path.StartsWith($_, 'OrdinalIgnoreCase') -and !$path.StartsWith($_ + 'games\', 'OrdinalIgnoreCase')
        }).Count
    }).Count
}

# Sends a close request (WM_CLOSE) to the top-level windows titled $Title of
# $Processes, hidden ones included (a launcher in the tray has no visible
# window); returns how many there were. Asking quits a launcher cleanly,
# where ending it could cut off a cloud upload.
function Send-CloseRequest($Processes, [string]$Title) {
    Try {
        If (!('SrmLauncherWindows' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SrmLauncherWindows {
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    private const uint WM_CLOSE = 0x0010;

    public static int Close(int[] processIds, string title) {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate (IntPtr window, IntPtr data) {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (Array.IndexOf(processIds, (int)processId) >= 0) {
                StringBuilder text = new StringBuilder(256);
                GetWindowText(window, text, text.Capacity);
                if (text.ToString() == title) found.Add(window);
            }
            return true;
        }, IntPtr.Zero);
        foreach (IntPtr window in found) PostMessage(window, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        return found.Count;
    }
}
'@
        }
        $ids = [int[]]@($Processes | ForEach-Object { $_.Id })
        Return [SrmLauncherWindows]::Close($ids, $Title)
    } Catch {
        Write-Host "Could not ask the launcher to close: $($_.Exception.Message)"
        Return 0
    }
}

# Closes the launcher: asks its windows titled $Title to close (when a title
# is given), waits up to $Seconds for its programs to go, then ends what is
# left and waits for that.
function Close-Launcher {
    param (
        [string]$ProcessName,
        [string]$Title,
        [double]$Seconds = 15,
        [string[]]$Folders = @(),
        [string[]]$Except = @()
    )
    $Folders = @(@(Get-LauncherFolders $ProcessName) + $Folders | Where-Object { $_ } | Sort-Object -Unique)
    $left = @(Get-LauncherProcesses $ProcessName $Folders $Except)
    If (!$left.Count) {
        Write-Host 'The launcher is not running'
        Return
    }
    If ($Title) {
        $asked = Send-CloseRequest $left $Title
        If ($asked) {
            Write-Host "Asking the launcher to close ($asked windows titled '$Title')"
            $until = (Get-Date).AddSeconds($Seconds)
            Do {
                Start-Sleep -Milliseconds 500
                $left = @(Get-LauncherProcesses $ProcessName $Folders $Except)
            } While ($left.Count -and (Get-Date) -lt $until)
            If (!$left.Count) {
                Write-Host 'The launcher closed'
                Return
            }
            Write-Host "The launcher did not close ($($left.Count) programs left)"
        }
    }
    Write-Host "Ending the launcher ($($left.Count) programs)"
    $until = (Get-Date).AddSeconds($Seconds)
    Do {
        $left | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        $left = @(Get-LauncherProcesses $ProcessName $Folders $Except)
    } While ($left.Count -and (Get-Date) -lt $until)
    If ($left.Count) { Write-Host "Could not end $($left.Count) of the launcher's programs" }
}

# Splits text into lines that keep their line endings.
function Split-Lines([string]$Text) {
    Return [regex]::Split($Text, '(?<=\n)') | Where-Object { $_ -ne '' }
}

# Whether exactly one line of $File reads $Line (ignoring indentation and
# the line ending).
function Test-SettingLine([string]$File, [string]$Line) {
    Try { $text = [IO.File]::ReadAllText($File) } Catch { Return $False }
    Return @(Split-Lines $text | Where-Object { $_.Trim() -ceq $Line }).Count -eq 1
}

# Changes the one line of $File that reads $From (ignoring indentation and
# the line ending) to $To, keeping its indentation and line ending, and the
# file's encoding (UTF-8; with a byte order mark only if it had one). False
# when there is no such line, or more than one, or the file can't be read or
# written.
function Set-SettingLine([string]$File, [string]$From, [string]$To) {
    Try { $bytes = [IO.File]::ReadAllBytes($File) } Catch { Return $False }
    $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $skip = If ($bom) { 3 } Else { 0 }
    $text = (New-Object Text.UTF8Encoding($False)).GetString($bytes, $skip, $bytes.Length - $skip)
    $lines = @(Split-Lines $text)
    If (@($lines | Where-Object { $_.Trim() -ceq $From }).Count -ne 1) { Return $False }
    $changed = ($lines | ForEach-Object {
            If ($_.Trim() -ceq $From) {
                $parts = [regex]::Match($_, '^(\s*).*?(\s*)$', 'Singleline')
                $parts.Groups[1].Value + $To + $parts.Groups[2].Value
            } Else { $_ }
        }) -join ''
    Try {
        [IO.File]::WriteAllText($File, $changed, (New-Object Text.UTF8Encoding($bom)))
        Return $True
    } Catch {
        Return $False
    }
}

# How long a log is, read through a handle: a file another program keeps
# writing to can have an older size in its folder's listing.
function Get-LogLength([string]$File) {
    Try {
        $stream = [IO.File]::Open($File, 'Open', 'Read', 'ReadWrite')
        Try { Return $stream.Length } Finally { $stream.Dispose() }
    } Catch {
        Return 0
    }
}

# What a log got after its first $Start bytes (all of it when it's shorter:
# it started over). Read with shared access: the launcher keeps it open.
function Get-LogSince([string]$File, [long]$Start) {
    Try {
        $stream = [IO.File]::Open($File, 'Open', 'Read', 'ReadWrite')
        Try {
            If ($stream.Length -lt $Start) { $Start = 0 }
            [void]$stream.Seek($Start, 'Begin')
            Return (New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)).ReadToEnd()
        } Finally {
            $stream.Dispose()
        }
    } Catch {
        Return ''
    }
}
