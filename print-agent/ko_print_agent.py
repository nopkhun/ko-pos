#!/usr/bin/env python3
"""
KO Print Agent
==============

Shop-side background agent for KO POS. Polls Odoo for print jobs and sends
them to a LAN thermal printer (ESC/POS over raw TCP port 9100), such as the
EASY PRINT ES-8803WA.

Runs on a Windows PC in the shop, permanently (see build/install_service.ps1
for Task Scheduler installation). Must be resilient: it should never crash
and stay dead - if Odoo or the printer is unreachable it retries forever.

Usage:
    python ko_print_agent.py                     Run the normal poll loop
    python ko_print_agent.py --ping               Ping Odoo once and exit
    python ko_print_agent.py --test-print <host> [port]
                                                   Print a built-in test image
                                                   directly to a printer,
                                                   bypassing Odoo entirely.

Configuration is read from ko_print_agent.ini, located next to this script
(or next to the .exe when built with PyInstaller). See
ko_print_agent.example.ini for the format.
"""

from __future__ import annotations

import argparse
import base64
import configparser
import io
import logging
import logging.handlers
import signal
import socket
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

try:
    import requests
except ImportError:  # pragma: no cover
    print("ERROR: missing dependency 'requests'. Run: pip install -r requirements.txt")
    print("ผิดพลาด: ขาด library 'requests' กรุณารัน: pip install -r requirements.txt")
    sys.exit(1)

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    print("ERROR: missing dependency 'Pillow'. Run: pip install -r requirements.txt")
    print("ผิดพลาด: ขาด library 'Pillow' กรุณารัน: pip install -r requirements.txt")
    sys.exit(1)

try:
    from escpos.printer import Network
    from escpos.exceptions import Error as EscposError
except ImportError:  # pragma: no cover
    print("ERROR: missing dependency 'python-escpos'. Run: pip install -r requirements.txt")
    print("ผิดพลาด: ขาด library 'python-escpos' กรุณารัน: pip install -r requirements.txt")
    sys.exit(1)


AGENT_VERSION = "1.0.1"

DEFAULT_POLL_INTERVAL = 1.0
DEFAULT_LOG_FILE = "ko_print_agent.log"
DEFAULT_IMAGE_IMPL = "bitImageRaster"
MAX_JOBS_PER_POLL = 10

PING_RETRY_SECONDS = 30
BACKOFF_MIN_SECONDS = 2
BACKOFF_MAX_SECONDS = 30

PRINTER_CONNECT_TIMEOUT = 5  # seconds - just for establishing the TCP connection
DEFAULT_PRINTER_SEND_TIMEOUT = 30  # seconds - ini-configurable, see [agent] printer_send_timeout
HTTP_TIMEOUT = 10  # seconds

RASTER_WIDTH_80MM = 576
RASTER_WIDTH_58MM = 384

log = logging.getLogger("ko_print_agent")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class Config:
    odoo_url: str
    token: str
    poll_interval: float
    log_file: str
    image_impl: str
    printer_send_timeout: float
    ini_path: Path


