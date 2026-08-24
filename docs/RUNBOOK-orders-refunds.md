# Runbook — บิล & ออเดอร์: แก้ไขออเดอร์, ยกเลิก, และคืนเงิน

Prerequisite: read `../AGENTS.md` §0 and §7 first.

Everything here was checked against `ko_pos_ui` 19.0.6.0.0 / `ko_pos_kds` 19.0.7.0.0 on a
disposable Odoo 19 database. The screen is the **บิล** tab in the bottom nav, or
`/pos/ui/<config_id>/ticket`.

---

## 1. The two tabs

| Tab | What is in it |
| --- | --- |
| **ออเดอร์ค้าง** | work that is not finished: every unpaid order, plus paid orders that still have a dish nobody has carried out |
| **บิลแล้ว** | every finalised bill of this session, newest first, with its status |

A paid takeaway belongs in **ออเดอร์ค้าง** until the last dish is served — that is
deliberate, not a bug. A bill that has been refunded in full drops out of that tab
completely; there is nothing left to serve.

---

## 2. ออเดอร์ค้าง — changing an order that has not been paid

Each unpaid card has two buttons under its dish list.

**แก้ไขออเดอร์** opens that exact order on the Sell screen. Add dishes by tapping the menu;
remove them with the − stepper on the order line (at 1 → 0 the line disappears). This is the
only way back into a **takeaway**, which has no table to tap on the floor plan.

After changing anything, press **ส่งครัว** again. The kitchen is sent the difference, not
the whole order again: new dishes appear, removed ones are struck off, and a changed
quantity is corrected. A dish the kitchen already marked เสร็จ is left alone.

**ยกเลิกออเดอร์** needs two taps — the second says *ยืนยันยกเลิก?*. It deletes the order and
closes its kitchen ticket outright, so nothing is left cooking. Use it for a walk-out or a
mis-keyed order.

> A **paid** order in this tab has no edit or cancel button. It shows a note pointing at
> บิลแล้ว instead. Changing money that has already been taken is a refund, never an edit.

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
3. The row **เลือกคืนเงิน N ชิ้น** shows the money as you go.
4. Tap **คืนเงินรายการที่เลือก**.
5. The payment screen opens with a negative total. Choose how the money goes back and press
   **ยืนยันชำระเงิน**.

The kitchen loses exactly those dishes. Refund one plate out of three and the other two
stay on the board and keep cooking. The rest of the bill is untouched, and the bill's label
becomes **คืนเงินบางส่วน**.

A line that has already been paid back shows **คืนเงินแล้ว N ชิ้น** and offers no stepper —
you cannot refund the same plate twice.

## 5. Refunding a whole bill

Same sheet, **คืนเงินทั้งบิล**, two taps (the second says *ยืนยันคืนทั้งบิล?*). It selects
everything still refundable and goes to the same payment screen. Once paid, the whole
kitchen ticket is cancelled and the order leaves ออเดอร์ค้าง.

## 6. A refund that was started and not finished

If someone taps คืนเงิน and then walks away, the bill sheet shows an orange banner naming
the amount: *มีบิลคืนเงินค้างอยู่ ฿X — ยังไม่ได้จ่ายคืนลูกค้า*, with two buttons.

- **ทำต่อ · จ่ายคืน** — opens the half-finished refund so it can be paid.
- **ทิ้งบิลคืนเงิน** — throws it away. No money has moved, so the original bill goes back to
  exactly what it was and can be refunded again.

While that banner is up the refund buttons are hidden, so the same bill cannot be refunded
twice by two people at once. Reprint and ใบกำกับภาษี still work.

---

## 7. "The customer wants to change one dish on a paid bill"

There is no แก้ไขบิล button any more, and that is on purpose: the old one refunded the whole
bill and re-keyed every line onto a new order, which sent the **entire order to the kitchen
a second time**. A customer who swapped one dish got everything cooked twice.

Do it in two honest steps instead:

1. Refund just the wrong dish (§4).
2. Key the replacement as a new order and take payment for it.

The kitchen sees exactly one dish cancelled and one dish added.

---

## 8. What to check if something looks wrong

| Symptom | Look at |
| --- | --- |
| tapping an order card does nothing | the till is on an old bundle — hard refresh once (`docs/GOTCHAS.md`, "A deployed POS CSS/JS change is invisible…") |
| the payment screen looks like plain Odoo | same: old bundle. The KO screen must appear at every width |
| a bill says คืนเงินครบแล้ว but no money was returned | pre-19.0.6.0.0 behaviour; see `docs/GOTCHAS.md` |
| refunded dish still on the kitchen board | check the refund was actually **validated**, not just started |
| the refund order comes out 0 บาท | an abandoned refund is still attached — use ทิ้งบิลคืนเงิน first |

Every till that already had the POS open needs **one hard refresh** after a deploy. Nothing
above works on a stale bundle.
