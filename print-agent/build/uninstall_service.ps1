<#
.SYNOPSIS
    Remove the "KO Print Agent" Windows Task Scheduler task.

.IMPORTANT
    Run this in an ELEVATED (Administrator) PowerShell window.
    ต้องรันสคริปต์นี้ใน PowerShell แบบ "Run as Administrator"

.PARAMETER TaskName
    Scheduled task name. Default: "KO Print Agent"

.EXAMPLE
    .\build\uninstall_service.ps1
#>

param(
    [string]$TaskName = "KO Print Agent"
)

$ErrorActionPreference = "Stop"

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error (
        "This script must be run as Administrator.`n" +
        "กรุณาเปิด PowerShell แบบ 'Run as administrator' แล้วรันสคริปต์นี้ใหม่"
    )
    exit 1
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Task '$TaskName' is not installed - nothing to do."
    Write-Host "ไม่พบงาน '$TaskName' ในระบบ - ไม่ต้องทำอะไรเพิ่ม"
    exit 0
}

Write-Host "Stopping task '$TaskName' (if running) ..."
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}

Write-Host "Removing task '$TaskName' ..."
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host "Done. The agent will no longer start automatically."
Write-Host "Note: this does NOT stop an already-running ko_print_agent.exe process -"
Write-Host "close its window / End Task in Task Manager if it is currently running."
Write-Host ""
Write-Host "เรียบร้อย โปรแกรมจะไม่เริ่มทำงานอัตโนมัติอีกต่อไป"
Write-Host "หมายเหตุ: หากโปรแกรมกำลังทำงานอยู่ตอนนี้ จะยังไม่หยุดทันที "
Write-Host "กรุณาปิดหน้าต่างโปรแกรม หรือ End Task ใน Task Manager ด้วยตนเอง"
