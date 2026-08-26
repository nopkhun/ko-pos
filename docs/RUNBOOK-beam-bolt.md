# Runbook — Beam Bolt+ Payment Terminal

This integration uses Beam API v1 **Pairing Mode**. Odoo talks to Beam from the server;
the Merchant API key never enters the POS browser. Start in Playground and move to
Production only after the whole flow passes.

Official references:

- <https://docs.beamcheckout.com/bolt-connections/bolt-connection-api>
- <https://docs.beamcheckout.com/bolt-intents/bolt-intent-api>
- <https://docs.beamcheckout.com/refunds/refunds-api>
- <https://docs.beamcheckout.com/transactions/transactions-api>
- <https://docs.beamcheckout.com/playground>

## 1. Prerequisites

You need a Beam merchant account, Merchant ID, Merchant API key, and a Beam Bolt device.
Create Playground credentials in Playground Lighthouse first. Playground and Production
credentials, connections, and transactions are isolated from one another.

Odoo locks payment-method changes while a POS session is open. Configure or re-pair the
terminal during an agreed maintenance window; never close a session with real sales just
to unlock this form.

Current production state verified on 2026-08-25: payment method id 5, `บัตรเครดิต`, is the
connection owner. It uses journal `ธนาคาร`, is assigned to both POS shops, is configured
for Beam Production, and reports `เชื่อมต่อแล้ว`. The formerly documented prepared records
id 8/id 9 no longer exist. Do not rely on historical record IDs: open the Payment Methods
list and verify the owner name, environment, connected status, and POS assignments before
creating a dependent method.

## 2. Configure the payment method

In Odoo, open **Point of Sale → Configuration → Payment Methods** and create or edit a
bank payment method:

1. In the Thai UI, set **การผสานรวม** to **เครื่องรูดบัตร** first. This reveals a
   second field named **ผสานรวมกับ**; select **Beam Bolt+** there. Beam does not appear
   in the first dropdown.
2. For the first payment method on an environment/device, leave
   **ใช้การเชื่อมต่อ Beam จาก** empty, enter the Beam Merchant ID/API key, and turn on
   **Beam Playground (test)** while testing. This is the connection owner.
3. Choose the payment method that this Odoo payment method should request on the device.
4. For each additional cashier button, create another Odoo payment method, select Beam
   Bolt+, and choose the already-paired owner under **ใช้การเชื่อมต่อ Beam จาก**. Do not
   enter credentials or Pair again. Set its own payment type, such as `QR_PROMPT_PAY`.
5. Keep expiry between 90 and 600 seconds. The default is 120 seconds.
6. Save each payment method and attach the required buttons to the same POS shop.

For card installments, also choose the installment period and issuing-bank group. These
values follow Beam API v1 exactly.

## 3. Pair the device

Pair only the connection owner. Shared Card, PromptPay, installment, and wallet payment
methods all reuse that owner's Bolt Connection ID.

1. Log in to the correct merchant on the Bolt device and enter **Pairing Mode**.
2. Enter the Pairing code exactly as shown on the device or Beam Bolt Android app in
   Odoo. Current Android app builds can show an eight-digit code. The Beam API schema
   defines this value as a string and does not impose a six-digit limit.
3. Press **เชื่อมต่อเครื่อง** before the code expires.
4. Odoo stores both the returned Bolt Connection ID and Device ID. Press
   **ตรวจสอบการเชื่อมต่อ** and require the green connected status before checkout testing.

Do not switch Merchant ID, API key, Playground/Production, or terminal type while a
connection exists. Odoo blocks that change so the device is not left paired to an orphaned
connection. Odoo also blocks disconnecting the owner while another payment method still
uses it. Move each dependent to another paired source, or change it away from Beam Bolt+,
before disconnecting the owner.

## 4. Test a payment

Open the POS, add a small test order, select the Beam payment method, and confirm:

1. the exact amount and chosen payment method appear on Bolt;
2. POS remains waiting while the Bolt Intent is active;
3. a successful payment changes the line to paid and records the Beam Charge ID on the
   Odoo payment/receipt;
4. Cancel from POS cancels the Bolt Intent before the payment line is removed;
5. expiry and decline cases return the cashier to Retry only after Beam reports a final
   result.

Beam recommends waiting at least five seconds after connect, cancel, or expiry before
creating another Bolt Intent. From `ko_pos_beam_bolt` 19.0.3.1.0 onward the POS enforces
this delay across every payment method that shares the device, including Card → PromptPay.

### Cancel or change the payment method at checkout

While Bolt is waiting, the KO payment page must show the current terminal status and a red
**ยกเลิกรายการ · Cancel** button. Press that button in Odoo and wait until the message says
**รายการเดิมถูกยกเลิกแล้ว สามารถเลือกช่องทางใหม่ได้** before selecting Card, PromptPay,
cash, or another method. Odoo deliberately blocks switching while a terminal request may
still charge the customer.

