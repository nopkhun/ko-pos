import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

function synthetic(exports) {
    const names = Object.keys(exports);
    return new vm.SyntheticModule(names, function () {
        for (const [name, value] of Object.entries(exports)) {
            this.setExport(name, value);
        }
    });
}

async function loadModule(path, stubs) {
    const source = fs.readFileSync(path, "utf8");
    const module = new vm.SourceTextModule(source, { identifier: path });
    await module.link(async (specifier) => {
        if (!(specifier in stubs)) {
            throw new Error(`Missing test stub for ${specifier}`);
        }
        return synthetic(stubs[specifier]);
    });
    await module.evaluate();
    return module.namespace;
}

function translate(message, ...values) {
    let translated = message;
    for (const value of values) {
        translated = translated.replace("%s", String(value));
    }
    return translated;
}

class PaymentInterface {
    constructor(pos, paymentMethod) {
        this.setup(pos, paymentMethod);
    }

    setup(pos, paymentMethod) {
        this.pos = pos;
        this.env = pos.env;
        this.payment_method_id = paymentMethod;
    }

    async sendPaymentRequest() {}
    async sendPaymentCancel() {}
}

function makeLine(status = "waitingCard") {
    return {
        uuid: "line-1",
        amount: 100,
        payment_method_id: { payment_terminal: {} },
        transaction_id: "bolti_test",
        payment_status: status,
        uiState: { beam_bolt_intent_id: "bolti_test" },
        setPaymentStatus(value) {
            this.payment_status = value;
        },
        getPaymentStatus() {
            return this.payment_status;
        },
        isElectronic() {
            return Boolean(this.payment_status);
        },
        isDone() {
            return this.payment_status
                ? ["done", "reversed"].includes(this.payment_status)
                : true;
        },
        setReceiptInfo() {},
    };
}

const beamPath = fileURLToPath(
    new URL("../static/src/app/payment_beam_bolt.js", import.meta.url)
);
const beam = await loadModule(beamPath, {
    "@web/core/l10n/translation": { _t: translate },
    "@point_of_sale/app/utils/payment/payment_interface": { PaymentInterface },
    "@web/core/confirmation_dialog/confirmation_dialog": { AlertDialog: class {} },
    "@point_of_sale/app/services/pos_store": { register_payment_method() {} },
});

{
    const line = makeLine();
    const pos = {
        env: { services: { dialog: { add() {} } } },
        getOrder: () => ({ payment_ids: [line] }),
        getPendingPaymentLine: () => line,
    };
    const terminal = new beam.PaymentBeamBolt(pos, { id: 5, name: "Beam" });
    const calls = [];
    terminal._callBeam = async (method) => {
        calls.push(method);
        if (method === "beam_cancel_bolt_intent") {
            return { error: "already canceled", status_code: 409 };
        }
        return { result: "BI_CANCELED" };
    };
    let pollingResult = null;
    terminal.pollingResolve = (value) => {
        pollingResult = value;
    };

    assert.equal(await terminal.sendPaymentCancel(pos.getOrder(), line.uuid), true);
    assert.deepEqual(calls, ["beam_cancel_bolt_intent", "beam_get_bolt_intent"]);
    assert.equal(pollingResult, false);
    assert.equal(line.transaction_id, "");
    assert.ok(pos.beamBoltReadyAfter > Date.now());
}

{
    const line = makeLine();
    const pos = {
        env: { services: { dialog: { add() {} } } },
        getOrder: () => ({ payment_ids: [line] }),
        getPendingPaymentLine: () => line,
    };
    const terminal = new beam.PaymentBeamBolt(pos, { id: 5, name: "Beam" });
    terminal._callBeam = async () => ({ result: "BI_CANCELED" });

    assert.equal(await terminal._pollUntilResolved(line, "bolti_test"), false);
    assert.equal(line.transaction_id, "");
    assert.ok(pos.beamBoltReadyAfter > Date.now());
}

