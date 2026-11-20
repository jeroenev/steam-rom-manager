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

# Whether a program from the game's folder (or a folder below it) runs. A
# program whose path can't be read (one running as administrator) counts
# when it's named like the game's executable.
function Test-GameRunning([string]$GameFolder, [string]$ExeName) {
    If (!$GameFolder) { Return $False }
    $folder = [IO.Path]::GetFullPath($GameFolder).TrimEnd('\') + '\'
    $name = If ($ExeName) { [IO.Path]::GetFileNameWithoutExtension($ExeName) } Else { $null }
    Return [bool]@(Get-Process | Where-Object {
        If ($_.Path) { $_.Path.StartsWith($folder, 'OrdinalIgnoreCase') } Else { $name -and $_.ProcessName -eq $name }
    }).Count
}

function Test-LauncherRunning([string]$ProcessName) {
    Return [bool]@(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue).Count
}

# The folders the launcher's main program ($ProcessName) runs from, as
# Windows reports them (through the real folder where the installed one is a
# link, as the EA app's is).
function Get-LauncherFolders([string]$ProcessName) {
    Return @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.Path } |
        ForEach-Object { [IO.Path]::GetDirectoryName($_.Path) } | Sort-Object -Unique)
}

# The launcher's programs: its main program, and every program directly in
# one of $Folders. Not those in folders below them, where games can be
# installed, nor those named in $Except (the EA app's Windows service).
function Get-LauncherProcesses([string]$ProcessName, [string[]]$Folders, [string[]]$Except) {
    Return @(Get-Process | Where-Object {
        ($Except -notcontains $_.ProcessName) -and (
            ($_.ProcessName -eq $ProcessName) -or
            ($_.Path -and ($Folders -contains [IO.Path]::GetDirectoryName($_.Path))))
    })
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
