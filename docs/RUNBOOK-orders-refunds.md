# Runbook — บิล & ออเดอร์: แก้ไขออเดอร์, ยกเลิก, และคืนเงิน

Prerequisite: read `../AGENTS.md` §0 and §7 first.

Everything here was checked against `ko_pos_ui` 19.0.6.1.0 / `ko_pos_kds` 19.0.7.0.0 on a
disposable Odoo 19 database. The screen is the **บิล** tab in the bottom nav, or
`/pos/ui/<config_id>/ticket`.

---

## 1. The two tabs

| Tab | What is in it |
| --- | --- |
| **ออเดอร์ค้าง** | work that is not finished: every unpaid order, paid orders that still have a dish nobody has carried out, and any refund that was started and never paid |
| **บิลแล้ว** | every finalised bill of this session, newest first, with its status |

A paid takeaway belongs in **ออเดอร์ค้าง** until the last dish is served — that is
deliberate, not a bug. A bill refunded in full drops out of that tab completely; there is
nothing left to serve.

---

## 2. ออเดอร์ค้าง — changing an order that has not been paid

Everything can be done on the card itself:

| Control | What it does |
| --- | --- |
| **− / +** on a dish | changes that dish's quantity. At 1 → 0 the dish is removed |
| **✕** on a dish | removes that dish outright |
| **เสิร์ฟ** | marks that dish carried out (unchanged behaviour) |
| **เพิ่ม / แก้ไขรายการ**, or tapping the card header | opens that exact order on the Sell screen, so new dishes can be keyed |
| **ยกเลิกออเดอร์** | throws the whole order away |

Tapping the header is the only way back into a **takeaway**, which has no table to tap on
the floor plan.

The kitchen is told immediately — not on the next ส่งครัว. Removing or reducing a dish the
kitchen is already **กำลังทำ**, **พร้อมเสิร์ฟ** or **เสิร์ฟแล้ว** asks for confirmation
first, then strikes exactly that quantity off the board. Removing the last dish cancels the
order. **ยกเลิกออเดอร์** asks once, then deletes the order and closes its kitchen ticket
outright, so nothing is left cooking. Use it for a walk-out or a mis-keyed order.

Adding dishes still goes to the kitchen the normal way: press **ส่งครัว** on the Sell
screen. The kitchen is sent the difference, not the whole order again.

> A **paid** order in this tab has no − / + / ✕ and no cancel button. Changing money that
> has already been taken is a refund, never an edit.

> A card labelled **คืนเงิน · ยังไม่จบ** is a refund somebody walked away from.
> **ทำรายการคืนเงินต่อ** opens it so it can be paid; **ทิ้งรายการนี้** discards it. Leave
> neither hanging — an unfinished refund counts as an open order at session close.

---

## 3. บิลแล้ว — the status of a bill

| Label | Meaning |
| --- | --- |
| **ชำระแล้ว · Paid** | money taken, nothing returned |
| **คืนเงินบางส่วน · Partly refunded** | some lines have been paid back |
| **คืนเงินครบแล้ว · Refunded** | every line has been paid back |
| **รายการคืนเงิน · Refund** | this row *is* a refund document, not a sale |

"คืนเงิน…" only ever means money that actually went back to the customer. Starting a refund
and not finishing it does **not** change the label.

---

## 4. Refunding part of a bill — the normal case

Customer wants one dish taken off a bill that is already paid:

1. บิลแล้ว → tap the bill.
2. Find the line. Tap **+** on its stepper until it shows how many to give back.
3. The red button at the bottom shows the count and the money as you go.
4. Tap **คืนเงิน N ชิ้น**.
5. The payment screen opens with a negative total. Choose how the money goes back and press
   **ยืนยันชำระเงิน**.

The kitchen loses exactly those dishes. Refund one plate out of three and the other two stay
on the board and keep cooking. The rest of the bill is untouched, and the bill's label
becomes **คืนเงินบางส่วน**.

A line that has already been paid back shows **คืนไปแล้ว N** and its stepper stops at what
is left — you cannot refund the same plate twice.

**เลือกทั้งบิล** fills in every remaining quantity at once; **ล้าง** clears the selection.

## 5. Refunding a whole bill

Same sheet, **ยกเลิกบิล**, two taps (the second says *ยืนยันยกเลิก?*). It selects everything
still refundable and goes to the same payment screen. Once paid, the whole kitchen ticket is
cancelled and the order leaves ออเดอร์ค้าง.

## 6. A refund that was started and not finished

If someone taps คืนเงิน and then walks away, the half-finished refund shows up in
**ออเดอร์ค้าง** as a card labelled **คืนเงิน · ยังไม่จบ** — see §2. No money has moved, so
the original bill keeps its old label and can still be refunded.

Starting a new refund on the same bill throws the abandoned one away automatically, so a
retry is never an empty ฿0 refund. Discarding it by hand (**ทิ้งรายการนี้**) does the same.

---

## 7. "The customer wants to change one dish on a paid bill"

Two ways, and the first is usually right:

**Refund just that dish (§4), then key the replacement as a new order.** The kitchen sees
one dish cancelled and one dish added, and the customer pays only the difference in cash.

**แก้ไขบิล** is for when the whole bill is wrong. It refunds the bill in full, then hands
the same dishes back as a fresh order on the same table, ready to change and charge again.
Know what it costs before using it: the kitchen ticket for the old bill is cancelled and the
corrected order is fired as a **new** ticket, so anything unchanged is cooked again. Use it
for a bill keyed against the wrong table or the wrong customer, not to swap one plate.

---

## 8. What to check if something looks wrong

| Symptom | Look at |
| --- | --- |
| tapping an order card does nothing | the till is on an old bundle — hard refresh once (`docs/GOTCHAS.md`, "A deployed POS CSS/JS change is invisible…") |
| the payment screen looks like plain Odoo | same: old bundle. The KO screen must appear at every width |
| a bill says คืนเงินครบแล้ว but no money was returned | pre-19.0.6.0.0 behaviour; see `docs/GOTCHAS.md` |
| refunded dish still on the kitchen board | check the refund was actually **validated**, not just started |
| the refund order comes out 0 บาท | an abandoned refund is still attached — discard it from ออเดอร์ค้าง first |
| a table's fresh order turned into a refund | pre-19.0.6.1.0 behaviour; see `docs/GOTCHAS.md` |

Every till that already had the POS open needs **one hard refresh** after a deploy. Nothing
above works on a stale bundle.