{
    const line = makeLine("pending");
    line.transaction_id = "";
    line.uiState = {};
    const order = {
        uuid: "order-1",
        name: "Order 1",
        payment_ids: [line],
        getSelectedPaymentline: () => line,
    };
    const pos = {
        beamBoltReadyAfter: Date.now() + 30,
        env: { services: { dialog: { add() {} } } },
        getOrder: () => order,
        getPendingPaymentLine: () => line,
    };
    const terminal = new beam.PaymentBeamBolt(pos, { id: 6, name: "PromptPay" });
    let createCalledAt = 0;
    terminal._callBeam = async () => {
        createCalledAt = Date.now();
        return { id: "bolti_new" };
    };
    terminal._pollUntilResolved = async () => true;
    const startedAt = Date.now();

    assert.equal(await terminal.sendPaymentRequest(line.uuid), true);
    assert.ok(createCalledAt - startedAt >= 15, "shared device cooldown was not respected");
}

{
    const line = makeLine("pending");
    line.amount = -40.25;
    line.transaction_id = "";
    line.uiState = {};
    line.payment_ref_no = "";
    let receipt = "";
    line.setReceiptInfo = (value) => {
        receipt = value;
    };
    const sourcePayment = {
        id: 91,
        uuid: "source-payment",
        amount: 100,
        transaction_id: "ch_source",
        payment_method_id: { id: 5 },
    };
    const sourceOrder = { uuid: "source-order", payment_ids: [sourcePayment] };
    const order = {
        uuid: "refund-order",
        name: "Refund 1",
        payment_ids: [line],
        getOrderlines: () => [{ refunded_orderline_id: { order_id: sourceOrder } }],
        getSelectedPaymentline: () => line,
    };
    const pos = {
        env: { services: { dialog: { add() {} } } },
        getOrder: () => order,
        getPendingPaymentLine: () => line,
    };
    const terminal = new beam.PaymentBeamBolt(pos, { id: 5, name: "Beam Card" });
    const calls = [];
    terminal._callBeam = async (method, data) => {
        calls.push([method, data]);
        if (method === "beam_create_pos_void") {
            return { refundId: "re_void" };
        }
        return { refundId: "re_void", status: "SUCCEEDED", transactionType: "VOID" };
    };

    assert.equal(await terminal.sendPaymentRequest(line.uuid), true);
    assert.deepEqual(calls.map(([method]) => method), ["beam_create_pos_void", "beam_get_refund"]);
    assert.equal(calls[0][1].original_payment_id, 91);
    assert.equal(calls[0][1].charge_id, "ch_source");
    assert.equal(calls[0][1].amount_thb, 40.25);
    assert.equal(line.transaction_id, "re_void");
    assert.equal(line.payment_ref_no, "re_void");
    assert.match(receipt, /Beam VOID: re_void/);
}

const toasts = [];
class PaymentScreen {}
const uiPath = fileURLToPath(
    new URL("../../ko_pos_ui/static/src/app/ko_payment_screen.js", import.meta.url)
);
await loadModule(uiPath, {
    "@odoo/owl": { onMounted() {}, useState: (value) => value },
    "@point_of_sale/app/screens/payment_screen/payment_screen": { PaymentScreen },
    "@web/core/currency": { formatCurrency: (value) => String(value) },
    "@web/core/utils/patch": {
        patch(target, extension) {
            Object.defineProperties(target, Object.getOwnPropertyDescriptors(extension));
        },
    },
    "./ko_toast": { showKoToast: (message) => toasts.push(message) },
});

{
    const qrLine = makeLine();
    qrLine.payment_method_id = { payment_method_type: "qr_code" };
    const screen = Object.create(PaymentScreen.prototype);
    Object.assign(screen, { selectedPaymentLine: qrLine, paymentLines: [qrLine] });
    assert.equal(screen.koTerminalLine, null, "a built-in QR line is not a payment terminal");
}

