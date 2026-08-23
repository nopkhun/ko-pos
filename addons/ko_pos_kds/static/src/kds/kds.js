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

    let currentTab = "active"; // 'active' | 'served' | 'cancelled'
    let currentView = "order"; // 'order' | 'menu'
    let currentStation = "all"; // 'all' | 'hot' | 'cold' | 'drink'

    let rawData = { active: [], served: [], cancelled: [], now_utc: new Date().toISOString() };
    let knownTicketIds = new Set();
    let firstLoad = true;
    let audioCtx = null;
    let toastTimer = null;

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

    function beep() {
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.type = "sine";
            osc.frequency.value = 880;
            gain.gain.setValueAtTime(0.35, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.5);
        } catch (e) {
            /* autoplay policy */
        }
    }

    function esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function fmtElapsed(ms) {
        const mins = Math.floor(ms / 60000);
        const secs = Math.floor((ms % 60000) / 1000);
        return (mins < 10 ? "0" + mins : mins) + ":" + (secs < 10 ? "0" + secs : secs);
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

    window.kdsSetStation = function (stn) {
        currentStation = stn;
        document.querySelectorAll(".stn-chip").forEach(function (chip) {
            chip.classList.remove("active");
        });
        const activeChip = document.getElementById("stn-" + stn);
        if (activeChip) {
            activeChip.classList.add("active");
        }
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

    function renderOrderView(tickets, skew) {
        const filtered = tickets.filter(function (t) {
            if (currentStation === "all") return true;
            return (t.lines || []).some(function (l) { return l.station === currentStation; });
        });

        if (!filtered.length) {
            board.innerHTML = '<div class="empty-board">ไม่มีออเดอร์ค้าง · All caught up 🎉</div>';
            return;
        }

        const html = filtered.map(function (t) {
            const created = new Date(t.created_utc).getTime() + skew;
            const elapsedMs = Math.max(0, Date.now() - created);
            const mins = elapsedMs / 60000;
            const slaMinutes = Math.max(1, Number(rawData.sla_minutes || 15));
            const warnAt = Math.max(1, slaMinutes * 0.55);
            const cardCls = mins >= slaMinutes ? "late" : mins >= warnAt ? "warn" : "";
            const isLate = mins >= slaMinutes;
            const elapsedText = isLate ? Math.floor(mins) + " นาที · เกิน SLA" : Math.floor(mins) + " นาที";
            const slaPct = Math.min(100, Math.round((mins / slaMinutes) * 100)) + "%";

            const lines = (t.lines || []).filter(function (l) {
                return currentStation === "all" || l.station === currentStation;
            }).map(function (l) {
                const isCancelled = l.state === "cancelled" || l.cancelled;
                const isReady = ["ready", "served"].includes(l.state) || l.done;
                const stCls = isCancelled ? "st-cancelled" : isReady ? "st-ready" : "st-cooking";
                const stLabel = isCancelled ? "ยกเลิก" : isReady ? "เสร็จแล้ว" : "กำลังทำ";
                const stnCls = "stn-" + (l.station || "hot");
                const stnLabel = l.station === "drink" ? "เครื่องดื่ม" : l.station === "cold" ? "ครัวเย็น" : "ครัวร้อน";
                const note = [l.attrs, l.note].filter(Boolean).join(" · ");

                return (
                    '<div class="line-item" ' + (isCancelled ? '' : 'onclick="kdsToggleLine(event,' + l.id + ')"') + '>' +
                        '<div class="line-top">' +
                            '<span class="line-qty">' + esc(l.qty) + '×</span>' +
                            '<span class="line-name">' + esc(l.name) + '</span>' +
                            '<span class="stn-label ' + stnCls + '">' + esc(stnLabel) + '</span>' +
                            '<span class="st-chip ' + stCls + '">' + esc(stLabel) + '</span>' +
                        '</div>' +
                        (note ? '<div class="line-note">โน้ต: ' + esc(note) + '</div>' : '') +
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

            const tableLabel = t.table ? "โต๊ะ " + esc(t.table) : (t.tracking ? "คิว " + esc(t.tracking) : esc(t.name));
            const shortNo = esc(t.name);

            return (
                '<div class="card ' + cardCls + '" data-created="' + created + '">' +
                    '<div class="card-head">' +
                        '<div class="table-group">' +
                            '<div class="table-no">' + shortNo + ' · ' + tableLabel + '</div>' +
                            (t.remake ? '<span class="badge-remake">ทำใหม่</span>' : '') +
                        '</div>' +
                        '<div class="elapsed-label">' + elapsedText + '</div>' +
                    '</div>' +
                    '<div class="sla-bar-wrap"><div class="sla-bar" style="width:' + slaPct + '"></div></div>' +
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
                if (currentStation !== "all" && l.station !== currentStation) return;
                if (l.cancelled || l.state === "cancelled") return;
                const key = l.name + "|" + (l.attrs || "") + "|" + (l.note || "");
                if (!groupMap[key]) {
                    groupMap[key] = {
                        name: l.name,
                        note: [l.attrs, l.note].filter(Boolean).join(" · "),
                        station: l.station || "hot",
                        total: 0,
                        lines: [],
                    };
                }
                groupMap[key].total += l.qty;
                groupMap[key].lines.push({
                    id: l.id,
                    ticketId: t.id,
                    ticketName: t.name,
                    table: t.table ? "โต๊ะ " + t.table : (t.tracking ? "คิว " + t.tracking : t.name),
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
            const stnCls = "stn-" + g.station;
            const stnLabel = g.station === "drink" ? "เครื่องดื่ม" : g.station === "cold" ? "ครัวเย็น" : "ครัวร้อน";
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
                            '<div class="stn-label ' + stnCls + '">' + esc(stnLabel) + '</div>' +
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
                    '</div>'
                );
            }).join("");

            const tableLabel = h.table ? "โต๊ะ " + esc(h.table) : (h.tracking ? "คิว " + esc(h.tracking) : esc(h.name));
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
                        '<div class="table-no">' + esc(h.name) + ' · ' + tableLabel + '</div>' +
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
                const newIds = active.filter(function (t) { return !knownTicketIds.has(t.id); });
                if (!firstLoad && newIds.length > 0) {
                    beep();
                    toast("มีออเดอร์ใหม่เข้ามา!");
                }
                knownTicketIds = new Set((active.concat(data.served || [])).map(function (t) { return t.id; }));
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
