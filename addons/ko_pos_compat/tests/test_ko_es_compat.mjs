// เทียบพฤติกรรมของ polyfill กับ built-in จริงทีละตัว
// รัน: node addons/ko_pos_compat/tests/test_ko_es_compat.mjs
//
// วิธีทดสอบ: รันชุดเคสเดียวกันสองรอบ — รอบแรกด้วย built-in จริงของ Node
// รอบสองหลังลบ built-in ทิ้งแล้วโหลด polyfill เข้ามาแทน ผลลัพธ์ต้องเท่ากันเป๊ะ
// ถ้า polyfill เพี้ยนจาก spec แม้นิดเดียว การเทียบนี้จะจับได้
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const polyfillPath = path.join(here, "..", "static", "lib", "ko_es_compat.js");
const source = fs.readFileSync(polyfillPath, "utf8");

// built-in ทุกตัวที่ไฟล์นี้อ้างว่าเติมให้
const TARGETS = [
    [Array.prototype, "findLast"],
    [Array.prototype, "findLastIndex"],
    [Array.prototype, "toSorted"],
    [Array.prototype, "toReversed"],
    [Array.prototype, "toSpliced"],
    [Array.prototype, "with"],
    [Object, "groupBy"],
    [Map, "groupBy"],
    [Promise, "withResolvers"],
    [URL, "canParse"],
    [URL, "parse"],
    [AbortSignal, "timeout"],
    [AbortSignal, "any"],
    [Set.prototype, "union"],
    [Set.prototype, "intersection"],
    [Set.prototype, "difference"],
    [Set.prototype, "symmetricDifference"],
    [Set.prototype, "isSubsetOf"],
    [Set.prototype, "isSupersetOf"],
    [Set.prototype, "isDisjointFrom"],
];

// เคสแบบ synchronous — คืนค่าที่เทียบด้วย deepStrictEqual ได้
const CASES = {
    findLast: () => [3, 1, 4, 1, 5].findLast((x) => x < 4),
    findLast_none: () => [9, 9].findLast((x) => x < 4),
    findLastIndex: () => [3, 1, 4, 1, 5].findLastIndex((x) => x < 4),
    findLastIndex_none: () => [9, 9].findLastIndex((x) => x < 4),

    toSorted_default: () => [10, 9, 1].toSorted(),
    toSorted_cmp: () => [10, 9, 1].toSorted((a, b) => a - b),
    toSorted_nomutate: () => {
        const original = [3, 1, 2];
        const sorted = original.toSorted((a, b) => a - b);
        return [original, sorted, original === sorted];
    },
    toReversed: () => [1, 2, 3].toReversed(),
    toSpliced: () => [1, 2, 3, 4].toSpliced(1, 2, "a", "b", "c"),
    with_positive: () => [1, 2, 3].with(1, "x"),
    with_negative: () => [1, 2, 3].with(-1, "x"),
    with_out_of_range: () => {
        try {
            [1, 2, 3].with(9, "x");
            return "no throw";
        } catch (error) {
            return `${error.constructor.name}`;
        }
    },

    objectGroupBy: () => Object.groupBy([1, 2, 3, 4, 5], (n) => (n % 2 ? "odd" : "even")),
    objectGroupBy_proto: () => Object.getPrototypeOf(Object.groupBy([1], () => "a")),
    objectGroupBy_index: () => Object.groupBy(["a", "b", "c"], (_v, i) => (i < 2 ? "head" : "tail")),
    objectGroupBy_numericKey: () => Object.groupBy([1.5, 2.5], (n) => Math.floor(n)),

    mapGroupBy: () => Map.groupBy([1, 2, 3, 4], (n) => n % 2 === 0),
    mapGroupBy_objectKeys: () => {
        const key = { id: 1 };
        return Map.groupBy([1, 2], () => key);
    },
    mapGroupBy_negativeZero: () => [...Map.groupBy([1], () => -0).keys()].map((k) => Object.is(k, 0)),

    urlCanParse_ok: () => URL.canParse("https://kodoo.viakuma.com/web"),
    urlCanParse_bad: () => URL.canParse("/web"),
    urlCanParse_withBase: () => URL.canParse("/web", "https://kodoo.viakuma.com"),
    urlParse_ok: () => URL.parse("https://kodoo.viakuma.com/web")?.pathname,
    urlParse_bad: () => URL.parse("not a url"),
    urlParse_withBase: () => URL.parse("/kds", "https://kodoo.viakuma.com")?.href,

    setUnion: () => new Set([1, 2]).union(new Set([2, 3])),
    setIntersection: () => new Set([1, 2, 3]).intersection(new Set([2, 3, 4])),
    setDifference: () => new Set([1, 2, 3]).difference(new Set([2])),
    setSymmetricDifference: () => new Set([1, 2]).symmetricDifference(new Set([2, 3])),
    setIsSubsetOf_true: () => new Set([1]).isSubsetOf(new Set([1, 2])),
    setIsSubsetOf_false: () => new Set([1, 9]).isSubsetOf(new Set([1, 2])),
    setIsSupersetOf_true: () => new Set([1, 2]).isSupersetOf(new Set([1])),
    setIsSupersetOf_false: () => new Set([1]).isSupersetOf(new Set([1, 2])),
    setIsDisjointFrom_true: () => new Set([1]).isDisjointFrom(new Set([2])),
    setIsDisjointFrom_false: () => new Set([1]).isDisjointFrom(new Set([1])),
    setOps_nomutate: () => {
        const base = new Set([1, 2]);
        base.union(new Set([3]));
        base.symmetricDifference(new Set([2]));
        return base;
    },
};

