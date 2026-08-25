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

console.log("Payment terminal lifecycle tests passed");
