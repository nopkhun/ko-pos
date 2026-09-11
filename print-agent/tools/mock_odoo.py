#!/usr/bin/env python3
"""
mock_odoo.py - a tiny stand-in for the Odoo ko_print_cloud_print endpoints,
for testing ko_print_agent.py locally without a real Odoo server.

Implements:
    POST /ko_print/agent/ping
    POST /ko_print/agent/poll
    POST /ko_print/agent/ack

Fixed bearer token: "testtoken"

Serves exactly two jobs, in order, then empty polls forever after:
    1. A generated receipt image (Pillow) sized for 80mm paper, cut=True.
    2. A drawer-only job: no image, open_cashdrawer=True, cut=False.

Use --paper-width 58 to make job #1 target 58mm paper instead (to test the
58mm resize path in the agent).

Usage:
    python mock_odoo.py [--port 8070] [--printer-host 127.0.0.1]
                         [--printer-port 9100] [--paper-width 80]
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from PIL import Image, ImageDraw, ImageFont

TOKEN = "testtoken"

STATE = {
    "queue": [],       # filled in main()
    "acks": [],        # list of (job_id, status, error) received
    "poll_count": 0,
}


def build_receipt_png(paper_width: int) -> bytes:
    """Generate a fake receipt image, deliberately NOT pre-sized to the
    printer's raster width, so the agent's resize/pad logic gets exercised.
    """
    width = 520 if paper_width == 80 else 340
    height = 420
    im = Image.new("L", (width, height), color=255)
    draw = ImageDraw.Draw(im)

    try:
        font_big = ImageFont.load_default(size=28)
        font_small = ImageFont.load_default(size=18)
    except TypeError:
        font_big = ImageFont.load_default()
        font_small = ImageFont.load_default()

    y = 10
    draw.text((width / 2, y), "KO POS", fill=0, font=font_big, anchor="ma")
    y += 40
    draw.line([(10, y), (width - 10, y)], fill=0, width=2)
    y += 15
    lines = [
        "Order #KO-000123",
        "-----------------------------",
        "1 x Americano         60.00",
        "2 x Croissant        130.00",
        "-----------------------------",
        "Total                190.00",
    ]
    for line in lines:
        draw.text((15, y), line, fill=0, font=font_small)
        y += 26
    y += 10
    draw.line([(10, y), (width - 10, y)], fill=0, width=2)
    y += 15
    draw.text((width / 2, y), "Thank you / mock receipt", fill=0, font=font_small, anchor="ma")

    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def make_jobs(
    printer_host: str, printer_port: int, paper_width: int, include_bad_job: bool = False
) -> list[dict]:
    receipt_png = build_receipt_png(paper_width)
    jobs = []

    if include_bad_job:
        # Malformed job (non-numeric port) to prove the agent's process_job
        # catches bad fields, acks "error", and keeps processing the rest of
        # the batch instead of dying / dropping subsequent jobs.
        jobs.append({
            "id": "bad-1",
            "host": printer_host,
            "port": "abc",  # not an int - int(job["port"]) must raise, be caught
            "paper_width": paper_width,
            "image_png_b64": None,
            "cut": False,
            "open_cashdrawer": False,
            "origin": "mock_odoo bad job (malformed port)",
        })

    jobs.append({
        "id": 1,
        "host": printer_host,
        "port": printer_port,
        "paper_width": paper_width,
        "image_png_b64": base64.b64encode(receipt_png).decode("ascii"),
        "cut": True,
        "open_cashdrawer": False,
        "origin": "mock_odoo test job 1 (receipt image)",
    })
    jobs.append({
        "id": 2,
        "host": printer_host,
        "port": printer_port,
        "paper_width": paper_width,
        "image_png_b64": None,
        "cut": False,
        "open_cashdrawer": True,
        "origin": "mock_odoo test job 2 (drawer only)",
    })
    return jobs


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def _check_auth(self) -> bool:
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {TOKEN}"

    def log_message(self, fmt, *args):  # noqa: A003 - quieter default logging
        print(f"[mock_odoo] {self.address_string()} {fmt % args}")

    def do_POST(self) -> None:  # noqa: N802
        if not self._check_auth():
            self._send_json(401, {"ok": False, "error": "unauthorized"})
            return

        body = self._read_json()

        if self.path == "/ko_print/agent/ping":
            print(f"[mock_odoo] PING from agent_version={body.get('agent_version')}")
            self._send_json(200, {"ok": True, "agent": {"name": "mock_odoo", "shop": "test"}})
            return

        if self.path == "/ko_print/agent/poll":
            STATE["poll_count"] += 1
            jobs = STATE["queue"]
            STATE["queue"] = []  # served once
            print(f"[mock_odoo] POLL #{STATE['poll_count']}: returning {len(jobs)} job(s)")
            self._send_json(200, {"jobs": jobs})
            return

        if self.path == "/ko_print/agent/ack":
            job_id = body.get("job_id")
            status = body.get("status")
            error = body.get("error")
            STATE["acks"].append((job_id, status, error))
            print(f"[mock_odoo] ACK job_id={job_id} status={status} error={error!r}")
            self._send_json(200, {"ok": True})
            return

        self._send_json(404, {"ok": False, "error": "not found"})


def main() -> int:
    parser = argparse.ArgumentParser(description="Mock Odoo ko_print endpoints")
    parser.add_argument("--port", type=int, default=8070)
    parser.add_argument("--printer-host", type=str, default="127.0.0.1")
    parser.add_argument("--printer-port", type=int, default=9100)
    parser.add_argument("--paper-width", type=int, default=80, choices=[58, 80])
    parser.add_argument(
        "--include-bad-job", action="store_true",
        help="Prepend a malformed job (non-numeric port) to the queue, to test "
             "that the agent catches it, acks status=error, and keeps going.",
    )
    args = parser.parse_args()

    STATE["queue"] = make_jobs(
        args.printer_host, args.printer_port, args.paper_width,
        include_bad_job=args.include_bad_job,
    )

    server = HTTPServer(("0.0.0.0", args.port), Handler)
    print(
        f"[mock_odoo] listening on 0.0.0.0:{args.port}, token={TOKEN!r}, "
        f"jobs target printer {args.printer_host}:{args.printer_port} "
        f"paper_width={args.paper_width}mm"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[mock_odoo] stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
