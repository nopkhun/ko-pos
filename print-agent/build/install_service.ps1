<#
.SYNOPSIS
    Install "KO Print Agent" as a Windows Task Scheduler task that runs the
    agent permanently in the background: at system startup, restarting
    automatically on failure, whether or not anyone is logged in.

.IMPORTANT
    Run this in an ELEVATED (Administrator) PowerShell window. Registering a
    task that runs "whether user is logged on or not" requires admin rights.
    ต้องรันสคริปต์นี้ใน PowerShell แบบ "Run as Administrator"

    No third-party tools are used (no NSSM download) - this uses only the
    built-in Windows Task Scheduler (ScheduledTasks PowerShell module).

    This task uses S4U logon (see $principal below), which lets it run
    "whether user is logged on or not" WITHOUT storing the Windows password.
    Requirement: the user named in -UserId (defaults to whoever runs this
    script) must have logged on interactively to this PC at least once
    before the task will actually start - Windows caches the credentials
    needed for S4U on first interactive logon. On a brand new PC/account,
    log in normally once first, then run this script.
    ต้อง login เข้า Windows ด้วยบัญชีนี้แบบปกติอย่างน้อย 1 ครั้งก่อน งานถึงจะเริ่มได้

.PARAMETER ExePath
    Path to ko_print_agent.exe. Defaults to .\dist\ko_print_agent.exe
    relative to this script's parent folder (print-agent\).

.PARAMETER TaskName
    Scheduled task name. Default: "KO Print Agent"

.EXAMPLE
    # From an elevated PowerShell, in the print-agent folder:
    .\build\install_service.ps1

.EXAMPLE
    .\build\install_service.ps1 -ExePath "C:\KO\ko_print_agent.exe"
#>

param(
    [string]$ExePath = "",
    [string]$TaskName = "KO Print Agent"
)

$ErrorActionPreference = "Stop"

# --- Must be elevated -----------------------------------------------------
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error (
        "This script must be run as Administrator (right-click PowerShell -> " +
        "Run as administrator).`n" +
        "กรุณาเปิด PowerShell แบบ 'Run as administrator' แล้วรันสคริปต์นี้ใหม่"
    )
    exit 1
}

$RepoRoot = Split-Path -Parent $PSScriptRoot   # print-agent\

if ([string]::IsNullOrWhiteSpace($ExePath)) {
    $ExePath = Join-Path $RepoRoot "dist\ko_print_agent.exe"
}
$ExePath = (Resolve-Path $ExePath -ErrorAction SilentlyContinue).Path
if (-not $ExePath -or -not (Test-Path $ExePath)) {
    Write-Error (
        "Could not find ko_print_agent.exe. Build it first with " +
        ".\build\build_windows.ps1, or pass -ExePath.`n" +
        "ไม่พบไฟล์ ko_print_agent.exe กรุณา build ก่อนด้วย .\build\build_windows.ps1 " +
        "หรือระบุ path ด้วย -ExePath"
    )
    exit 1
}

