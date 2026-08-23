# Runbook — จอครัว (KDS): สถานี, การส่งออเดอร์, และการแจ้งปัญหา

Prerequisite: read `../AGENTS.md` §0 and §7 first.

This runbook covers the five things the owner asked the kitchen display to do. Every
statement here was checked against `ko_pos_kds` 19.0.6.0.0 / `ko_pos_ui` 19.0.5.0.0.

---

## 1. One screen per shop, one screen per station

| Address | What it is |
| --- | --- |
| `/kds` | shop picker (skipped when the user can only see one POS) |
| `/kds/pos/<config_id>` | that shop's board, **all** stations |
| `/kds/pos/<config_id>?station_id=<id>` | that shop's board, one station only |

Bookmark the third form on the tablet that sits at a station. `/kds/data` refuses to answer
without a `config_id` (`400 config_required`) — that guard is deliberate, see AGENTS §7.9.

## 2. Setting up stations

หลังบ้าน → จุดขาย → ตั้งค่า → **สถานีครัว (KDS)**.

A station has three settings that matter:

- **จุดขาย (POS)** — leave empty and every shop can use it; name a shop and only that
  shop's board offers it.
- **หมวดสินค้าที่ทำที่สถานีนี้** — the normal way to route. Everything in those POS
  categories is cooked here.
- **เมนูเฉพาะ (ระบุรายตัว)** — for the exceptions. A dish named here goes to this station
  even if its category belongs to another one.

Routing order for every dish: **named menu item → category → a station with neither**
(the catch-all). If nothing matches at all, the dish still appears on **every** board
labelled `ไม่ได้กำหนดสถานี`. A setup mistake can slow the kitchen down; it can never hide
an order.

Current production setup (2026-08-23):

| Station | Shop | Cooks |
| --- | --- | --- |
| ครัวร้อน | ร้านชอบแกง | อาหารจานเดียว, กับข้าว |
| เคานเตอร์บาร์ | ร้านชอบแกง | เครื่องดื่ม |
| ขนม | ร้านชอบแกง + ร้านหวานอยู่ | ของหวาน |

`ko_pos_setup` also seeds ครัวร้อน / บาร์น้ำ / ครัวขนม for a **fresh** database. Those three
were deactivated in production because the shop already had its own equivalents. Deactivate,
never delete: `noupdate="1"` data is recreated on the next upgrade if the record is gone.

## 3. The two ways an order reaches the kitchen

**A. Key it, then press ส่งครัว.** Works for a table order, and for a takeaway once the order
has a name — pick the customer with the ลูกค้า button. Odoo hides the Send button on an
unnamed walk-up sale (`isDirectSale`), which is why naming the takeaway matters.

**B. Key it and take the money.** Nothing else to press: the order is sent the instant the
payment validates, because `ko_kds_auto_send_on_payment` is on. There is no
"send to preparation?" dialog any more — it could be dismissed, and dismissing it meant a
paid order the kitchen never saw.

Both paths are independent of the kitchen printer. `pos.printer` only decides what is
*printed*; see `GOTCHAS.md` → "There is no ส่งครัว button at all".

Each station screen beeps and toasts for every **dish** it has not seen before — including
dishes added later to a table that is already on the board. Browsers keep audio muted until
the page is touched once, so the board says so in the toast when sound is still locked.

## 4. Front of house marking dishes as delivered

POS → บิล (`/pos/ui/<id>/ticket`) → **ออเดอร์ค้าง**. The tab lists every order that still has
food to hand over — unpaid table orders *and* paid takeaways, which are marked `จ่ายแล้ว`.

Each dish has a เสิร์ฟ button. It can be pressed at any time; if the kitchen has not marked
the dish ready yet, a confirmation asks first so it cannot be a slip.

## 5. The kitchen telling front of house about a problem

On the board, each dish has **แจ้งปัญหา**: ของหมด / ล่าช้า / ขอเปลี่ยนรายการ / อื่น ๆ plus an
optional note.

- ของหมด also stops that dish (state `cancelled`) — the kitchen will not cook it. It does
  **not** touch the money; refunding is front of house's decision.
- Every POS of that shop gets a red bar at the top of the screen naming the dish, the table
  or customer, and the note, with a chime that repeats every 20 seconds until someone
  presses **รับทราบ**.
- Acknowledging is recorded on the line (`issue_ack`), and serving a flagged dish
  acknowledges it automatically.
- The kitchen can withdraw a report with ยกเลิกการแจ้ง on the board.

## 6. After deploying a KDS or POS UI change

Every till that already had the POS open keeps the old code until it is hard-refreshed, and
the JS bundle needs a cache revalidation as well. The exact recipe is in `GOTCHAS.md` →
"A deployed POS CSS/JS change is invisible in a browser that already had the POS open".
Quickest proof a tab is running the deployed code:

```js
typeof posmodel.koSendToKds === 'function'   // false/undefined = stale tab
```

The kitchen board carries its version in the script URL
(`/ko_pos_kds/static/src/kds/kds.js?v=19.0.6.0.0`), so it updates on a normal reload.