{
    const line = makeLine();
    let navigations = 0;
    const screen = Object.create(PaymentScreen.prototype);
    Object.assign(screen, {
        koState: { requesting: false },
        selectedPaymentLine: line,
        paymentLines: [line],
        currentOrder: { uuid: "order-1" },
        pos: {
            paymentTerminalInProgress: true,
            navigate() {
                navigations += 1;
            },
        },
        async sendPaymentCancel(paymentLine) {
            paymentLine.setPaymentStatus("waitingCancel");
            paymentLine.setPaymentStatus("retry");
            this.pos.paymentTerminalInProgress = false;
        },
    });

    screen.koBackToSell();
    assert.equal(navigations, 0, "back must not hide an active terminal request");

    await screen.koCancelTerminalPayment();
    assert.equal(line.getPaymentStatus(), "retry");
    assert.equal(screen.pos.paymentTerminalInProgress, false);

    screen.koBackToSell();
    assert.equal(navigations, 1, "back must work after cancellation reaches retry");
}

{
    const sourceMethod = {
        id: 5,
        name: "บัตรเครดิต",
        use_payment_terminal: "beam_bolt",
        payment_method_type: "terminal",
        beam_payment_method_type: "CARD",
        payment_terminal: { fastPayments: false },
    };
    const sourcePayment = {
        id: 101,
        uuid: "source-payment-ui",
        amount: 100,
        transaction_id: "ch_source_ui",
        payment_date: new Date(),
        payment_method_id: sourceMethod,
    };
    const sourceOrder = { uuid: "source-ui", payment_ids: [sourcePayment] };
    const refundLine = makeLine(undefined);
    refundLine.amount = -100;
    refundLine.payment_method_id = sourceMethod;
    refundLine.payment_status = null;
    const screen = Object.create(PaymentScreen.prototype);
    let requests = 0;
    Object.assign(screen, {
        isRefundOrder: true,
        koState: {
            requesting: false,
            selectedMethodType: "card",
            cashInput: "",
            refundConfirmed: false,
            manualReference: "",
        },
        payment_methods_from_config: [sourceMethod],
        paymentLines: [],
        selectedPaymentLine: null,
        currentOrder: {
            isRefund: true,
            getOrderlines: () => [{ refunded_orderline_id: { order_id: sourceOrder } }],
        },
        deletePaymentLine() {},
        async addNewPaymentLine() {
            this.paymentLines.push(refundLine);
            this.selectedPaymentLine = refundLine;
            return true;
        },
        async sendPaymentRequest() {
            requests += 1;
        },
    });

    await screen.koSelectMethod("card-5");
    assert.equal(requests, 0, "selecting a refund method must not create a negative Bolt Intent");
    assert.equal(screen.selectedPaymentLine, refundLine);
}

