/* KO KDS Screen — Vanilla JS Client
 *
 * Written for a counter tablet at roughly 50 cm and for a phone in a pocket.
 * Three behaviours here exist because of the room this runs in, and they are
 * easy to break by accident, so they are called out up front:
 *
 * 1. OPTIMISTIC TAPS. The board polls every 2 s. If a tap only changed the
 *    screen after the round trip, staff would tap twice — and the second tap
 *    toggles the dish back off. Every tap therefore paints immediately and the
 *    poll is prevented from undoing it until the server agrees (`pending`).
 *
 * 2. NO BLIND RE-RENDER. The old build rewrote `board.innerHTML` every 2 s,
 *    which threw away scroll position and could swap the node out from under a
 *    finger mid-tap. Now a re-render only happens when the *content* signature
 *    changes; the clock, the SLA bar and the late/warn colour are updated in
 *    place once a second by `tickTimers`.
 *
 * 3. FAILURE IS VISIBLE. A dropped wi-fi used to leave a frozen board that
 *    looked completely normal. Two consecutive failed polls now raise a red
 *    banner, because a stale kitchen board is worse than no kitchen board.
 */
(function () {
    "use strict";

    // KDS is a standalone page, so polling is retained as a resilient fallback.
    // POS clients receive the same changes immediately through Odoo's bus service.
    const POLL_MS = 2000;
    // How long an unconfirmed tap keeps overriding the server's answer.
    const OPTIMISTIC_TTL = 9000;
    // Ignore taps for a moment after one lands: acting on a dish can move its
    // card into another section, and the finger is then over a different card.
    const TAP_LOCK_MS = 350;

    const byId = function (id) { return document.getElementById(id); };

    const board = byId("board");
    const clock = byId("clock");
    const viewSeg = byId("view-seg");
    const toastHost = byId("toasts");
    const issueBg = byId("issue-bg");
    const issueTarget = byId("issue-target");
    const issueNote = byId("issue-note");
    const issueSend = byId("issue-send");
    const issueCancel = byId("issue-cancel");

    let currentTab = "active"; // 'active' | 'served' | 'cancelled'
    let currentView = "order"; // 'order' | 'menu'
    // Station filtering happens on the server (one screen = one station, chosen
    // in the station bar). There is deliberately no second client-side filter.
    const stationPicked = window.KDS_HAS_STATION_FILTER === true;

    let rawData = { active: [], served: [], cancelled: [], now_utc: new Date().toISOString(), sla_minutes: 15 };
    let lineIndex = new Map();   // line id -> line payload, rebuilt on every poll
    let pending = new Map();     // line id -> { done, at } — taps the server has not confirmed yet
    let lastSig = null;
    let knownLineIds = new Set();
    let firstLoad = true;
    let failStreak = 0;
    let tapLockUntil = 0;
    let issueState = { lineId: null, type: null };
    let audioCtx = null;
    let audioUnlocked = false;

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function fmtQty(q) {
        const n = Number(q) || 0;
        return n % 1 === 0 ? String(Math.round(n)) : String(parseFloat(n.toFixed(2)));
    }

    function buzz(ms) {
        try {
            if (navigator.vibrate) {
                navigator.vibrate(ms || 12);
            }
        } catch (e) { /* not supported */ }
    }

    // ------------------------------------------------------------------
    // Text size — WCAG 1.4.4 without letting a stray pinch wreck the kiosk
    // ------------------------------------------------------------------

    const SCALES = [0.85, 1, 1.15, 1.3, 1.5];
    let scaleIdx = 1;

    function store(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
    }

    function readStore(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }

    function applyScale() {
        document.documentElement.style.setProperty("--s", String(SCALES[scaleIdx]));
        const out = byId("zoom-out");
        const zin = byId("zoom-in");
        if (out) { out.disabled = scaleIdx === 0; }
        if (zin) { zin.disabled = scaleIdx === SCALES.length - 1; }
    }

    (function initScale() {
        const saved = parseInt(readStore("ko_kds_scale"), 10);
        if (!isNaN(saved) && saved >= 0 && saved < SCALES.length) {
            scaleIdx = saved;
        }
        applyScale();
        const out = byId("zoom-out");
        const zin = byId("zoom-in");
        if (out) {
            out.addEventListener("click", function () {
                scaleIdx = Math.max(0, scaleIdx - 1);
                store("ko_kds_scale", String(scaleIdx));
                applyScale();
                buzz();
            });
        }
        if (zin) {
            zin.addEventListener("click", function () {
                scaleIdx = Math.min(SCALES.length - 1, scaleIdx + 1);
                store("ko_kds_scale", String(scaleIdx));
                applyScale();
                buzz();
            });
        }
    })();

    // ------------------------------------------------------------------
    // Sound — a single sine at 0.35 gain loses to an extraction hood
    // ------------------------------------------------------------------

    function getAudioCtx() {
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === "suspended") {
                audioCtx.resume();
            }
            return audioCtx;
        } catch (e) {
            return null;
        }
    }

    function chime() {
        const ctx = getAudioCtx();
        if (!ctx) {
            return;
        }
        // Three rising notes, each a sine plus a triangle an octave up: the
        // harmonic is what makes it audible over a fan at the other end of a
        // hot line.
        const notes = [784, 1046, 1318];
        notes.forEach(function (freq, i) {
            [["sine", 0.42], ["triangle", 0.16]].forEach(function (voice) {
                try {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    const start = ctx.currentTime + i * 0.16;
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.type = voice[0];
                    osc.frequency.value = voice[0] === "sine" ? freq : freq * 2;
                    gain.gain.setValueAtTime(voice[1], start);
                    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
                    osc.start(start);
                    osc.stop(start + 0.32);
                } catch (e) { /* autoplay policy */ }
            });
        });
    }

    // Browsers keep AudioContext suspended until the page has been interacted
    // with. A kitchen screen is often left untouched, so unlock on the first
    // touch of the shift and tell staff when sound is still silent.
    function unlockAudio() {
        const ctx = getAudioCtx();
        if (ctx && ctx.state === "running") {
            audioUnlocked = true;
            document.removeEventListener("click", unlockAudio);
            document.removeEventListener("touchstart", unlockAudio);
        }
    }
    document.addEventListener("click", unlockAudio);
    document.addEventListener("touchstart", unlockAudio);

    function flashBoard() {
        document.body.classList.add("flash");
        setTimeout(function () { document.body.classList.remove("flash"); }, 950);
    }

    // ------------------------------------------------------------------
    // Toasts, with a real undo where the server action is reversible
    // ------------------------------------------------------------------

    let toastTimer = null;

    function toast(msg, undoFn) {
        if (toastTimer) {
            clearTimeout(toastTimer);
            toastTimer = null;
        }
        toastHost.innerHTML = "";
        const box = document.createElement("div");
        box.className = "k-toast";
        const text = document.createElement("span");
        text.textContent = msg;
        box.appendChild(text);
        if (undoFn) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "undo";
            btn.textContent = "เลิกทำ";
            btn.addEventListener("click", function () {
                toastHost.innerHTML = "";
                undoFn();
            });
            box.appendChild(btn);
        }
        toastHost.appendChild(box);
        toastTimer = setTimeout(function () {
            toastHost.innerHTML = "";
            toastTimer = null;
        }, undoFn ? 6000 : 2800);
    }

    // ------------------------------------------------------------------
    // "Tap once more to confirm" for anything the server cannot undo
    // ------------------------------------------------------------------

    let armedBtn = null;
    let armedTimer = null;

    function disarm() {
        if (armedTimer) {
            clearTimeout(armedTimer);
            armedTimer = null;
        }
        if (armedBtn) {
            armedBtn.innerHTML = armedBtn.dataset.koLabel || armedBtn.innerHTML;
            armedBtn.classList.remove("armed");
            armedBtn = null;
        }
    }

    function confirmTap(btn, label, run) {
        if (armedBtn === btn) {
            disarm();
            run();
            return;
        }
        disarm();
        armedBtn = btn;
        btn.dataset.koLabel = btn.innerHTML;
        btn.innerHTML = esc(label);
        btn.classList.add("armed");
        buzz(25);
        armedTimer = setTimeout(disarm, 4000);
    }

    // ------------------------------------------------------------------
    // Server calls
    // ------------------------------------------------------------------

    function post(url, params) {
        const body = new URLSearchParams(Object.assign({ csrf_token: window.KDS_CSRF }, params));
        return fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        }).then(function () {
            return refresh();
        }).catch(function (e) {
            console.warn("KDS action failed:", e);
            toast("ส่งคำสั่งไม่สำเร็จ — ตรวจอินเทอร์เน็ตแล้วลองใหม่");
        });
    }

    // ------------------------------------------------------------------
    // Line state, with the optimistic overlay folded in
    // ------------------------------------------------------------------

    function serverDone(line) {
        return Boolean(line.done) || line.state === "ready" || line.state === "served";
    }

    function isDead(line) {
        return line.state === "cancelled" || Boolean(line.cancelled);
    }

    function lineDone(line) {
        if (pending.has(line.id)) {
            return pending.get(line.id).done;
        }
        return serverDone(line);
    }

    function liveLines(ticket) {
        return (ticket.lines || []).filter(function (l) { return !isDead(l); });
    }

    function ticketReady(ticket) {
        const live = liveLines(ticket);
        return live.length > 0 && live.every(lineDone);
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    function toggleLine(lineId, quiet) {
        const line = lineIndex.get(lineId);
        if (!line || isDead(line)) {
            return;
        }
        const next = !lineDone(line);
        pending.set(lineId, { done: next, at: Date.now() });
        render(true);
        buzz();
        post("/kds/toggle_line", { line_id: lineId });
        if (!quiet) {
            toast(
                (next ? "เสร็จแล้ว: " : "กลับไปกำลังทำ: ") + line.name,
                function () { toggleLine(lineId, true); }
            );
        }
    }

    window.kdsTap = function (ev, lineId) {
        ev.preventDefault();
        ev.stopPropagation();
        if (Date.now() < tapLockUntil) {
            return;
        }
        tapLockUntil = Date.now() + TAP_LOCK_MS;
        disarm();
        toggleLine(lineId, false);
    };

    window.kdsSetTab = function (tab) {
        currentTab = tab;
        disarm();
        ["active", "served", "cancelled"].forEach(function (name) {
            const btn = byId("tab-" + name);
            if (btn) {
                btn.classList.toggle("on", name === tab);
                btn.setAttribute("aria-selected", name === tab ? "true" : "false");
            }
        });
        // Only the แบบออเดอร์/แบบเมนู toggle is board-specific. The station and
        // shop chips are plain links and must stay reachable from every tab —
        // hiding the whole row stranded anyone who switched to เสิร์ฟแล้ว.
        if (viewSeg) {
            viewSeg.style.display = tab === "active" ? "flex" : "none";
        }
        render(true);
    };

    window.kdsSetView = function (view) {
        currentView = view;
        disarm();
        byId("view-order").classList.toggle("on", view === "order");
        byId("view-menu").classList.toggle("on", view === "menu");
        render(true);
    };

    window.kdsStart = function (ev, ticketId) {
        ev.stopPropagation();
        post("/kds/set_state", { ticket_id: ticketId, state: "progress" });
        buzz();
        toast("เริ่มทำออเดอร์แล้ว", function () {
            post("/kds/set_state", { ticket_id: ticketId, state: "new" });
        });
    };

    window.kdsAllReady = function (ev, ticketId) {
        ev.stopPropagation();
        const ticket = (rawData.active || []).filter(function (t) { return t.id === ticketId; })[0];
        // Remember what was still cooking so "เลิกทำ" can put exactly those back
        // — the server has no bulk undo, but toggling a line is reversible.
        const wasCooking = ticket
            ? liveLines(ticket).filter(function (l) { return !lineDone(l); }).map(function (l) { return l.id; })
            : [];
        wasCooking.forEach(function (id) { pending.set(id, { done: true, at: Date.now() }); });
        render(true);
        buzz(20);
        post("/kds/all_ready", { ticket_id: ticketId });
        toast("ทำเสร็จครบทุกรายการแล้ว", wasCooking.length ? function () {
            wasCooking.forEach(function (id) {
                pending.set(id, { done: false, at: Date.now() });
                post("/kds/toggle_line", { line_id: id });
            });
            render(true);
        } : null);
    };

    window.kdsAllReadyBatch = function (ev, lineIdsJson) {
        ev.stopPropagation();
        let ids = [];
        try { ids = JSON.parse(lineIdsJson); } catch (e) { ids = []; }
        const wasCooking = ids.filter(function (id) {
            const l = lineIndex.get(id);
            return l && !isDead(l) && !lineDone(l);
        });
        wasCooking.forEach(function (id) { pending.set(id, { done: true, at: Date.now() }); });
        render(true);
        buzz(20);
        post("/kds/all_ready", { line_ids: JSON.stringify(ids) });
        toast("ทำเสร็จทุกรายการในกลุ่มแล้ว", wasCooking.length ? function () {
            wasCooking.forEach(function (id) {
                pending.set(id, { done: false, at: Date.now() });
                post("/kds/toggle_line", { line_id: id });
            });
            render(true);
        } : null);
    };

    // Remake spawns a fresh ticket for the kitchen; there is nothing to undo,
    // so it asks for a second tap instead of offering เลิกทำ afterwards.
    window.kdsRemake = function (ev, ticketId) {
        ev.stopPropagation();
        const btn = ev.currentTarget;
        confirmTap(btn, "แตะอีกครั้งเพื่อยืนยัน", function () {
            post("/kds/remake", { ticket_id: ticketId });
            toast("ส่งกลับเข้าครัวแล้ว (ทำใหม่)");
        });
    };

    // ------------------------------------------------------------------
    // Issue reporting (kitchen → front of house)
    // ------------------------------------------------------------------

    window.kdsOpenIssue = function (ev, lineId) {
        ev.preventDefault();
        ev.stopPropagation();
        disarm();
        issueState = { lineId: lineId, type: null };
        // The label is read from the DOM, never interpolated into the onclick
        // attribute: a dish name with a quote would otherwise break the handler.
        issueTarget.textContent = ev.currentTarget.dataset.label || "";
        issueNote.value = "";
        issueSend.disabled = true;
        document.querySelectorAll(".opt").forEach(function (btn) { btn.classList.remove("on"); });
        issueBg.classList.add("open");
        buzz();
    };

    window.kdsClearIssue = function (ev, lineId) {
        ev.stopPropagation();
        post("/kds/clear_issue", { line_id: lineId });
        toast("ยกเลิกการแจ้งปัญหาแล้ว");
    };

    function closeIssue() {
        issueBg.classList.remove("open");
        issueState = { lineId: null, type: null };
    }

    document.querySelectorAll(".opt").forEach(function (btn) {
        btn.addEventListener("click", function () {
            document.querySelectorAll(".opt").forEach(function (other) { other.classList.remove("on"); });
            btn.classList.add("on");
            issueState.type = btn.dataset.issue;
            issueSend.disabled = false;
            buzz();
        });
    });

    issueCancel.addEventListener("click", closeIssue);
    issueBg.addEventListener("click", function (ev) {
        if (ev.target === issueBg) {
            closeIssue();
        }
    });

    issueSend.addEventListener("click", function () {
        if (!issueState.lineId || !issueState.type) {
            return;
        }
        const payload = {
            line_id: issueState.lineId,
            issue_type: issueState.type,
            note: issueNote.value || "",
        };
        closeIssue();
        post("/kds/line_issue", payload);
        toast("แจ้งหน้าร้านแล้ว");
    });

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function ticketWhere(t) {
        if (t.table) {
            return "โต๊ะ " + esc(t.table);
        }
        if (t.customer) {
            return esc(t.customer);
        }
        if (t.tracking) {
            return "คิว " + esc(t.tracking);
        }
        return esc(t.name);
    }

    function ticketSub(t) {
        const bits = [esc(t.name)];
        if (t.floor && t.table) {
            bits.push(esc(t.floor));
        }
        return bits.join(" · ");
    }

    function flagsHtml(t) {
        const out = [];
        if (t.remake) {
            out.push('<span class="flag flag-remake">ทำใหม่</span>');
        }
        if (t.paid) {
            out.push('<span class="flag flag-paid">จ่ายแล้ว</span>');
        }
        if (!t.table && t.order_type === "takeaway") {
            out.push('<span class="flag flag-away">กลับบ้าน</span>');
        }
        return out.length ? '<div class="tk-flags">' + out.join("") + "</div>" : "";
    }

    function stationHtml(line) {
        // When one station is selected every line would carry the same label,
        // so the space goes to the dish name instead.
        if (stationPicked) {
            return "";
        }
        const name = line.station || "ไม่ได้กำหนดสถานี";
        if (!line.station_id) {
            return '<span class="stn none">' + esc(name) + "</span>";
        }
        const color = line.station_color;
        const style = color ? ' style="color:' + esc(color) + '"' : "";
        return '<span class="stn"' + style + ">" + esc(name) + "</span>";
    }

    function noteHtml(line) {
        const note = [line.attrs, line.note].filter(Boolean).join(" · ");
        if (!note) {
            return "";
        }
        // This is the text that costs a remake when it is missed, so it gets a
        // block of its own rather than a grey caption.
        return '<span class="ln-note"><b>⚠</b><span>' + esc(note) + "</span></span>";
    }

    function issueHtml(line) {
        if (!line.issue) {
            return "";
        }
        const cls = line.issue.ack ? "ln-issue acked" : "ln-issue";
        const status = line.issue.ack ? "หน้าร้านรับทราบแล้ว" : "รอหน้าร้านรับทราบ";
        const note = line.issue.note ? " — " + esc(line.issue.note) : "";
        return (
            '<div class="' + cls + '">' +
                '<div class="txt">⚠ ' + esc(line.issue.label) + note +
                    '<span class="sub">' + status + "</span>" +
                "</div>" +
                '<button type="button" onclick="kdsClearIssue(event,' + line.id + ')">ยกเลิกการแจ้ง</button>' +
            "</div>"
        );
    }

    function lineHtml(line) {
        const dead = isDead(line);
        const done = !dead && lineDone(line);
        const cls = "ln" + (dead ? " is-dead" : done ? " is-done" : "");
        const label = fmtQty(line.qty) + "× " + line.name;
        const tapAttr = dead ? "" : ' onclick="kdsTap(event,' + line.id + ')"';
        const st = dead
            ? '<span class="st st-dead">ยกเลิก</span>'
            : done
                ? '<span class="st st-done">เสร็จ</span>'
                : "";

        const meta = stationHtml(line) + st;

        return (
            '<div class="' + cls + '" data-line="' + line.id + '">' +
                '<button type="button" class="ln-tap"' + tapAttr + '>' +
                    '<span class="ln-row">' +
                        '<span class="ck">' + (dead ? "✕" : done ? "✓" : "") + "</span>" +
                        '<span class="qty">' + esc(fmtQty(line.qty)) + "</span>" +
                        '<span class="nm">' + esc(line.name) + "</span>" +
                    "</span>" +
                    (meta ? '<span class="ln-meta">' + meta + "</span>" : "") +
                    noteHtml(line) +
                "</button>" +
                (dead ? "" :
                    '<button type="button" class="ln-flag" data-label="' + esc(label) +
                    '" onclick="kdsOpenIssue(event,' + line.id + ')" aria-label="แจ้งปัญหา">' +
                    '<span class="ic">⚠</span>แจ้ง</button>') +
            "</div>" +
            issueHtml(line)
        );
    }

    function ticketCard(t) {
        const created = new Date(t.created_utc).getTime();
        const ready = ticketReady(t);
        const lines = (t.lines || []).map(lineHtml).join("");

        let action;
        if (ready) {
            action = '<div class="tk-act act-wait">✓ พร้อมเสิร์ฟ · รอหน้าร้านยกออก</div>';
        } else if (t.state === "new") {
            action = '<button type="button" class="tk-act act-start" onclick="kdsStart(event,' + t.id + ')">▶ เริ่มทำ</button>';
        } else {
            action = '<button type="button" class="tk-act act-ready" onclick="kdsAllReady(event,' + t.id + ')">✓ เสร็จทั้งหมด</button>';
        }

        return (
            '<article class="tk' + (ready ? " rdy" : "") + '" data-created="' + created + '" data-tk="' + t.id + '">' +
                '<div class="tk-head">' +
                    '<div class="tk-id">' +
                        '<span class="tk-where">' + ticketWhere(t) + "</span>" +
                        '<span class="tk-sub">' + ticketSub(t) + "</span>" +
                    "</div>" +
                    '<div class="tk-time"><span class="tk-min">0</span><span class="tk-min-u">นาที</span></div>' +
                "</div>" +
                '<div class="tk-sla"><i style="width:0%"></i></div>' +
                flagsHtml(t) +
                (t.note ? '<div class="tk-note"><b>⚠</b><span>' + esc(t.note) + "</span></div>" : "") +
                '<div class="tk-lines">' + lines + "</div>" +
                action +
            "</article>"
        );
    }

    function readyCard(t) {
        const created = new Date(t.created_utc).getTime();
        const dishes = liveLines(t).map(function (l) {
            return "<span>" + esc(fmtQty(l.qty)) + "× " + esc(l.name) + "</span>";
        }).join(" · ");

        return (
            '<article class="tk rdy" data-created="' + created + '" data-tk="' + t.id + '">' +
                '<div class="tk-head">' +
                    '<div class="tk-id">' +
                        '<span class="tk-where">' + ticketWhere(t) + "</span>" +
                        '<span class="tk-sub">' + ticketSub(t) + "</span>" +
                    "</div>" +
                    '<div class="tk-time"><span class="tk-min">0</span><span class="tk-min-u">นาที</span></div>' +
                "</div>" +
                '<div class="tk-sla"><i style="width:0%"></i></div>' +
                flagsHtml(t) +
                '<div class="rdy-dishes">' + dishes + "</div>" +
            "</article>"
        );
    }

    function section(title, count, cls, inner, gridCls) {
        return (
            '<section class="sec ' + cls + '">' +
                '<h2 class="sec-hd"><span class="dot"></span>' + title +
                    '<span class="n">' + count + "</span></h2>" +
                '<div class="grid ' + (gridCls || "") + '">' + inner + "</div>" +
            "</section>"
        );
    }

    function renderOrderView() {
        const all = rawData.active || [];
        if (!all.length) {
            return '<div class="empty">ไม่มีออเดอร์ค้าง · ครัวโล่งแล้ว 🎉</div>';
        }
        const ready = all.filter(ticketReady);
        const cooking = all.filter(function (t) { return !ticketReady(t); });

        let html = "";
        // Ready first: these need to leave the kitchen now, and they are the
        // cards nobody should have to scroll past while cooking.
        if (ready.length) {
            html += section("พร้อมเสิร์ฟ · รอหน้าร้านยกออก", ready.length, "sec-ready",
                ready.map(readyCard).join(""), "compact");
        }
        html += section("กำลังทำ", cooking.length, "sec-cook",
            cooking.length ? cooking.map(ticketCard).join("")
                           : '<div class="empty">ไม่มีรายการที่ต้องทำแล้ว</div>');
        return html;
    }

    function renderMenuView() {
        const groups = new Map();
        (rawData.active || []).forEach(function (t) {
            (t.lines || []).forEach(function (l) {
                if (isDead(l)) {
                    return;
                }
                const key = l.name + "|" + (l.attrs || "") + "|" + (l.note || "");
                if (!groups.has(key)) {
                    groups.set(key, {
                        name: l.name,
                        attrs: l.attrs,
                        note: l.note,
                        station: l.station,
                        station_id: l.station_id,
                        station_color: l.station_color,
                        total: 0,
                        rows: [],
                    });
                }
                const g = groups.get(key);
                g.total += Number(l.qty) || 0;
                g.rows.push({
                    id: l.id,
                    where: t.table ? "โต๊ะ " + t.table : (t.customer || (t.tracking ? "คิว " + t.tracking : t.name)),
                    ticketName: t.name,
                    qty: l.qty,
                    done: lineDone(l),
                });
            });
        });

        const list = Array.from(groups.values());
        if (!list.length) {
            return '<div class="empty">ไม่มีรายการ · ครัวโล่งแล้ว 🎉</div>';
        }

        const cards = list.map(function (g) {
            const pendingIds = g.rows.filter(function (r) { return !r.done; }).map(function (r) { return r.id; });
            const rows = g.rows.map(function (r) {
                return (
                    '<div class="ln' + (r.done ? " is-done" : "") + '" data-line="' + r.id + '">' +
                        '<button type="button" class="ln-tap" onclick="kdsTap(event,' + r.id + ')">' +
                            '<span class="ln-row">' +
                                '<span class="ck">' + (r.done ? "✓" : "") + "</span>" +
                                '<span class="qty">' + esc(fmtQty(r.qty)) + "</span>" +
                                '<span class="nm">' + esc(r.where) + "</span>" +
                            "</span>" +
                            (r.done ? '<span class="ln-meta"><span class="st st-done">เสร็จ</span></span>' : "") +
                        "</button>" +
                    "</div>"
                );
            }).join("");

            const note = [g.attrs, g.note].filter(Boolean).join(" · ");
            return (
                '<article class="tk">' +
                    '<div class="tk-head">' +
                        '<div class="tk-id">' +
                            '<span class="tk-where">' + esc(g.name) + "</span>" +
                            (stationPicked || !g.station ? "" : '<span class="tk-sub">' + esc(g.station) + "</span>") +
                        "</div>" +
                        '<div class="mv-total">×' + esc(fmtQty(g.total)) + "</div>" +
                    "</div>" +
                    (note ? '<div class="tk-note"><b>⚠</b><span>' + esc(note) + "</span></div>" : "") +
                    '<div class="tk-lines">' + rows + "</div>" +
                    (pendingIds.length
                        ? '<button type="button" class="tk-act act-ready" onclick="kdsAllReadyBatch(event,\'' +
                          esc(JSON.stringify(pendingIds)) + '\')">✓ เสร็จทั้งหมด</button>'
                        : '<div class="tk-act act-wait">✓ ทำครบแล้ว</div>') +
                "</article>"
            );
        }).join("");

        return section("รวมตามเมนู", list.length, "sec-cook", cards);
    }

    function renderHistory() {
        const tickets = currentTab === "served" ? (rawData.served || []) : (rawData.cancelled || []);
        if (!tickets.length) {
            return '<div class="empty">' +
                (currentTab === "served" ? "ยังไม่มีออเดอร์ที่เสิร์ฟใน 2 ชั่วโมงที่ผ่านมา" : "ไม่มีออเดอร์ที่ถูกยกเลิก") +
                "</div>";
        }
        const sla = Number(rawData.sla_minutes || 15);

        const cards = tickets.map(function (h) {
            const finishedUtc = currentTab === "cancelled" ? h.cancelled_utc : (h.served_utc || h.done_utc);
            const finishedAt = finishedUtc ? new Date(finishedUtc) : null;
            const createdAt = h.created_utc ? new Date(h.created_utc) : null;
            const mins = finishedAt && createdAt
                ? Math.max(0, Math.round((finishedAt.getTime() - createdAt.getTime()) / 60000))
                : null;
            const timeText = finishedAt
                ? finishedAt.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })
                : "--:--";
            const over = mins !== null && mins > sla;
            const meta = currentTab === "cancelled"
                ? "ยกเลิก " + timeText
                : "เสิร์ฟ " + timeText + (over ? " · เกินเวลา" : "");

            const rows = (h.lines || []).map(function (l) {
                return (
                    '<div class="ln is-done" data-line="' + l.id + '">' +
                        '<div class="ln-tap">' +
                            '<span class="ln-row">' +
                                '<span class="ck">✓</span>' +
                                '<span class="qty">' + esc(fmtQty(l.qty)) + "</span>" +
                                '<span class="nm">' + esc(l.name) + "</span>" +
                            "</span>" +
                        "</div>" +
                    "</div>" +
                    issueHtml(l)
                );
            }).join("");

            return (
                '<article class="tk dead">' +
                    '<div class="tk-head">' +
                        '<div class="tk-id">' +
                            '<span class="tk-where">' + ticketWhere(h) + "</span>" +
                            '<span class="tk-sub">' + ticketSub(h) + " · " + esc(meta) + "</span>" +
                        "</div>" +
                        '<div class="tk-time"><span class="tk-min">' + (mins === null ? "–" : mins) +
                            '</span><span class="tk-min-u">นาที</span></div>' +
                    "</div>" +
                    '<div class="tk-lines">' + rows + "</div>" +
                    '<button type="button" class="tk-act act-remake" onclick="kdsRemake(event,' + h.id +
                        ')">↺ ส่งกลับเข้าครัว</button>' +
                "</article>"
            );
        }).join("");

        return section(currentTab === "served" ? "เสิร์ฟแล้ว (2 ชั่วโมงล่าสุด)" : "ยกเลิก",
            tickets.length, "sec-cook", cards);
    }

    // A cheap content fingerprint. When it does not move, nothing is rebuilt —
    // that is what keeps scroll position and stops a tap landing on a node that
    // was replaced a millisecond earlier.
    function signature() {
        const parts = [currentTab, currentView, rawData.sla_minutes];
        const list = currentTab === "active"
            ? (rawData.active || [])
            : currentTab === "served" ? (rawData.served || []) : (rawData.cancelled || []);
        list.forEach(function (t) {
            parts.push(t.id, t.state, t.change_seq, t.remake ? 1 : 0, t.paid ? 1 : 0, t.note || "");
            (t.lines || []).forEach(function (l) {
                parts.push(
                    l.id, lineDone(l) ? 1 : 0, isDead(l) ? 1 : 0, l.qty, l.name,
                    l.note || "", l.attrs || "",
                    l.issue ? l.issue.type + (l.issue.ack ? "1" : "0") + (l.issue.note || "") : ""
                );
            });
        });
        // \\u0001 as the separator, not "": without it "1" + "23" and "12" + "3"
        // produce the same string and a real change can go unnoticed. Written as an
        // escape on purpose — a raw control byte here is invisible in every editor.
        return parts.join("\\u0001");
    }

    function render(force) {
        const sig = signature();
        if (!force && sig === lastSig) {
            tickTimers();
            return;
        }
        lastSig = sig;
        disarm();

        let html;
        if (currentTab !== "active") {
            html = renderHistory();
        } else if (currentView === "menu") {
            html = renderMenuView();
        } else {
            html = renderOrderView();
        }
        board.innerHTML = html;
        tickTimers();
    }

    // Elapsed minutes, the SLA bar and the warn/late colour move every second
    // without touching the DOM structure.
    function tickTimers() {
        const sla = Math.max(1, Number(rawData.sla_minutes || 15));
        const warnAt = Math.max(1, sla * 0.55);
        const now = Date.now();
        document.querySelectorAll(".tk[data-created]").forEach(function (card) {
            const created = Number(card.dataset.created);
            if (!created) {
                return;
            }
            const mins = Math.max(0, (now - created) / 60000);
            const whole = Math.floor(mins);
            const minEl = card.querySelector(".tk-min");
            if (minEl && minEl.textContent !== String(whole)) {
                minEl.textContent = String(whole);
            }
            const bar = card.querySelector(".tk-sla i");
            if (bar) {
                bar.style.width = Math.min(100, (mins / sla) * 100).toFixed(1) + "%";
            }
            if (card.classList.contains("rdy") || card.classList.contains("dead")) {
                return;
            }
            const late = mins >= sla;
            card.classList.toggle("warn", !late && mins >= warnAt);
            card.classList.toggle("late", late);
            const unit = card.querySelector(".tk-min-u");
            if (unit) {
                const text = late ? "นาที · เกินเวลา" : "นาที";
                if (unit.textContent !== text) {
                    unit.textContent = text;
                }
            }
        });
    }

    // ------------------------------------------------------------------
    // Polling
    // ------------------------------------------------------------------

    function reconcilePending() {
        const now = Date.now();
        pending.forEach(function (value, id) {
            const line = lineIndex.get(id);
            if (!line || serverDone(line) === value.done || now - value.at > OPTIMISTIC_TTL) {
                pending.delete(id);
            }
        });
    }

    function indexLines(data) {
        const map = new Map();
        ["active", "served", "cancelled"].forEach(function (key) {
            (data[key] || []).forEach(function (t) {
                (t.lines || []).forEach(function (l) { map.set(l.id, l); });
            });
        });
        return map;
    }

    function setOffline(on) {
        document.body.classList.toggle("is-offline", on);
    }

    function refresh() {
        const params = new URLSearchParams({
            config_id: window.KDS_CONFIG_ID || "",
            station_id: window.KDS_STATION_ID || "",
        });
        return fetch("/kds/data?" + params.toString(), { headers: { Accept: "application/json" } })
            .then(function (r) {
                if (!r.ok && r.status !== 400) {
                    throw new Error("HTTP " + r.status);
                }
                return r.json();
            })
            .then(function (data) {
                failStreak = 0;
                setOffline(false);
                if (data && data.error === "config_required") {
                    board.innerHTML = '<div class="empty">ยังไม่ได้เลือกร้าน · <a href="/kds">เลือกร้าน</a></div>';
                    return;
                }
                rawData = data;
                lineIndex = indexLines(data);
                reconcilePending();

                const activeCount = (data.active || []).length;
                byId("n-active").textContent = String(activeCount);
                byId("n-served").textContent = String((data.served || []).length);
                byId("n-cancelled").textContent = String((data.cancelled || []).length);

                // Alert on any *dish* the station has not seen yet, not only on
                // brand-new tickets: adding two more plates to table 5 has to
                // wake the station too.
                const seenNow = new Set();
                let fresh = 0;
                (data.active || []).forEach(function (t) {
                    (t.lines || []).forEach(function (l) {
                        seenNow.add(l.id);
                        if (!knownLineIds.has(l.id) && !isDead(l)) {
                            fresh += 1;
                        }
                    });
                });
                if (!firstLoad && fresh > 0) {
                    chime();
                    flashBoard();
                    buzz([50, 60, 50]);
                    toast(audioUnlocked
                        ? (fresh === 1 ? "มีรายการใหม่เข้าครัว!" : "มีรายการใหม่เข้าครัว " + fresh + " รายการ!")
                        : "มีรายการใหม่เข้าครัว — แตะหน้าจอหนึ่งครั้งเพื่อเปิดเสียงเตือน");
                }
                knownLineIds = seenNow;
                firstLoad = false;
                render(false);
            })
            .catch(function (e) {
                console.warn("KDS poll error:", e);
                failStreak += 1;
                if (failStreak >= 2) {
                    setOffline(true);
                }
            });
    }

    setInterval(function () {
        if (clock) {
            clock.textContent = new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
        }
        tickTimers();
    }, 1000);

    refresh();
    window.addEventListener("ko:kds-update", refresh);
    setInterval(refresh, POLL_MS);
    // A tab that was asleep shows minutes-old food; catch up the moment it wakes.
    document.addEventListener("visibilitychange", function () {
        if (!document.hidden) {
            refresh();
        }
    });
})();