// เคสแบบ asynchronous
const ASYNC_CASES = {
    withResolvers_resolve: async () => {
        const { promise, resolve } = Promise.withResolvers();
        resolve("ok");
        return await promise;
    },
    withResolvers_reject: async () => {
        const { promise, reject } = Promise.withResolvers();
        reject(new Error("boom"));
        return await promise.then(() => "resolved", (error) => `rejected:${error.message}`);
    },
    abortTimeout: async () => {
        const signal = AbortSignal.timeout(5);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return [signal.aborted, signal.reason?.name];
    },
    abortAny_alreadyAborted: async () => {
        const controller = new AbortController();
        controller.abort(new Error("early"));
        const signal = AbortSignal.any([controller.signal]);
        return [signal.aborted, signal.reason?.message];
    },
    abortAny_laterAbort: async () => {
        const first = new AbortController();
        const second = new AbortController();
        const signal = AbortSignal.any([first.signal, second.signal]);
        const before = signal.aborted;
        second.abort(new Error("late"));
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [before, signal.aborted, signal.reason?.message];
    },
    abortAny_neverAborts: async () => {
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return signal.aborted;
    },
};

async function runAll(label) {
    const results = {};
    for (const [name, fn] of Object.entries(CASES)) {
        results[name] = fn();
    }
    for (const [name, fn] of Object.entries(ASYNC_CASES)) {
        results[name] = await fn();
    }
    console.log(`  เก็บผลรอบ "${label}" แล้ว ${Object.keys(results).length} เคส`);
    return results;
}

console.log("รอบที่ 1 — ใช้ built-in จริงของ Node");
const nativeResults = await runAll("native");

// ตัดทุก built-in ทิ้ง เพื่อจำลองเบราว์เซอร์เก่า
const saved = TARGETS.map(([owner, key]) => [owner, key, Object.getOwnPropertyDescriptor(owner, key)]);
for (const [owner, key, descriptor] of saved) {
    assert.ok(descriptor, `Node นี้ไม่มี ${key} ให้เทียบ — อัปเดต Node ก่อน`);
    delete owner[key];
    assert.equal(key in owner, false, `ลบ ${key} ไม่ออก`);
}

let polyfilledResults;
try {
    vm.runInThisContext(source, { filename: polyfillPath });

    // ต้องเติมกลับมาครบทุกตัว
    for (const [owner, key] of TARGETS) {
        assert.equal(typeof owner[key], "function", `polyfill ไม่ได้เติม ${key}`);
    }
    console.log(`รอบที่ 2 — ใช้ polyfill (เติมกลับครบ ${TARGETS.length} ตัว)`);
    polyfilledResults = await runAll("polyfill");
} finally {
    for (const [owner, key, descriptor] of saved) {
        Object.defineProperty(owner, key, descriptor);
    }
}

for (const name of Object.keys(nativeResults)) {
    assert.deepStrictEqual(
        polyfilledResults[name],
        nativeResults[name],
        `เคส "${name}" ไม่ตรงกับ built-in จริง`
    );
}

// polyfill ต้องไม่ทับของเดิมเมื่อเบราว์เซอร์มี built-in อยู่แล้ว
const before = Array.prototype.toSorted;
vm.runInThisContext(source, { filename: polyfillPath });
assert.equal(Array.prototype.toSorted, before, "polyfill ทับ built-in ที่มีอยู่แล้ว");

// เมธอดที่เติมต้องเป็น non-enumerable เหมือน built-in จริง ไม่งั้น for..in พัง
delete Array.prototype.toSorted;
vm.runInThisContext(source, { filename: polyfillPath });
assert.equal(Object.keys(Array.prototype).length, 0, "polyfill ทำให้ Array.prototype มี key ที่ enumerate ได้");
Object.defineProperty(Array.prototype, "toSorted", saved.find(([, k]) => k === "toSorted")[2]);

console.log(`\nผ่านทั้งหมด — ${Object.keys(nativeResults).length} เคส x 2 รอบ + 3 การตรวจเชิงโครงสร้าง`);