{
    // Odoo marks QR payment lines as `pending` even on refunds. A manual
    // external return must therefore compare the signed amounts directly,
    // otherwise `order.isPaid()` keeps the save button disabled forever.
    const sourceMethod = {
        id: 6,
        name: "Beam PromptPay",
        use_payment_terminal: "beam_bolt",
        payment_method_type: "qr_code",
        beam_payment_method_type: "QR_PROMPT_PAY",
    };
    const sourcePayment = {
        id: 102,
        uuid: "source-payment-manual",
        amount: 80,
        transaction_id: "ch_promptpay",
        payment_date: new Date(),
        payment_method_id: sourceMethod,
    };
    const sourceOrder = { uuid: "source-manual", payment_ids: [sourcePayment] };
    const refundLine = makeLine("pending");
    refundLine.amount = -80;
    refundLine.payment_method_id = sourceMethod;
    refundLine.transaction_id = "";
    refundLine.payment_ref_no = "";
    refundLine.setReceiptInfo = (value) => {
        refundLine.receipt = value;
    };
    const refundOrder = {
        uuid: "refund-manual",
        state: "draft",
        finalized: false,
        isRefund: true,
        totalDue: -80,
        isEmpty: () => false,
        isPaid: () => false,
        isRefundInProcess() {
            return this.isRefund && [refundLine].some(
                (line) =>
                    line.payment_method_id.payment_terminal &&
                    line.payment_status !== "done"
            );
        },
        getOrderlines: () => [{ refunded_orderline_id: { order_id: sourceOrder } }],
    };
    let validations = 0;
    const screen = Object.create(PaymentScreen.prototype);
    Object.assign(screen, {
        isRefundOrder: true,
        koState: {
            requesting: false,
            selectedMethodType: "promptpay",
            cashInput: "",
            refundConfirmed: true,
            manualReference: "TXN-1234",
            refundStatus: "",
        },
        paymentLines: [refundLine],
        selectedPaymentLine: refundLine,
        currentOrder: refundOrder,
        pos: {
            currency: { id: 1, isZero: (value) => Math.abs(value) < 0.001 },
            koRefundIntent: null,
        },
        async validateOrder() {
            assert.equal(
                refundOrder.isRefundInProcess(),
                false,
                "confirmed external refund must pass Odoo's refund-in-process guard"
            );
            assert.equal(refundLine.isDone(), true);
            refundOrder.state = "paid";
            validations += 1;
        },
    });

    assert.equal(screen.koRefundRoute, "manual");
    assert.equal(screen.currentOrder.isPaid(), false, "control: Odoo ignores pending amount");
    assert.equal(screen.koRefundPaymentAmountReady, true);
    assert.equal(screen.koCanValidate, true, "complete external refund must enable save");
    assert.match(screen.koRefundActionHint, /พร้อมบันทึก/);

    await screen.koValidatePayment();
    assert.equal(validations, 1);
    assert.equal(refundLine.getPaymentStatus(), "done");
    assert.equal(refundLine.transaction_id, "manual-refund:TXN-1234");

    screen.koState.manualReference = "123";
    assert.equal(screen.koCanValidate, false);
    assert.match(screen.koRefundActionHint, /อย่างน้อย 4 ตัว/);
}

// ---------------------------------------------------------------------------
// Beam QR: เฝ้า charge หลังยกเลิก + ยืนยันโอน Manual
// ---------------------------------------------------------------------------
const qrPath = fileURLToPath(
    new URL("../static/src/app/payment_beam_qr.js", import.meta.url)
);
const qrDialogs = [];
const beamQr = await loadModule(qrPath, {
    "@web/core/l10n/translation": { _t: translate },
    "@point_of_sale/app/utils/payment/payment_interface": { PaymentInterface },
    "@web/core/confirmation_dialog/confirmation_dialog": { AlertDialog: class {} },
    "@point_of_sale/app/services/pos_store": { register_payment_method() {} },
});

function makeQrLine(chargeId = "ch_watch_1") {
    const line = makeLine();
    line.amount = 80;
    line.transaction_id = chargeId;
    line.uiState = {
        beam_qr_charge_id: chargeId,
        beam_qr_idempotency_key: "idem-1",
        beam_qr_expiry_ms: Date.now() + 120000,
    };
    return line;
}

function makeQrTerminal(line, beamResponses) {
    const pos = {
        env: {
            services: {
                dialog: { add: (_cls, props) => qrDialogs.push(props.body) },
            },
            utils: { formatCurrency: (value) => `฿${value}` },
        },
        getOrder: () => ({ uuid: "order-qr", payment_ids: [line] }),
        getPendingPaymentLine: () => line,
    };
    const terminal = new beamQr.PaymentBeamQr(pos, { id: 12, name: "QR Promptpay" });
    terminal.calls = [];
    terminal._callBeam = async (method, data) => {
        terminal.calls.push([method, data]);
        const responder = beamResponses[method];
        return responder ? responder(data) : {};
    };
    return terminal;
}

