// Unit tests สำหรับ patch ของ PaymentScreen (ko_payment_screen.js)
// รัน: node --experimental-vm-modules addons/ko_pos_ui/tests/test_ko_payment_screen.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

async function loadModule(modulePath, stubs) {
    const source = fs.readFileSync(modulePath, "utf8");
    const module = new vm.SourceTextModule(source, { identifier: modulePath });
    await module.link(async (specifier) => {
        if (!(specifier in stubs)) {
            throw new Error(`Missing test stub for ${specifier}`);
        }
        return synthetic(stubs[specifier]);
    });
    await module.evaluate();
    return module.namespace;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const screenPath = path.join(here, "..", "static", "src", "app", "ko_payment_screen.js");

let patched = null;
const toasts = [];

await loadModule(screenPath, {
    "@odoo/owl": {
        onMounted: () => {},
        useState: (value) => value,
    },
    "@point_of_sale/app/screens/payment_screen/payment_screen": {
        PaymentScreen: class PaymentScreen {},
    },
    "@web/core/currency": {
        formatCurrency: (amount) => `฿${amount}`,
    },
    "@web/core/utils/patch": {
        patch: (proto, extension) => {
            patched = extension;
            return extension;
        },
    },
    "./ko_toast": {
        showKoToast: (message) => toasts.push(message),
    },
});

assert.ok(patched, "patch() must be called with the PaymentScreen extension");

function getter(name, ctx) {
    const descriptor = Object.getOwnPropertyDescriptor(patched, name);
    assert.ok(descriptor?.get, `${name} must be a getter on the patch`);
    return descriptor.get.call(ctx);
}

// --- koQrPaymentData: จอพนักงานต้องเห็น QR เดียวกับจอลูกค้า ---

// ไม่มี payment line → ไม่มี QR
assert.equal(getter("koQrPaymentData", { selectedPaymentLine: null, paymentLines: [] }), null);

// line ที่เลือกอยู่มี QR → ใช้ของ line นั้น
const qr = { qrCode: "data:image/png;base64,AAA", amount: "฿80.00" };
assert.equal(
    getter("koQrPaymentData", {
        selectedPaymentLine: { qrPaymentData: qr },
        paymentLines: [],
    }),
    qr
);

// line ที่เลือกไม่มี QR แต่ line อื่นมี → fallback ไปหา line ที่มี
assert.equal(
    getter("koQrPaymentData", {
        selectedPaymentLine: { qrPaymentData: null },
        paymentLines: [{ qrPaymentData: null }, { qrPaymentData: qr }],
    }),
    qr
);

// qrPaymentData ที่ไม่มีภาพ → ไม่นับว่ามี QR
assert.equal(
    getter("koQrPaymentData", {
        selectedPaymentLine: { qrPaymentData: {} },
        paymentLines: [],
    }),
    null
);

// --- koCancelTerminalPayment: ต้องกดยกเลิกได้ระหว่างรอลูกค้าสแกน ---

function cancelContext({ requesting, cancelling, canCancel = true, statusAfter = "retry" }) {
    const cancelCalls = [];
    const line = { getPaymentStatus: () => statusAfter };
    return {
        cancelCalls,
        ctx: {
            koState: { requesting, cancelling },
            koTerminalLine: line,
            koCanCancelTerminal: canCancel,
            sendPaymentCancel: async (target) => {
                cancelCalls.push(target);
            },
        },
    };
}

// regression: sendPaymentRequest ค้าง await ระหว่างรอสแกน ทำให้ requesting=true —
// เดิมปุ่มถูก gate ด้วย requesting จึงกดยกเลิกไม่ได้เลย
{
    const { ctx, cancelCalls } = cancelContext({ requesting: true, cancelling: false });
    await patched.koCancelTerminalPayment.call(ctx);
    assert.equal(cancelCalls.length, 1, "cancel must go through while a payment request is awaited");
    assert.equal(ctx.koState.cancelling, false, "cancelling flag must reset afterwards");
}

// กันกดซ้ำระหว่างที่คำขอยกเลิกเดิมยังไม่จบ
{
    const { ctx, cancelCalls } = cancelContext({ requesting: false, cancelling: true });
    await patched.koCancelTerminalPayment.call(ctx);
    assert.equal(cancelCalls.length, 0, "a second tap while cancelling must be ignored");
}

// สถานะที่ยกเลิกไม่ได้ (เช่น done) → ไม่ยิง cancel
{
    const { ctx, cancelCalls } = cancelContext({
        requesting: false,
        cancelling: false,
        canCancel: false,
    });
    await patched.koCancelTerminalPayment.call(ctx);
    assert.equal(cancelCalls.length, 0, "cancel must respect koCanCancelTerminal");
}

console.log("KO payment screen patch tests passed");