def base_dir() -> Path:
    """Directory containing the script, or the PyInstaller .exe when frozen."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def load_config(ini_path: Optional[Path] = None) -> Config:
    path = ini_path or (base_dir() / "ko_print_agent.ini")
    if not path.exists():
        example = base_dir() / "ko_print_agent.example.ini"
        msg = (
            f"Config file not found: {path}\n"
            f"ไม่พบไฟล์ตั้งค่า: {path}\n"
            f"Copy {example.name} to {path.name} and fill in your token.\n"
            f"คัดลอกไฟล์ {example.name} เป็น {path.name} แล้วกรอก token ให้เรียบร้อย"
        )
        raise SystemExit(msg)

    parser = configparser.ConfigParser()
    parser.read(path, encoding="utf-8")

    odoo_url = parser.get("odoo", "url", fallback="").strip().rstrip("/")
    token = parser.get("odoo", "token", fallback="").strip()
    poll_interval = parser.getfloat("agent", "poll_interval", fallback=DEFAULT_POLL_INTERVAL)
    log_file = parser.get("agent", "log_file", fallback=DEFAULT_LOG_FILE).strip()
    image_impl = parser.get("agent", "image_impl", fallback=DEFAULT_IMAGE_IMPL).strip()
    printer_send_timeout = parser.getfloat(
        "agent", "printer_send_timeout", fallback=DEFAULT_PRINTER_SEND_TIMEOUT
    )

    if not odoo_url:
        raise SystemExit("Config error: [odoo] url is empty / ไม่ได้ตั้งค่า [odoo] url")
    if not token or token == "PASTE_TOKEN_HERE":
        raise SystemExit(
            "Config error: [odoo] token is empty or not set.\n"
            "ไม่ได้ตั้งค่า token กรุณาคัดลอกจาก Odoo > Point of Sale > "
            "Configuration > Print Agents"
        )
    if image_impl not in ("bitImageRaster", "bitImageColumn"):
        log_startup_warning = (
            f"Unknown image_impl '{image_impl}', falling back to {DEFAULT_IMAGE_IMPL}"
        )
        print(f"[WARN] {log_startup_warning}")
        image_impl = DEFAULT_IMAGE_IMPL

    return Config(
        odoo_url=odoo_url,
        token=token,
        poll_interval=poll_interval,
        log_file=log_file,
        image_impl=image_impl,
        printer_send_timeout=printer_send_timeout,
        ini_path=path,
    )


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def setup_logging(cfg: Config) -> None:
    log.setLevel(logging.DEBUG)
    log.handlers.clear()
    # Some dependencies (e.g. python-escpos) call logging.basicConfig(),
    # which attaches a handler to the root logger. Without this, every
    # message would be printed twice (once by our handler, once by root's).
    log.propagate = False

    fmt = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    console.setLevel(logging.INFO)
    log.addHandler(console)

    log_path = base_dir() / cfg.log_file
    try:
        file_handler = logging.handlers.RotatingFileHandler(
            log_path, maxBytes=1 * 1024 * 1024, backupCount=5, encoding="utf-8"
        )
        file_handler.setFormatter(fmt)
        file_handler.setLevel(logging.DEBUG)
        log.addHandler(file_handler)
    except OSError as e:
        # Don't crash the agent just because the log file can't be opened.
        print(f"[WARN] Could not open log file {log_path}: {e}")


# ---------------------------------------------------------------------------
# Odoo HTTP client
# ---------------------------------------------------------------------------

class OdooError(Exception):
    pass


class OdooAuthError(OdooError):
    pass


# One shared session (connection keep-alive) for all Odoo calls, instead of
# opening a brand new TCP+TLS connection on every single poll/ack/ping.
_http_session = requests.Session()


def _odoo_post(cfg: Config, path: str, body: dict) -> dict:
    url = f"{cfg.odoo_url}{path}"
    headers = {
        "Authorization": f"Bearer {cfg.token}",
        "Content-Type": "application/json",
    }
    try:
        resp = _http_session.post(url, json=body, headers=headers, timeout=HTTP_TIMEOUT)
    except requests.RequestException as e:
        raise OdooError(f"network error calling {path}: {e}") from e

    if resp.status_code == 401:
        raise OdooAuthError(f"401 Unauthorized on {path}")
    if resp.status_code >= 400:
        raise OdooError(f"HTTP {resp.status_code} on {path}: {resp.text[:300]}")

    try:
        return resp.json()
    except ValueError as e:
        raise OdooError(f"invalid JSON response from {path}: {e}") from e


def ping(cfg: Config) -> dict:
    """POST /ko_print/agent/ping. Returns the parsed JSON on success."""
    body = {"agent_version": AGENT_VERSION}
    result = _odoo_post(cfg, "/ko_print/agent/ping", body)
    if not result.get("ok"):
        raise OdooError(f"ping did not return ok=true: {result}")
    return result


def poll_jobs(cfg: Config) -> list[dict]:
    """POST /ko_print/agent/poll. Returns the list of jobs (possibly empty)."""
    body = {"agent_version": AGENT_VERSION, "max_jobs": MAX_JOBS_PER_POLL}
    result = _odoo_post(cfg, "/ko_print/agent/poll", body)
    jobs = result.get("jobs") or []
    if not isinstance(jobs, list):
        raise OdooError(f"unexpected /poll response shape: {result}")
    return jobs


def ack_job(cfg: Config, job_id: Any, status: str, error: Optional[str] = None) -> None:
    body: dict = {"job_id": job_id, "status": status}
    if error is not None:
        body["error"] = error[:500]
    try:
        _odoo_post(cfg, "/ko_print/agent/ack", body)
    except OdooError as e:
        # Acking is best-effort - don't let a failed ack crash the loop.
        # The job will likely be retried/re-queued by Odoo on the next poll.
        log.warning(
            "Could not ack job %s (status=%s): %s / ไม่สามารถส่ง ack งาน %s ได้",
            job_id, status, e, job_id,
        )


# ---------------------------------------------------------------------------
# Image rendering
# ---------------------------------------------------------------------------

def pad_width_to_multiple_of_8(im: "Image.Image") -> "Image.Image":
    """Pad an image's width with white pixels so it's a multiple of 8 px."""
    w, h = im.size
    remainder = w % 8
    if remainder == 0:
        return im
    pad = 8 - remainder
    new_im = Image.new(im.mode, (w + pad, h), color=255 if im.mode != "1" else 1)
    new_im.paste(im, (0, 0))
    return new_im


def prepare_receipt_image(png_bytes: bytes, paper_width: int) -> "Image.Image":
    """
    Decode a PNG, convert to grayscale, scale to the printer's raster width
    (keeping aspect ratio), and dither to 1-bit for ESC/POS raster printing.
    """
    target_width = RASTER_WIDTH_80MM if paper_width == 80 else RASTER_WIDTH_58MM

    im = Image.open(io.BytesIO(png_bytes))
    im = im.convert("L")  # grayscale

    if im.width != target_width:
        new_height = max(1, round(im.height * (target_width / im.width)))
        im = im.resize((target_width, new_height), Image.LANCZOS)

    im = im.convert("1")  # 1-bit, Floyd-Steinberg dithering is PIL's default
    im = pad_width_to_multiple_of_8(im)
    return im


def build_test_image() -> "Image.Image":
    """Built-in test image for --test-print: a border box + big text."""
    width, height = RASTER_WIDTH_80MM, 300
    im = Image.new("L", (width, height), color=255)
    draw = ImageDraw.Draw(im)

    border = 6
    draw.rectangle(
        [border, border, width - border - 1, height - border - 1],
        outline=0,
        width=4,
    )

    text = "KO PRINT AGENT OK"
    try:
        font = ImageFont.load_default(size=32)
    except TypeError:
        # Older Pillow versions don't support the `size` kwarg.
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    draw.text(
        ((width - text_w) / 2, (height - text_h) / 2 - bbox[1]),
        text,
        fill=0,
        font=font,
    )

    im = im.convert("1")
    im = pad_width_to_multiple_of_8(im)
    return im


# ---------------------------------------------------------------------------
# Printing
# ---------------------------------------------------------------------------

def send_to_printer(
    host: str,
    port: int,
    image: Optional["Image.Image"],
    cut: bool,
    open_cashdrawer: bool,
    image_impl: str,
    send_timeout: float = DEFAULT_PRINTER_SEND_TIMEOUT,
) -> None:
    printer = Network(host, port=port, timeout=PRINTER_CONNECT_TIMEOUT)
    try:
        # Connect using the short PRINTER_CONNECT_TIMEOUT first (fail fast if
        # the printer is unreachable). python-escpos reuses whatever timeout
        # was set at connect time for every socket op afterwards (sendall
        # included) and never resets it - so without this, a large receipt
        # image could time out mid-send, producing a partial print and then
        # a duplicate on the next retry. Relax it here before sending data.
        printer.open()
        printer.device.settimeout(send_timeout)

        if image is not None:
            printer.image(image, impl=image_impl)
            printer.text("\n")
        if cut:
            printer.cut()
        if open_cashdrawer:
            printer.cashdraw(2)
    finally:
        try:
            printer.close()
        except Exception:  # pragma: no cover - best-effort cleanup
            pass


def process_job(cfg: Config, job: dict) -> None:
    # Only `id` is trusted before the try block - everything else about a job
    # (port, paper_width, ...) may be malformed, and must not raise out of
    # this function: that would abort the rest of the batch in run_loop's
    # for-loop and skip the ack entirely. Every bit of parsing/validation
    # below therefore happens inside the try so a bad job is caught, logged
    # once, and acked "error" - then the loop moves on to the next job.
    job_id = job.get("id")

    try:
        host = job.get("host")
        port = int(job.get("port") or 9100)
        paper_width = int(job.get("paper_width") or 80)
        image_b64 = job.get("image_png_b64")
        cut = bool(job.get("cut"))
        open_cashdrawer = bool(job.get("open_cashdrawer"))
        origin = job.get("origin") or "?"

        log.info(
            "Job %s: host=%s:%s paper=%smm cut=%s drawer=%s origin=%s "
            "/ งาน %s: เครื่อง %s:%s กระดาษ %smm ตัด=%s เปิดลิ้นชัก=%s ที่มา=%s",
            job_id, host, port, paper_width, cut, open_cashdrawer, origin,
            job_id, host, port, paper_width, cut, open_cashdrawer, origin,
        )

        image = None
        if image_b64:
            png_bytes = base64.b64decode(image_b64)
            image = prepare_receipt_image(png_bytes, paper_width)

        send_to_printer(
            host, port, image, cut, open_cashdrawer, cfg.image_impl,
            send_timeout=cfg.printer_send_timeout,
        )

        log.info("Job %s: printed OK / งาน %s: พิมพ์สำเร็จ", job_id, job_id)
        ack_job(cfg, job_id, "done")

    except Exception as e:  # noqa: BLE001 - must never let one bad job kill the loop
        err_text = f"{type(e).__name__}: {e}"
        log.error(
            "Job %s: FAILED (%s) / งาน %s: ล้มเหลว (%s)",
            job_id, err_text, job_id, err_text,
        )
        ack_job(cfg, job_id, "error", error=err_text)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

class ShutdownRequested(Exception):
    pass


_shutdown_flag = False


def _handle_signal(signum, frame):  # noqa: ANN001
    global _shutdown_flag
    _shutdown_flag = True


def wait_for_odoo(cfg: Config) -> None:
    """
    Block (retrying) until we can successfully ping Odoo. Handles auth
    errors specially per spec: keep retrying every 30s, never exit.
    """
    last_state: Optional[str] = None
    while not _shutdown_flag:
        try:
            result = ping(cfg)
            if last_state != "ok":
                log.info(
                    "Ping OK, connected to Odoo. Agent: %s / เชื่อมต่อ Odoo สำเร็จ",
                    result.get("agent"),
                )
            return
        except OdooAuthError:
            if last_state != "auth_error":
                log.error(
                    "Token ผิด / invalid token. Please check ko_print_agent.ini "
                    "against Odoo > Point of Sale > Configuration > Print Agents. "
                    "Retrying every %ss...",
                    PING_RETRY_SECONDS,
                )
                last_state = "auth_error"
            _sleep_interruptible(PING_RETRY_SECONDS)
        except OdooError as e:
            if last_state != "network_error":
                log.warning(
                    "Cannot reach Odoo (%s). Retrying every %ss until connected "
                    "/ เชื่อมต่อ Odoo ไม่ได้ กำลังลองใหม่เรื่อยๆ ทุก %s วินาที",
                    e, PING_RETRY_SECONDS, PING_RETRY_SECONDS,
                )
                last_state = "network_error"
            _sleep_interruptible(PING_RETRY_SECONDS)


def _sleep_interruptible(seconds: float) -> None:
    end = time.monotonic() + seconds
    while not _shutdown_flag and time.monotonic() < end:
        time.sleep(min(0.5, max(0.0, end - time.monotonic())))


def run_loop(cfg: Config) -> None:
    log.info(
        "KO Print Agent v%s starting. Odoo=%s poll_interval=%ss image_impl=%s "
        "/ เริ่มโปรแกรม KO Print Agent เวอร์ชัน %s",
        AGENT_VERSION, cfg.odoo_url, cfg.poll_interval, cfg.image_impl, AGENT_VERSION,
    )

    wait_for_odoo(cfg)

    backoff = BACKOFF_MIN_SECONDS
    last_poll_state: Optional[str] = "ok"

    while not _shutdown_flag:
        try:
            jobs = poll_jobs(cfg)
            if last_poll_state != "ok":
                log.info("Reconnected to Odoo / เชื่อมต่อ Odoo กลับมาได้แล้ว")
                last_poll_state = "ok"
            backoff = BACKOFF_MIN_SECONDS

            for job in jobs:
                if _shutdown_flag:
                    break
                process_job(cfg, job)

            _sleep_interruptible(cfg.poll_interval)

        except OdooAuthError:
            log.error(
                "Token ผิด / invalid token detected mid-run. "
                "Retrying every %ss until fixed...", PING_RETRY_SECONDS,
            )
            wait_for_odoo(cfg)

        except OdooError as e:
            if last_poll_state != "network_error":
                log.warning(
                    "Lost connection to Odoo (%s). Backing off... "
                    "/ ขาดการเชื่อมต่อกับ Odoo กำลังลองใหม่",
                    e,
                )
                last_poll_state = "network_error"
            _sleep_interruptible(backoff)
            backoff = min(BACKOFF_MAX_SECONDS, backoff * 2)

        except Exception as e:  # noqa: BLE001 - the loop must never die
            log.exception(
                "Unexpected error in main loop, continuing / "
                "เกิดข้อผิดพลาดไม่คาดคิดในลูปหลัก แต่โปรแกรมจะทำงานต่อ: %s", e,
            )
            _sleep_interruptible(backoff)
            backoff = min(BACKOFF_MAX_SECONDS, backoff * 2)

    log.info("Shutting down cleanly / ปิดโปรแกรมเรียบร้อย")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_ping(cfg: Config) -> int:
    try:
        result = ping(cfg)
        print(f"[OK] Ping succeeded / เชื่อมต่อ Odoo สำเร็จ: {result}")
        return 0
    except OdooAuthError:
        print("[ERROR] 401 Unauthorized - token ผิด. Check ko_print_agent.ini")
        return 1
    except OdooError as e:
        print(f"[ERROR] Ping failed / เชื่อมต่อไม่สำเร็จ: {e}")
        return 1


def cmd_test_print(cfg: Config, host: str, port: int) -> int:
    print(f"[INFO] Sending built-in test image to {host}:{port} ...")
    print(f"[INFO] กำลังส่งภาพทดสอบไปที่ {host}:{port} ...")
    try:
        image = build_test_image()
        send_to_printer(
            host, port, image, cut=True, open_cashdrawer=False,
            image_impl=cfg.image_impl, send_timeout=cfg.printer_send_timeout,
        )
        print("[OK] Test print sent / ส่งคำสั่งพิมพ์ทดสอบสำเร็จ กรุณาดูที่เครื่องพิมพ์")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"[ERROR] Test print failed / พิมพ์ทดสอบล้มเหลว: {e}")
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="KO Print Agent")
    parser.add_argument("--ping", action="store_true", help="Ping Odoo once and exit")
    parser.add_argument(
        "--test-print", nargs=1, metavar="HOST",
        help="Print a built-in test image directly to HOST, bypassing Odoo",
    )
    parser.add_argument(
        "port", nargs="?", type=int, default=9100,
        help="Port for --test-print (default 9100)",
    )
    parser.add_argument(
        "--config", type=str, default=None,
        help="Path to ko_print_agent.ini (default: next to this script)",
    )
    args = parser.parse_args()

    ini_path = Path(args.config).resolve() if args.config else None
    cfg = load_config(ini_path)
    setup_logging(cfg)

    signal.signal(signal.SIGINT, _handle_signal)
    try:
        signal.signal(signal.SIGTERM, _handle_signal)
    except (AttributeError, ValueError):
        pass  # SIGTERM not available on all platforms

    if args.ping:
        return cmd_ping(cfg)

    if args.test_print:
        host = args.test_print[0]
        return cmd_test_print(cfg, host, args.port)

    try:
        run_loop(cfg)
        return 0
    except KeyboardInterrupt:
        log.info("Interrupted by user (Ctrl-C) / ผู้ใช้กดหยุดโปรแกรม")
        return 0


if __name__ == "__main__":
    sys.exit(main())
