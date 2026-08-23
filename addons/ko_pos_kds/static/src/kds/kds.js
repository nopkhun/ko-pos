/* KO KDS Screen — Vanilla JS Client */
(function () {
    "use strict";

    // KDS is a standalone page, so polling is retained as a resilient fallback.
    // POS clients receive the same changes immediately through Odoo's bus service.
    const POLL_MS = 2000;
    const board = document.getElementById("board");
    const clock = document.getElementById("clock");
    const activeCountEl = document.getElementById("active-count");
    const subcontrols = document.getElementById("subcontrols");
    const toastWrap = document.getElementById("toast-wrap");
    const toastMsg = document.getElementById("toast-msg");
    const slaLabel = document.getElementById("sla-label");

    // Issue sheet elements
    const issueBackdrop = document.getElementById("issue-backdrop");
    const issueTarget = document.getElementById("issue-target");
    const issueNote = document.getElementById("issue-note");
    const issueSend = document.getElementById("issue-send");
    const issueCancel = document.getElementById("issue-cancel");

    let currentTab = "active"; // 'active' | 'served' | 'cancelled'
    let currentView = "order"; // 'order' | 'menu'
    // Station filtering happens on the server (one screen = one station, chosen
    // in the station bar). There is deliberately no second client-side filter.

    let rawData = { active: [], served: [], cancelled: [], now_utc: new Date().toISOString() };
    let knownLineIds = new Set();
    let firstLoad = true;
    let audioCtx = null;
    let toastTimer = null;
    let issueState = { lineId: null, type: null };

    function toast(msg) {
        if (toastTimer) {
            clearTimeout(toastTimer);
        }
        toastMsg.textContent = msg;
        toastWrap.style.display = "flex";
        toastTimer = setTimeout(function () {
            toastWrap.style.display = "none";
            toastTimer = null;
        }, 2600);
    }

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

    function beep(times) {
        const ctx = getAudioCtx();
        if (!ctx) {
            return;
        }
        const count = times || 1;
        for (let i = 0; i < count; i++) {
            try {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                const start = ctx.currentTime + i * 0.28;
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = "sine";
                osc.frequency.value = 880;
                gain.gain.setValueAtTime(0.35, start);
                gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25);
                osc.start(start);
                osc.stop(start + 0.26);
            } catch (e) {
                /* autoplay policy */
            }
        }
    }

    // Browsers keep AudioContext suspended until the page has been interacted
    // with. A kitchen screen is often left untouched, so unlock on the first
    // touch of the shift and tell staff when sound is still silent.
    let audioUnlocked = false;
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

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function post(url, params) {
        params = Object.assign({ csrf_token: window.KDS_CSRF }, params);
        const body = new URLSearchParams(params);
        return fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        }).then(function () {
            return refresh();
        });
    }

    window.kdsSetTab = function (tab) {
        currentTab = tab;
        document.querySelectorAll(".kds-tab-btn").forEach(function (btn) {
            btn.classList.remove("active");
        });
        const activeBtn = document.getElementById("tab-" + tab);
        if (activeBtn) {
            activeBtn.classList.add("active");
        }
        if (subcontrols) {
            subcontrols.style.display = tab === "active" ? "flex" : "none";
        }
        render();
    };

    window.kdsSetView = function (view) {
        currentView = view;
        document.getElementById("view-order").classList.toggle("active", view === "order");
        document.getElementById("view-menu").classList.toggle("active", view === "menu");
        render();
    };

    window.kdsToggleLine = function (ev, lineId) {
        ev.stopPropagation();
        post("/kds/toggle_line", { line_id: lineId });
    };

    window.kdsStartTicket = function (ticketId) {
        post("/kds/set_state", { ticket_id: ticketId, state: "progress" });
        toast("เริ่มทำออเดอร์แล้ว");
    };

    window.kdsAllReadyTicket = function (ticketId) {
        post("/kds/all_ready", { ticket_id: ticketId });
        toast("ทำเสร็จครบทุกรายการแล้ว");
    };

    window.kdsAllReadyBatch = function (lineIdsJson) {
        post("/kds/all_ready", { line_ids: lineIdsJson });
        toast("ทำเสร็จทุกรายการในกลุ่มแล้ว");
    };

    window.kdsRemake = function (ticketId) {
        post("/kds/remake", { ticket_id: ticketId });
        toast("ส่งกลับเข้าครัวแล้ว (ทำใหม่)");
    };

    // ------------------------------------------------------------------
    // Issue reporting (kitchen → front of house)
    // ------------------------------------------------------------------

    window.kdsOpenIssue = function (ev, lineId) {
        ev.stopPropagation();
        issueState = { lineId: lineId, type: null };
        // The label is read from the DOM, never interpolated into the onclick
        // attribute: a dish name with a quote would otherwise break the handler.
        issueTarget.textContent = ev.currentTarget.dataset.label || "";
        issueNote.value = "";
        issueSend.disabled = true;
        document.querySelectorAll(".issue-opt").forEach(function (btn) {
            btn.classList.remove("active");
        });
        issueBackdrop.style.display = "flex";
    };

    window.kdsClearIssue = function (ev, lineId) {
        ev.stopPropagation();
        post("/kds/clear_issue", { line_id: lineId });
        toast("ยกเลิกการแจ้งปัญหาแล้ว");
    };

    function closeIssue() {
        issueBackdrop.style.display = "none";
        issueState = { lineId: null, type: null };
    }

    document.querySelectorAll(".issue-opt").forEach(function (btn) {
        btn.addEventListener("click", function () {
            document.querySelectorAll(".issue-opt").forEach(function (other) {
                other.classList.remove("active");
            });
            btn.classList.add("active");
            issueState.type = btn.dataset.issue;
            issueSend.disabled = false;
        });
    });

    issueCancel.addEventListener("click", closeIssue);
    issueBackdrop.addEventListener("click", function (ev) {
        if (ev.target === issueBackdrop) {
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

    function stationBadge(line) {
        const name = line.station || "ไม่ได้กำหนดสถานี";
        const color = line.station_color;
        const cls = color ? "stn-label" : "stn-label stn-none";
        const style = color ? ' style="color:' + esc(color) + '"' : "";
        return '<span class="' + cls + '"' + style + ">" + esc(name) + "</span>";
    }

    function issueBlock(line) {
        if (!line.issue) {
            return "";
        }
        const cls = line.issue.ack ? "line-issue acked" : "line-issue";
        const ackText = line.issue.ack ? " · หน้าร้านรับทราบแล้ว" : " · รอหน้าร้านรับทราบ";
        const note = line.issue.note ? ": " + esc(line.issue.note) : "";
        return (
            '<div class="' + cls + '">⚠ ' + esc(line.issue.label) + note + ackText +
            ' <button type="button" class="line-issue-btn" onclick="kdsClearIssue(event,' +
            line.id + ')">ยกเลิกการแจ้ง</button></div>'
        );
    }

    function ticketHeadLabel(t) {
        if (t.table) {
            return "โต๊ะ " + esc(t.table);
        }
        if (t.customer) {
            return "กลับบ้าน · " + esc(t.customer);
        }
        if (t.tracking) {
            return "คิว " + esc(t.tracking);
        }
        return esc(t.name);
    }

    function renderOrderView(tickets, skew) {
        if (!tickets.length) {
            board.innerHTML = '<div class="empty-board">ไม่มีออเดอร์ค้าง · All caught up 🎉</div>';
            return;
        }

        const html = tickets.map(function (t) {
            const created = new Date(t.created_utc).getTime() + skew;
            const elapsedMs = Math.max(0, Date.now() - created);
            const mins = elapsedMs / 60000;
            const slaMinutes = Math.max(1, Number(rawData.sla_minutes || 15));
            const warnAt = Math.max(1, slaMinutes * 0.55);
            const cardCls = mins >= slaMinutes ? "late" : mins >= warnAt ? "warn" : "";
            const isLate = mins >= slaMinutes;
            const elapsedText = isLate ? Math.floor(mins) + " นาที · เกิน SLA" : Math.floor(mins) + " นาที";
            const slaPct = Math.min(100, Math.round((mins / slaMinutes) * 100)) + "%";

            const lines = (t.lines || []).map(function (l) {
                const isCancelled = l.state === "cancelled" || l.cancelled;
                const isReady = ["ready", "served"].includes(l.state) || l.done;
                const stCls = isCancelled ? "st-cancelled" : isReady ? "st-ready" : "st-cooking";
                const stLabel = isCancelled ? "ยกเลิก" : isReady ? "เสร็จแล้ว" : "กำลังทำ";
                const note = [l.attrs, l.note].filter(Boolean).join(" · ");
                const label = l.qty + "× " + l.name;

                return (
                    '<div class="line-item">' +
                        '<div class="line-top" ' + (isCancelled ? '' : 'onclick="kdsToggleLine(event,' + l.id + ')"') + '>' +
                            '<span class="line-qty">' + esc(l.qty) + '×</span>' +
                            '<span class="line-name">' + esc(l.name) + '</span>' +
                            stationBadge(l) +
                            '<span class="st-chip ' + stCls + '">' + esc(stLabel) + '</span>' +
                            (l.issue ? '' :
                                '<button type="button" class="line-issue-btn" data-label="' + esc(label) +
                                '" onclick="kdsOpenIssue(event,' + l.id + ')">แจ้งปัญหา</button>') +
                        '</div>' +
                        (note ? '<div class="line-note">โน้ต: ' + esc(note) + '</div>' : '') +
                        issueBlock(l) +
                    '</div>'
                );
            }).join("");

            const liveLines = (t.lines || []).filter(function (l) { return !l.cancelled && l.state !== "cancelled"; });
            const allReady = liveLines.length && liveLines.every(function (l) {
                return l.done || ["ready", "served"].includes(l.state);
            });
            let actionBtn = "";
            if (t.state === "new") {
                actionBtn = '<button class="card-action-btn btn-start" onclick="kdsStartTicket(' + t.id + ')">สั่งทำแล้ว · Start</button>';
            } else if (t.state !== "ready" && !allReady) {
                actionBtn = '<button class="card-action-btn btn-all-ready" onclick="kdsAllReadyTicket(' + t.id + ')">เสร็จทั้งหมด · All ready</button>';
            } else {
                actionBtn = '<button class="card-action-btn btn-waiting">รอเสิร์ฟหน้าร้าน · Ready to serve</button>';
            }

            const shortNo = esc(t.name);

            return (
                '<div class="card ' + cardCls + '" data-created="' + created + '">' +
                    '<div class="card-head">' +
                        '<div class="table-group">' +
                            '<div class="table-no">' + shortNo + ' · ' + ticketHeadLabel(t) + '</div>' +
                            (t.remake ? '<span class="badge-remake">ทำใหม่</span>' : '') +
                            (t.paid ? '<span class="badge-remake">จ่ายแล้ว</span>' : '') +
                        '</div>' +
                        '<div class="elapsed-label">' + elapsedText + '</div>' +
                    '</div>' +
                    '<div class="sla-bar-wrap"><div class="sla-bar" style="width:' + slaPct + '"></div></div>' +
                    (t.note ? '<div class="line-note">โน้ตออเดอร์: ' + esc(t.note) + '</div>' : '') +
                    '<div class="lines">' + lines + '</div>' +
                    actionBtn +
                '</div>'
            );
        }).join("");

        board.innerHTML = html;
    }

    function renderMenuView(tickets) {
        const groupMap = {};
        tickets.forEach(function (t) {
            (t.lines || []).forEach(function (l) {
                if (l.cancelled || l.state === "cancelled") return;
                const key = l.name + "|" + (l.attrs || "") + "|" + (l.note || "");
                if (!groupMap[key]) {
                    groupMap[key] = {
                        name: l.name,
                        note: [l.attrs, l.note].filter(Boolean).join(" · "),
                        station: l.station,
                        station_color: l.station_color,
                        total: 0,
                        lines: [],
                    };
                }
                groupMap[key].total += l.qty;
                groupMap[key].lines.push({
                    id: l.id,
                    ticketId: t.id,
                    ticketName: t.name,
                    table: t.table ? "โต๊ะ " + t.table : (t.customer || (t.tracking ? "คิว " + t.tracking : t.name)),
                    qty: l.qty,
                    done: l.done || ["ready", "served"].includes(l.state),
                });
            });
        });

        const groups = Object.values(groupMap);
        if (!groups.length) {
            board.innerHTML = '<div class="empty-board">ไม่มีรายการ · No items</div>';
            return;
        }

        const html = groups.map(function (g) {
            const canAll = g.lines.some(function (l) { return !l.done; });
            const lineIds = g.lines.map(function (l) { return l.id; });

            const linesHtml = g.lines.map(function (gl) {
                const stCls = gl.done ? "st-ready" : "st-cooking";
                const stLabel = gl.done ? "เสร็จแล้ว" : "กำลังทำ";
                return (
                    '<div class="line-item" onclick="kdsToggleLine(event,' + gl.id + ')">' +
                        '<div class="line-top">' +
                            '<span class="line-name">' + esc(gl.ticketName) + ' · ' + esc(gl.table) + ' · ×' + esc(gl.qty) + '</span>' +
                            '<span class="st-chip ' + stCls + '">' + esc(stLabel) + '</span>' +
                        '</div>' +
                    '</div>'
                );
            }).join("");

            return (
                '<div class="card">' +
                    '<div class="card-head">' +
                        '<div>' +
                            '<div class="table-no">' + esc(g.name) + '</div>' +
                            (g.note ? '<div class="line-note" style="padding-left:0;">โน้ต: ' + esc(g.note) + '</div>' : '') +
                            stationBadge(g) +
                        '</div>' +
                        '<div style="font-size:20px; font-weight:700; color:var(--ko-primary-dark)">×' + esc(g.total) + '</div>' +
                    '</div>' +
                    '<div class="lines">' + linesHtml + '</div>' +
                    (canAll ? '<button class="card-action-btn btn-all-ready" onclick="kdsAllReadyBatch(\'' + esc(JSON.stringify(lineIds)) + '\')">เสร็จทั้งหมด · All ready</button>' : '') +
                '</div>'
            );
        }).join("");

        board.innerHTML = html;
    }

    function renderHistoryView(tickets) {
        if (!tickets.length) {
            board.innerHTML = '<div class="empty-board">ยังไม่มีรายการประวัติ</div>';
            return;
        }

        const html = tickets.map(function (h) {
            const cardCls = currentTab === "cancelled" ? "cancelled" : "";
            const linesHtml = (h.lines || []).map(function (l) {
                return (
                    '<div class="line-item" style="cursor:default;">' +
                        '<div class="line-top">' +
                            '<span class="line-qty" style="color:var(--ko-muted);">' + esc(l.qty) + '×</span>' +
                            '<span class="line-name">' + esc(l.name) + '</span>' +
                        '</div>' +
                        issueBlock(l) +
                    '</div>'
                );
            }).join("");

            const finishedUtc = currentTab === "cancelled"
                ? h.cancelled_utc
                : (h.served_utc || h.done_utc);
            const finishedAt = finishedUtc ? new Date(finishedUtc) : null;
            const createdAt = h.created_utc ? new Date(h.created_utc) : null;
            const durationMinutes = finishedAt && createdAt
                ? Math.max(0, Math.round((finishedAt.getTime() - createdAt.getTime()) / 60000))
                : null;
            const timeText = finishedAt
                ? finishedAt.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })
                : "--:--";
            const overSla = durationMinutes !== null && durationMinutes > Number(rawData.sla_minutes || 15);
            const meta = currentTab === "cancelled"
                ? "ยกเลิก " + timeText + (durationMinutes === null ? "" : " · หลัง " + durationMinutes + " นาที")
                : "เสิร์ฟแล้ว " + timeText + (durationMinutes === null ? "" : " · ใช้เวลา " + durationMinutes + " นาที") + (overSla ? " (เกิน SLA)" : "");

            return (
                '<div class="card ' + cardCls + '">' +
                    '<div class="card-head">' +
                        '<div class="table-no">' + esc(h.name) + ' · ' + ticketHeadLabel(h) + '</div>' +
                        '<div class="elapsed-label history-meta ' + (overSla ? 'late' : '') + '">' + meta + '</div>' +
                    '</div>' +
                    '<div class="lines">' + linesHtml + '</div>' +
                    '<button class="card-action-btn btn-remake" onclick="kdsRemake(' + h.id + ')">ส่งกลับเข้าครัว · Remake</button>' +
                '</div>'
            );
        }).join("");

        board.innerHTML = html;
    }

    function render() {
        const nowServer = new Date(rawData.now_utc).getTime();
        const nowLocal = Date.now();
        const skew = nowLocal - nowServer;

        if (activeCountEl) {
            activeCountEl.textContent = String(rawData.active ? rawData.active.length : 0);
        }

        if (currentTab === "active") {
            if (currentView === "order") {
                renderOrderView(rawData.active || [], skew);
            } else {
                renderMenuView(rawData.active || []);
            }
        } else if (currentTab === "served") {
            renderHistoryView(rawData.served || []);
        } else if (currentTab === "cancelled") {
            renderHistoryView(rawData.cancelled || []);
        }
    }

    function refresh() {
        // config_id is mandatory: the board only ever shows one shop's tickets.
        const params = new URLSearchParams({
            config_id: window.KDS_CONFIG_ID || "",
            station_id: window.KDS_STATION_ID || "",
        });
        return fetch("/kds/data?" + params.toString())
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.error === "config_required") {
                    board.innerHTML = '<div class="empty-board">ยังไม่ได้เลือกร้าน · <a href="/kds">เลือกร้าน</a></div>';
                    return;
                }
                rawData = data;
                if (slaLabel) {
                    slaLabel.textContent = "SLA เสิร์ฟใน " + Number(data.sla_minutes || 15) + " นาที";
                }
                const active = data.active || [];
                // Alert on any *dish* the station has not seen yet, not only on
                // brand-new tickets: adding two more plates to table 5 has to
                // wake the station too.
                const seenNow = new Set();
                let fresh = 0;
                active.forEach(function (t) {
                    (t.lines || []).forEach(function (l) {
                        seenNow.add(l.id);
                        if (!knownLineIds.has(l.id) && l.state !== "cancelled" && !l.cancelled) {
                            fresh += 1;
                        }
                    });
                });
                if (!firstLoad && fresh > 0) {
                    beep();
                    toast(fresh === 1 ? "มีรายการใหม่เข้าครัว!" : "มีรายการใหม่เข้าครัว " + fresh + " รายการ!");
                    if (!audioUnlocked) {
                        toast("มีรายการใหม่เข้าครัว — แตะหน้าจอหนึ่งครั้งเพื่อเปิดเสียงเตือน");
                    }
                }
                knownLineIds = seenNow;
                firstLoad = false;
                render();
            })
            .catch(function (e) {
                console.warn("KDS poll error:", e);
            });
    }

    // Live clock update
    setInterval(function () {
        if (clock) {
            clock.textContent = new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
        }
    }, 1000);

    refresh();
    window.addEventListener("ko:kds-update", refresh);
    setInterval(refresh, POLL_MS);
})();
