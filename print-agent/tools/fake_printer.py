#!/usr/bin/env python3
"""
fake_printer.py - a fake ESC/POS thermal printer for local testing.

Listens on TCP (default port 9100, like a real network thermal printer).
Every connection is treated as one "print job": all bytes received on that
connection are saved to captures/job-<n>.bin, and if the stream contains
GS v 0 raster image commands, they are decoded and reassembled into
captures/job-<n>.png so you can eyeball what would have been printed.

Usage:
    python fake_printer.py [port] [--captures-dir DIR]

Not a full ESC/POS emulator - just enough to validate the agent's raster
image output and confirm ack/no-crash behaviour end-to-end.
"""

from __future__ import annotations

import argparse
import socketserver
import sys
import threading
from pathlib import Path

from PIL import Image

GS_V0_PREFIX = b"\x1d\x76\x30"  # GS v 0 - print raster bit image

_counter_lock = threading.Lock()
_job_counter = 0


def next_job_number() -> int:
    global _job_counter
    with _counter_lock:
        _job_counter += 1
        return _job_counter


def decode_raster_chunks(data: bytes) -> "Image.Image | None":
    """
    Find every GS v 0 command in the byte stream and stack the decoded
    raster chunks vertically into a single PIL image (this is how
    python-escpos's bitImageRaster impl sends a tall image: as multiple
    horizontal slices).
    """
    chunks: list[Image.Image] = []
    i = 0
    n = len(data)
    while True:
        idx = data.find(GS_V0_PREFIX, i)
        if idx == -1:
            break
        header_start = idx + len(GS_V0_PREFIX)
        if header_start + 5 > n:
            break  # truncated, stop here
        m = data[header_start]  # noqa: F841 - mode byte, unused
        xL = data[header_start + 1]
        xH = data[header_start + 2]
        yL = data[header_start + 3]
        yH = data[header_start + 4]
        width_bytes = xL + xH * 256
        height_px = yL + yH * 256
        data_start = header_start + 5
        data_len = width_bytes * height_px
        data_end = data_start + data_len

        if width_bytes <= 0 or height_px <= 0 or data_end > n:
            i = idx + len(GS_V0_PREFIX)
            continue

        raster = data[data_start:data_end]
        width_px = width_bytes * 8
        img = Image.new("1", (width_px, height_px), color=1)  # 1 = white
        pixels = img.load()
        for y in range(height_px):
            row_offset = y * width_bytes
            for xb in range(width_bytes):
                byte = raster[row_offset + xb]
                for bit in range(8):
                    if byte & (0x80 >> bit):
                        x = xb * 8 + bit
                        if x < width_px:
                            pixels[x, y] = 0  # black
        chunks.append(img)
        i = data_end

    if not chunks:
        return None

    width = max(c.width for c in chunks)
    total_height = sum(c.height for c in chunks)
    combined = Image.new("1", (width, total_height), color=1)
    y_offset = 0
    for c in chunks:
        combined.paste(c, (0, y_offset))
        y_offset += c.height
    return combined


class JobHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        job_no = next_job_number()
        chunks = []
        self.request.settimeout(10)
        try:
            while True:
                data = self.request.recv(65536)
                if not data:
                    break
                chunks.append(data)
        except OSError:
            pass  # client dropped / timed out - treat what we got as the job

        payload = b"".join(chunks)
        captures_dir: Path = self.server.captures_dir  # type: ignore[attr-defined]
        captures_dir.mkdir(parents=True, exist_ok=True)

        bin_path = captures_dir / f"job-{job_no}.bin"
        bin_path.write_bytes(payload)
        print(f"[fake_printer] job-{job_no}: received {len(payload)} bytes -> {bin_path}")

        if payload:
            try:
                image = decode_raster_chunks(payload)
                if image is not None:
                    png_path = captures_dir / f"job-{job_no}.png"
                    image.save(png_path)
                    print(
                        f"[fake_printer] job-{job_no}: decoded raster image "
                        f"{image.width}x{image.height} -> {png_path}"
                    )
                else:
                    print(f"[fake_printer] job-{job_no}: no raster image commands found "
                          f"(cut/cashdrawer-only job, or non-raster impl)")
            except Exception as e:  # noqa: BLE001
                print(f"[fake_printer] job-{job_no}: could not decode raster image: {e}")


class FakePrinterServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, addr, handler, captures_dir: Path):
        super().__init__(addr, handler)
        self.captures_dir = captures_dir


def main() -> int:
    parser = argparse.ArgumentParser(description="Fake ESC/POS printer for local testing")
    parser.add_argument("port", nargs="?", type=int, default=9100)
    parser.add_argument(
        "--captures-dir", type=str,
        default=str(Path(__file__).resolve().parent.parent / "captures"),
    )
    args = parser.parse_args()

    captures_dir = Path(args.captures_dir)
    server = FakePrinterServer(("0.0.0.0", args.port), JobHandler, captures_dir)
    print(f"[fake_printer] listening on 0.0.0.0:{args.port}, captures -> {captures_dir}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[fake_printer] stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
