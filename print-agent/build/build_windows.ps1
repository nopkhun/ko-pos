<#
.SYNOPSIS
    Build ko_print_agent.exe on Windows using PyInstaller.

.IMPORTANT
    THIS SCRIPT MUST BE RUN ON WINDOWS. It was written and syntax-checked on
    a Mac (where PyInstaller cannot produce a Windows .exe) but never
    executed there - a real Windows machine with Python installed is
    required to actually build dist\ko_print_agent.exe.
    สคริปต์นี้ต้องรันบน Windows เท่านั้น (สร้างไฟล์ .exe ของ Windows บน Mac ไม่ได้)

.DESCRIPTION
    1. Checks that Python 3.11+ is available.
    2. Creates a fresh virtual environment in .\build\venv
    3. Installs runtime dependencies (requirements.txt) + PyInstaller.
    4. Builds a single-file, console .exe: dist\ko_print_agent.exe
    5. Copies ko_print_agent.example.ini next to the .exe for convenience.

.EXAMPLE
    cd print-agent
    .\build\build_windows.ps1
#>

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot   # print-agent\
$VenvDir  = Join-Path $RepoRoot "build\venv"
$DistDir  = Join-Path $RepoRoot "dist"

Write-Host "=== KO Print Agent - Windows build ==="
Write-Host "Repo root: $RepoRoot"

# --- 1. Check Python -------------------------------------------------
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Error (
        "Python not found on PATH. Install Python 3.11+ from https://python.org " +
        "(check 'Add python.exe to PATH' during install) and re-run this script.`n" +
        "ไม่พบ Python กรุณาติดตั้ง Python 3.11 ขึ้นไปจาก https://python.org " +
        "(ติ๊ก 'Add python.exe to PATH' ตอนติดตั้ง) แล้วรันสคริปต์นี้ใหม่"
    )
    exit 1
}

$verOutput = & python --version 2>&1
Write-Host "Found: $verOutput"

# --- 2. Create venv ----------------------------------------------------
if (-not (Test-Path $VenvDir)) {
    Write-Host "Creating virtual environment at $VenvDir ..."
    & python -m venv $VenvDir
} else {
    Write-Host "Reusing existing virtual environment at $VenvDir"
}

$venvPython = Join-Path $VenvDir "Scripts\python.exe"
$venvPip    = Join-Path $VenvDir "Scripts\pip.exe"

# --- 3. Install dependencies --------------------------------------------
Write-Host "Installing dependencies ..."
& $venvPip install --upgrade pip
& $venvPip install -r (Join-Path $RepoRoot "requirements.txt")
& $venvPip install pyinstaller

# --- 4. Build the .exe ---------------------------------------------------
Write-Host "Building ko_print_agent.exe with PyInstaller (onefile, console) ..."
Push-Location $RepoRoot
try {
    & $venvPython -m PyInstaller `
        --onefile `
        --console `
        --name ko_print_agent `
        --distpath dist `
        --workpath build\pyinstaller_work `
        --specpath build `
        ko_print_agent.py

    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

# --- 5. Copy the example ini next to the exe ------------------------------
$exampleIni = Join-Path $RepoRoot "ko_print_agent.example.ini"
if (Test-Path $exampleIni) {
    Copy-Item $exampleIni -Destination $DistDir -Force
}

Write-Host ""
Write-Host "=== Build complete ==="
Write-Host "Executable: $DistDir\ko_print_agent.exe"
Write-Host "Next steps:"
Write-Host "  1. Copy $DistDir\ko_print_agent.example.ini to ko_print_agent.ini next to the exe"
Write-Host "  2. Edit ko_print_agent.ini: set your Odoo URL and token"
Write-Host "  3. Run: .\dist\ko_print_agent.exe --ping"
Write-Host "  4. Run: .\dist\ko_print_agent.exe --test-print <printer-ip>"
Write-Host "  5. Install as a background task: .\build\install_service.ps1"
Write-Host ""
Write-Host "=== เสร็จสิ้น ==="
Write-Host "ไฟล์โปรแกรม: $DistDir\ko_print_agent.exe"
Write-Host "ขั้นตอนถัดไป: คัดลอก ko_print_agent.example.ini เป็น ko_print_agent.ini"
Write-Host "แล้วกรอก URL และ token ของ Odoo จากนั้นทดสอบด้วย --ping และ --test-print"
