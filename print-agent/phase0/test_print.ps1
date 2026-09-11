<#
.SYNOPSIS
    KO POS - Phase 0 printer test (PowerShell version, no Python required)
    ทดสอบเครื่องพิมพ์ KO POS แบบไม่ต้องลง Python

.DESCRIPTION
    Opens a raw TCP connection to the thermal printer (System.Net.Sockets.TcpClient,
    built into every Windows PC - nothing to install) and sends a plain-ASCII
    ESC/POS test receipt, then a full paper cut.

    Use this BEFORE installing Python, just to confirm the printer's IP address
    and network connection are working.

    ใช้สคริปต์นี้ก่อนติดตั้ง Python เพื่อตรวจสอบว่า IP ของเครื่องพิมพ์และการเชื่อมต่อ
    เครือข่ายใช้งานได้หรือไม่

.PARAMETER IpAddress
    The printer's IP address, e.g. 192.168.1.50
    IP ของเครื่องพิมพ์ เช่น 192.168.1.50

.PARAMETER Port
    TCP port, default 9100 (standard raw ESC/POS port).
    พอร์ต TCP ค่าเริ่มต้นคือ 9100

.EXAMPLE
    .\test_print.ps1 -IpAddress 192.168.1.50
    .\test_print.ps1 192.168.1.50 9100
#>

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$IpAddress,

    [Parameter(Position = 1)]
    [int]$Port = 9100
)

$TimeoutMs = 5000

Write-Host "[INFO] Connecting to $IpAddress`:$Port (timeout $($TimeoutMs/1000)s) ..."
Write-Host "[INFO] กำลังเชื่อมต่อไปที่ $IpAddress`:$Port (timeout $($TimeoutMs/1000) วินาที) ..."

# --- Build the ESC/POS payload (plain ASCII only, no Thai) ---------------
$ESC = [byte]0x1B
$GS  = [byte]0x1D

$bytes = New-Object System.Collections.Generic.List[byte]

function Add-Bytes([byte[]]$b) {
    foreach ($x in $b) { $bytes.Add($x) }
}
function Add-Text([string]$s) {
    Add-Bytes ([System.Text.Encoding]::ASCII.GetBytes($s))
}

Add-Bytes @($ESC, [byte][char]'@')                       # ESC @  initialize
Add-Bytes @($ESC, [byte][char]'a', 0x00)                 # ESC a 0  left align
Add-Text "KO POS - Printer Test`n"
Add-Text "------------------------------`n"
Add-Text "This is a plain ASCII test print.`n"
Add-Text "Thai text is NOT tested here.`n"
Add-Text "(Thai receipts print as an image.)`n"
Add-Text "`n"
Add-Bytes @($ESC, [byte][char]'a', 0x01)                 # ESC a 1  center align
Add-Bytes @($ESC, [byte][char]'E', 0x01)                 # ESC E 1  bold on
Add-Bytes @($GS,  [byte][char]'!', 0x11)                 # GS ! 0x11 double size
Add-Text "KO POS TEST OK`n"
Add-Bytes @($GS,  [byte][char]'!', 0x00)                 # normal size
Add-Bytes @($ESC, [byte][char]'E', 0x00)                 # bold off
Add-Text "`n"
Add-Bytes @($ESC, [byte][char]'a', 0x00)                 # left align
Add-Text ("Timestamp: {0}`n" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
Add-Text "------------------------------`n"
Add-Bytes @($ESC, [byte][char]'d', 3)                    # feed 3 lines
Add-Bytes @($GS,  [byte][char]'V', 0x00)                  # full cut

$payload = $bytes.ToArray()

# --- Send it ----------------------------------------------------------
$client = New-Object System.Net.Sockets.TcpClient
try {
    $connectTask = $client.ConnectAsync($IpAddress, $Port)
    if (-not $connectTask.Wait($TimeoutMs)) {
        throw "timeout"
    }

    $stream = $client.GetStream()
    $stream.Write($payload, 0, $payload.Length)
    $stream.Flush()

    Write-Host "[OK] Test print sent successfully."
    Write-Host "[OK] ส่งคำสั่งพิมพ์ทดสอบสำเร็จแล้ว กรุณาดูที่เครื่องพิมพ์"
    Write-Host "      (If nothing printed, check paper, power, and that the"
    Write-Host "       printer is on the same WiFi network as this PC.)"
    Write-Host "      (ถ้ากระดาษไม่ออก ให้ตรวจสอบกระดาษ, ปลั๊กไฟ, และว่าเครื่องพิมพ์"
    Write-Host "       อยู่ใน WiFi วงเดียวกับคอมพิวเตอร์เครื่องนี้หรือไม่)"
    exit 0
}
catch {
    $msg = $_.Exception.Message
    if ($msg -eq "timeout" -or $msg -match "timed out" -or $msg -match "timeout") {
        Write-Host "[ERROR] Connection to $IpAddress`:$Port timed out after $($TimeoutMs/1000)s."
        Write-Host "[ERROR] เชื่อมต่อไปที่ $IpAddress`:$Port ไม่สำเร็จ (หมดเวลา $($TimeoutMs/1000) วินาที)"
    }
    elseif ($msg -match "refused") {
        Write-Host "[ERROR] Connection to $IpAddress`:$Port was refused."
        Write-Host "[ERROR] เครื่องพิมพ์ปฏิเสธการเชื่อมต่อที่ $IpAddress`:$Port"
        Write-Host "        Double-check the port number (usually 9100)."
        Write-Host "        กรุณาตรวจสอบหมายเลขพอร์ตอีกครั้ง (โดยทั่วไปคือ 9100)"
    }
    else {
        Write-Host "[ERROR] Network error while connecting to $IpAddress`:$Port : $msg"
        Write-Host "[ERROR] เกิดข้อผิดพลาดของเครือข่ายขณะเชื่อมต่อ $IpAddress`:$Port : $msg"
    }
    Write-Host "        Check: printer IP is correct, printer is powered on,"
    Write-Host "        printer is connected to WiFi, and PC + printer are on"
    Write-Host "        the SAME network. Try: Test-NetConnection $IpAddress -Port $Port"
    Write-Host "        ตรวจสอบ: IP ถูกต้องหรือไม่, เครื่องพิมพ์เปิดอยู่หรือไม่,"
    Write-Host "        เครื่องพิมพ์ต่อ WiFi แล้วหรือยัง, และคอมพิวเตอร์กับเครื่องพิมพ์"
    Write-Host "        อยู่ในเครือข่ายเดียวกันหรือไม่"
    exit 1
}
finally {
    $client.Close()
}
