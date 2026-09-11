#!/usr/bin/env python3
"""
KO POS - Phase 0 printer test / ทดสอบเครื่องพิมพ์ (ก่อนติดตั้งระบบจริง)
=========================================================================

Standard-library only. No pip install needed. Works with plain Python 3.

Usage / วิธีใช้:
    python test_print.py <printer-ip> [port]

Example / ตัวอย่าง:
    python test_print.py 192.168.1.50
    python test_print.py 192.168.1.50 9100

What it does / มันทำอะไร:
    1. Opens a raw TCP socket to the printer on the given IP:port
       (default port 9100, the standard raw ESC/POS port for this class
       of printer, including the EASY PRINT ES-8803WA).
    2. Sends an ESC/POS initialize command.
    3. Prints a few lines of plain ASCII text, a bold+centered
       "KO POS TEST OK" line, and a timestamp.
    4. Feeds paper and sends a full-cut command.
    5. Prints clear success/error messages in Thai and English.

This script deliberately contains NO Thai text in the receipt itself -
the printer's internal font cannot render Thai. Thai receipts will be
sent as an image (rendered in a browser / by the real agent), not as
raw text. This script is only to prove IP + port + cabling + printer
are all working.
"""

import socket
import sys
import datetime


def build_escpos_payload() -> bytes:
    """Build the raw ESC/POS byte stream for the test receipt."""
    ESC = b"\x1b"
    GS = b"\x1d"

    init = ESC + b"@"            # ESC @  -> initialize printer
    align_center = ESC + b"a" + b"\x01"   # ESC a 1 -> center align
    align_left = ESC + b"a" + b"\x00"     # ESC a 0 -> left align
    bold_on = ESC + b"E" + b"\x01"        # ESC E 1 -> bold on
    bold_off = ESC + b"E" + b"\x00"       # ESC E 0 -> bold off
    double_on = GS + b"!" + b"\x11"       # GS ! 0x11 -> double width+height
    double_off = GS + b"!" + b"\x00"      # GS ! 0x00 -> normal size

    feed_lines = ESC + b"d" + bytes([3])  # ESC d 3 -> feed 3 lines
    full_cut = GS + b"V" + b"\x00"        # GS V 0   -> full cut
    # Fallback some firmwares expect: GS V 66 0 (feed-then-cut variant).
    # Uncomment the next line instead of full_cut above if paper is not
    # cut on your printer:
    # full_cut = GS + b"V" + b"\x42" + b"\x00"

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    lines = []
    lines.append(init)
    lines.append(align_left)
    lines.append(b"KO POS - Printer Test\n")
    lines.append(b"------------------------------\n")
    lines.append(b"This is a plain ASCII test print.\n")
    lines.append(b"Thai text is NOT tested here.\n")
    lines.append(b"(Thai receipts print as an image.)\n")
    lines.append(b"\n")
    lines.append(align_center)
    lines.append(bold_on + double_on)
    lines.append(b"KO POS TEST OK\n")
    lines.append(double_off + bold_off)
    lines.append(b"\n")
    lines.append(align_left)
    lines.append(("Timestamp: %s\n" % now).encode("ascii"))
    lines.append(b"------------------------------\n")
    lines.append(feed_lines)
    lines.append(full_cut)

    return b"".join(lines)


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage / วิธีใช้: python test_print.py <printer-ip> [port]")
        print("Example / ตัวอย่าง: python test_print.py 192.168.1.50 9100")
        return 2

    ip = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 9100
    timeout_seconds = 5

    print(f"[INFO] Connecting to {ip}:{port} (timeout {timeout_seconds}s) ...")
    print(f"[INFO] กำลังเชื่อมต่อไปที่ {ip}:{port} (timeout {timeout_seconds} วินาที) ...")

    payload = build_escpos_payload()

    try:
        with socket.create_connection((ip, port), timeout=timeout_seconds) as sock:
            sock.settimeout(timeout_seconds)
            sock.sendall(payload)
        print("[OK] Test print sent successfully.")
        print("[OK] ส่งคำสั่งพิมพ์ทดสอบสำเร็จแล้ว กรุณาดูที่เครื่องพิมพ์")
        print("      (If nothing printed, check paper, power, and that the")
        print("       printer is on the same WiFi network as this PC.)")
        print("      (ถ้ากระดาษไม่ออก ให้ตรวจสอบกระดาษ, ปลั๊กไฟ, และว่าเครื่องพิมพ์")
        print("       อยู่ใน WiFi วงเดียวกับคอมพิวเตอร์เครื่องนี้หรือไม่)")
        return 0

    except socket.timeout:
        print(f"[ERROR] Connection to {ip}:{port} timed out after {timeout_seconds}s.")
        print(f"[ERROR] เชื่อมต่อไปที่ {ip}:{port} ไม่สำเร็จ (หมดเวลา {timeout_seconds} วินาที)")
        print("        Check: printer IP is correct, printer is powered on,")
        print("        printer is connected to WiFi, and PC + printer are on")
        print("        the SAME network. Try Test-NetConnection in PowerShell.")
        print("        ตรวจสอบ: IP ถูกต้องหรือไม่, เครื่องพิมพ์เปิดอยู่หรือไม่,")
        print("        เครื่องพิมพ์ต่อ WiFi แล้วหรือยัง, และคอมพิวเตอร์กับเครื่องพิมพ์")
        print("        อยู่ในเครือข่ายเดียวกันหรือไม่ ลองใช้คำสั่ง Test-NetConnection")
        return 1

    except ConnectionRefusedError:
        print(f"[ERROR] Connection to {ip}:{port} was refused.")
        print(f"[ERROR] เครื่องพิมพ์ปฏิเสธการเชื่อมต่อที่ {ip}:{port}")
        print("        The printer is reachable but port 9100 is closed/wrong.")
        print("        Double-check the port number (usually 9100).")
        print("        เครื่องพิมพ์ตอบสนอง แต่พอร์ต 9100 อาจไม่ถูกต้อง")
        print("        กรุณาตรวจสอบหมายเลขพอร์ตอีกครั้ง (โดยทั่วไปคือ 9100)")
        return 1

    except OSError as e:
        print(f"[ERROR] Network error while connecting to {ip}:{port}: {e}")
        print(f"[ERROR] เกิดข้อผิดพลาดของเครือข่ายขณะเชื่อมต่อ {ip}:{port}: {e}")
        print("        Check the IP address and that this PC is on the same")
        print("        WiFi/LAN as the printer.")
        print("        ตรวจสอบ IP และว่าคอมพิวเตอร์เครื่องนี้อยู่ใน WiFi/LAN")
        print("        เดียวกับเครื่องพิมพ์หรือไม่")
        return 1

    except Exception as e:  # pragma: no cover - defensive catch-all
        print(f"[ERROR] Unexpected error: {e}")
        print(f"[ERROR] เกิดข้อผิดพลาดที่ไม่คาดคิด: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