If the customer already cancelled in the Beam Bolt app, press the same Odoo Cancel button.
Odoo re-reads the Bolt Intent; a final `BI_CANCELED`, `BI_EXPIRED`, or failed Charge releases
Odoo's standard terminal lock. A successful or still-uncertain Beam result stays blocked so
staff cannot accidentally collect the bill twice. The five-second device cooldown is then
applied automatically before the next Bolt Intent.

## 5. Network failures and duplicate-payment safety

Every Beam `POST` and `PATCH` carries `x-beam-idempotency-key`. If intent creation times
out, the POS stores that key in the standard transaction field as `beam-idem:<key>` and
Retry repeats the same request. It must not create a new intent. Cancel first recovers the
authoritative intent with that same key, then cancels it.

If the screen says it cannot confirm the result, do not start another payment method for
the same bill. Restore connectivity and let polling continue, or reconcile the Bolt Intent
and Charge in Beam Lighthouse. Beam warns that a Charge started just before cancel/expiry
can still succeed; refund that late Charge manually if it no longer belongs to the order.

## 6. Move from Playground to Production

1. Finish all Playground scenarios and reconcile their Charge IDs.
2. Move every dependent payment method to another paired source, or change it away from
   Beam Bolt+. Merely clearing `ใช้การเชื่อมต่อ Beam จาก` makes that method a new connection
   owner and therefore requires its own credentials and Pairing.
3. Disconnect the Playground Bolt Connection. The device logs out by Beam design.
4. Turn off Playground, enter the Production Merchant ID/API key, and save.
5. Log the device into the Production merchant, pair it again, and verify the new Device ID.
6. Run one small real transaction, confirm it in Production Lighthouse, then refund it and
   reconcile Odoo before accepting normal traffic.

Never paste Merchant API keys into Git, chat, screenshots, browser code, or logs.

## 7. Void and refund policy

`ko_pos_beam_bolt` 19.0.4.0.0 / `ko_pos_ui` 19.0.7.0.0 separate cancellation, same-day
card Void, and later Refund. They are not interchangeable:

- An unpaid order is cancelled without moving money.
- An active Bolt Intent is cancelled with the Bolt Intent API; this is not a refund.
- A paid Beam `CARD` bill with exactly one positive payment can be submitted from POS only
  when both the original payment and the request are on the same Bangkok calendar day and
  before **19:30 Asia/Bangkok**. The server enforces the cutoff. POS sends
  `POST /api/v1/refunds`, keeps one idempotency key, polls the Refund to `SUCCEEDED`, and
  only then validates the negative Odoo order and updates KDS.
- At or after 19:30, on a previous date, without a stored `ch_` Charge ID, with multiple
  payment lines, or for Beam types other than plain `CARD`, POS sends no Beam request.
  For a later Card refund, a manager completes it in Beam Lighthouse, returns to the POS
  refund screen, enters the Refund ID, ticks that the money actually returned, and then
  records Odoo. PromptPay and other non-refundable Beam types follow the store's external
  return procedure and use that transfer/reference instead. Never choose Cash just to
  enable the button.
- Cash requires the cashier to hand back the displayed amount and tick the confirmation
  before Odoo can validate. A non-Beam external method likewise requires a reference and
  confirmation.

Beam creates a Refund resource for every reversal and later records the successful money
transaction as either `VOID` or `REFUND`. The Refund object itself does not make that
distinction. POS reads `/transactions/{refundId}` when available and stores the authoritative
type on the payment receipt; if that lookup is not ready yet it records `REVERSAL`, not a
guessed `VOID`.

### What staff see

1. The bill sheet states the original payment method and whether the next step is POS Void,
   cash hand-back, Lighthouse, or manager review.
2. The refund payment screen locks every payment method except the original one.
3. Before the cutoff, the button says **ส่ง Void ผ่าน Beam ฿…**. Keep the screen open while
   it says Beam is processing; do not press twice.
4. A Lighthouse/manual route keeps the final button disabled until a reference of at least
   four characters is entered and **เงินจริงถูกคืนให้ลูกค้าแล้ว** is ticked.
5. If Beam has returned a Refund ID, a request is ambiguous, or staff already confirmed a
   manual/cash hand-back, the unfinished refund cannot be discarded or silently replaced.
   Open **ออเดอร์ค้าง → ทำรายการคืนเงินต่อ** and finish the same record.

If a request started before 19:30 times out across the cutoff, retrying the same screen uses
the original idempotency key only to recover that request; it must not create a new Refund.
If Beam remains `PENDING`, leave the refund open and reconcile the same Refund ID in
Lighthouse. Never start a second refund for the charge.

Automatic POS Void is deliberately limited to a single original `CARD` payment. Mixed
tenders, manager PIN approval, webhook-driven reconciliation, attachments, and a central
pending-refund dashboard remain follow-up work; do not emulate them by splitting one refund
onto an unrelated payment method.