$WorkingDir = Split-Path -Parent $ExePath
$IniPath = Join-Path $WorkingDir "ko_print_agent.ini"
if (-not (Test-Path $IniPath)) {
    Write-Warning (
        "ko_print_agent.ini not found next to the exe ($WorkingDir). " +
        "The task will be created, but the agent will fail to start until " +
        "you copy ko_print_agent.example.ini to ko_print_agent.ini and fill it in.`n" +
        "ยังไม่พบไฟล์ ko_print_agent.ini ในโฟลเดอร์เดียวกับโปรแกรม " +
        "จะติดตั้งงานต่อไป แต่โปรแกรมจะยังทำงานไม่ได้จนกว่าจะคัดลอก " +
        "ko_print_agent.example.ini เป็น ko_print_agent.ini แล้วกรอกข้อมูลให้ครบ"
    )
} else {
    # --- Restrict ko_print_agent.ini so other local Windows accounts on
    #     this shared shop PC cannot read the Odoo token inside it. Strip
    #     inherited permissions, then explicitly grant only: this user
    #     (read/write), SYSTEM (read - the task runs as SYSTEM-adjacent via
    #     S4U and needs to read it), and Administrators (full control, so an
    #     admin can still open/edit the file for troubleshooting). ----------
    Write-Host "Restricting permissions on $IniPath (only this user + SYSTEM + Administrators can read it) ..."
    $currentUser = "$env:USERDOMAIN\$env:USERNAME"
    & icacls $IniPath /inheritance:r | Out-Null
    & icacls $IniPath /grant:r "${currentUser}:(R,W)" | Out-Null
    & icacls $IniPath /grant:r "SYSTEM:(R)" | Out-Null
    & icacls $IniPath /grant:r "*S-1-5-32-544:(F)" | Out-Null   # Administrators group
    if ($LASTEXITCODE -ne 0) {
        Write-Warning (
            "icacls could not fully restrict $IniPath - the token inside it " +
            "may be readable by other accounts on this PC. Check permissions " +
            "manually (right-click the file -> Properties -> Security).`n" +
            "ไม่สามารถจำกัดสิทธิ์ไฟล์ $IniPath ได้ทั้งหมด token ในไฟล์อาจถูกอ่านได้ " +
            "โดยบัญชีอื่นในเครื่องนี้ กรุณาตรวจสอบสิทธิ์ไฟล์ด้วยตนเอง " +
            "(คลิกขวาไฟล์ -> Properties -> Security)"
        )
    }
}

Write-Host "Exe path:     $ExePath"
Write-Host "Working dir:  $WorkingDir"
Write-Host "Task name:    $TaskName"
Write-Host "Run as user:  $env:USERNAME"

# --- Remove any existing task with the same name --------------------------
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task '$TaskName' ..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# --- Action: run the exe with its working directory set -------------------
$action = New-ScheduledTaskAction -Execute $ExePath -WorkingDirectory $WorkingDir

# --- Trigger: at system startup (not just user logon) ----------------------
$trigger = New-ScheduledTaskTrigger -AtStartup

# --- Principal: current user, S4U logon so it can run whether the user is
#     logged on or not, WITHOUT having to store the Windows password.
#     NOTE: S4U only works after this user has logged on to Windows
#     interactively at least once (Windows needs that to cache the logon
#     data S4U relies on). If the task fails to start with a logon-related
#     error, log in normally as this user once, then re-run this script or
#     just start the task again. -------------------------------------------
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U `
    -RunLevel Limited

# --- Settings: restart on failure every 1 minute, run indefinitely --------
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBattery `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "KO POS shop print agent - polls Odoo and sends jobs to the LAN thermal printer. Installed by install_service.ps1." `
    -Force | Out-Null

Write-Host ""
Write-Host "=== Task '$TaskName' installed ==="
Write-Host "It will start automatically at every system startup, and restart"
Write-Host "automatically (up to 999 times) if it ever crashes."
Write-Host ""
Write-Host "To start it right now without rebooting, run:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "To check its status:"
Write-Host "  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host ""
Write-Host "=== ติดตั้งงาน '$TaskName' เรียบร้อย ==="
Write-Host "โปรแกรมจะเริ่มทำงานอัตโนมัติทุกครั้งที่เปิดเครื่อง และจะรีสตาร์ทเองถ้าค้าง/ล่ม"
Write-Host "สั่งเริ่มทำงานทันทีโดยไม่ต้องรีสตาร์ทเครื่อง: Start-ScheduledTask -TaskName '$TaskName'"

# Start it immediately so the owner doesn't have to reboot to test.
Start-ScheduledTask -TaskName $TaskName
Write-Host ""
Write-Host "Task started. Check the log file in: $WorkingDir"
Write-Host "เริ่มโปรแกรมแล้ว ดู log ได้ที่โฟลเดอร์: $WorkingDir"