{
    // ยกเลิกแล้วต้อง (1) ประทับ mark_cancelled (2) เฝ้าใบเก่าต่อ (3) เก็บ charge id
    const line = makeQrLine();
    const terminal = makeQrTerminal(line, {
        beam_qr_get_charge: () => ({ status: "PENDING" }),
        beam_qr_mark_cancelled: () => ({ ok: true }),
    });
    assert.equal(
        await terminal.sendPaymentCancel(terminal.pos.getOrder(), line.uuid),
        true
    );
    const methods = terminal.calls.map(([method]) => method);
    assert.ok(methods.includes("beam_qr_mark_cancelled"), "cancel must stamp the ledger");
    assert.equal(line.uiState.beam_qr_last_charge_id, "ch_watch_1");
    assert.equal(terminal.cancelWatchers.size, 1, "a watcher must be scheduled");
    terminal.close();
    assert.equal(terminal.cancelWatchers.size, 0, "close must clear watchers");
}

{
    // ลูกค้าโอนเข้า QR ที่ยกเลิกไปแล้ว → ธง paid_after_cancel + แจ้งเตือนดัง ๆ
    const line = makeQrLine("ch_watch_2");
    const terminal = makeQrTerminal(line, {
        beam_qr_get_charge: () => ({ status: "SUCCEEDED" }),
    });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
    try {
        terminal._watchCancelledCharge("ch_watch_2", line);
        await new Promise((resolve) => realSetTimeout(resolve, 25));
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }
    assert.equal(line.uiState.beam_qr_paid_after_cancel, "ch_watch_2");
    assert.equal(terminal.paidAfterCancel?.chargeId, "ch_watch_2");
    assert.ok(
        qrDialogs.some((body) => body.includes("ch_watch_2")),
        "staff must be alerted with the charge id"
    );
}

{
    // Manual confirm: Beam ยืนยันเองได้ → ปิดด้วย charge id จริง ไม่ใช่ Manual
    const line = makeQrLine("ch_manual_1");
    const terminal = makeQrTerminal(line, {
        beam_qr_manual_confirm: () => ({ status: "SUCCEEDED", charge_id: "ch_manual_1" }),
    });
    assert.equal(
        await terminal.manualConfirm({ uuid: "order-qr" }, line, "REF9999"),
        true
    );
    assert.equal(line.transaction_id, "ch_manual_1");
    assert.equal(line.getPaymentStatus(), "done");
}

{
    // Manual confirm: Beam ตอบไม่ได้ → บันทึกเป็น manual-qr:<ref>
    const line = makeQrLine("ch_manual_2");
    const terminal = makeQrTerminal(line, {
        beam_qr_manual_confirm: () => ({ ok: true, manual_ref: "REF9999" }),
    });
    assert.equal(
        await terminal.manualConfirm({ uuid: "order-qr" }, line, "REF9999"),
        true
    );
    assert.equal(line.transaction_id, "manual-qr:REF9999");
    assert.equal(line.payment_ref_no, "REF9999");
    assert.equal(line.getPaymentStatus(), "done");
    assert.equal(terminal.calls[0][1].charge_id, "ch_manual_2");
}

{
    // Manual confirm: เซิร์ฟเวอร์ปฏิเสธ (เช่น charge จบเป็น EXPIRED) → ไม่ปิดบิล
    const line = makeQrLine("ch_manual_3");
    const terminal = makeQrTerminal(line, {
        beam_qr_manual_confirm: () => ({ error: "Beam ระบุว่ารายการจบด้วยสถานะ EXPIRED" }),
    });
    assert.equal(
        await terminal.manualConfirm({ uuid: "order-qr" }, line, "REF9999"),
        false
    );
    assert.notEqual(line.getPaymentStatus(), "done");
}

console.log("Payment terminal lifecycle tests passed");
