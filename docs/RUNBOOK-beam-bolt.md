# Runbook — Beam Bolt+ Payment Terminal

This integration uses Beam API v1 **Pairing Mode**. Odoo talks to Beam from the server;
the Merchant API key never enters the POS browser. Start in Playground and move to
Production only after the whole flow passes.

Official references:

- <https://docs.beamcheckout.com/bolt-connections/bolt-connection-api>
- <https://docs.beamcheckout.com/bolt-intents/bolt-intent-api>
- <https://docs.beamcheckout.com/playground>

## 1. Prerequisites

You need a Beam merchant account, Merchant ID, Merchant API key, and a Beam Bolt device.
Create Playground credentials in Playground Lighthouse first. Playground and Production
credentials, connections, and transactions are isolated from one another.

Odoo locks payment-method changes while a POS session is open. Configure or re-pair the
terminal during an agreed maintenance window; never close a session with real sales just
to unlock this form.

Production already has two safe, unassigned shells: payment method id 8 is
`Beam Bolt - Playground (ยังไม่เปิดใช้)` and id 9 is
`Beam Bolt - Production (ยังไม่เปิดใช้)`. Both use journal `ธนาคาร` but have no Beam
integration, credentials, connection, or POS assignment. Configure id 8 first; leave id 9
disabled until Playground passes.

## 2. Configure the payment method

In Odoo, open **Point of Sale → Configuration → Payment Methods** and create or edit a
bank payment method:

1. In the Thai UI, set **การผสานรวม** to **เครื่องรูดบัตร** first. This reveals a
   second field named **ผสานรวมกับ**; select **Beam Bolt+** there. Beam does not appear
   in the first dropdown.
2. Enter the Beam Merchant ID and API key.
3. Turn on **Beam Playground (test)** while testing.
4. Choose the payment method that this Odoo payment method should request on the device.
   Create separate Odoo methods when the cashier needs separate Card and PromptPay buttons.
5. Keep expiry between 90 and 600 seconds. The default is 120 seconds.
6. Save the payment method and attach it to the required POS shop.

For card installments, also choose the installment period and issuing-bank group. These
values follow Beam API v1 exactly.

## 3. Pair the device

1. Log in to the correct merchant on the Bolt device and enter **Pairing Mode**.
2. Enter the Pairing code exactly as shown on the device or Beam Bolt Android app in
   Odoo. Current Android app builds can show an eight-digit code. The Beam API schema
   defines this value as a string and does not impose a six-digit limit.
3. Press **เชื่อมต่อเครื่อง** before the code expires.
4. Odoo stores both the returned Bolt Connection ID and Device ID. Press
   **ตรวจสอบการเชื่อมต่อ** and require the green connected status before checkout testing.

Do not switch Merchant ID, API key, Playground/Production, or terminal type while a
connection exists. Odoo blocks that change so the device is not left paired to an orphaned
connection. Disconnect first.

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
creating another Bolt Intent. The POS enforces this delay on retry.

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
2. Disconnect the Playground Bolt Connection. The device logs out by Beam design.
3. Turn off Playground, enter the Production Merchant ID/API key, and save.
4. Log the device into the Production merchant, pair it again, and verify the new Device ID.
5. Run one small real transaction, confirm it in Production Lighthouse, then refund it and
   reconcile Odoo before accepting normal traffic.

Never paste Merchant API keys into Git, chat, screenshots, browser code, or logs.

## 7. Current limitation

The POS terminal interface does not yet submit refunds to Beam automatically. Complete the
Odoo refund flow for restaurant/accounting records, then refund the matching Charge ID in
Beam Lighthouse and reconcile both sides. Add automated Beam Refunds API support only with
an end-to-end refund and late-charge reconciliation design.
