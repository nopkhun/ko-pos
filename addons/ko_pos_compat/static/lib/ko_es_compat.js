/* KO POS — back-fill ของ JavaScript built-in สำหรับเบราว์เซอร์เก่า
 * ============================================================================
 * ทำไมต้องมีไฟล์นี้
 * ----------------
 * Odoo 19 core เรียก built-in ใหม่ ๆ ที่ Chromium/WebView เก่าไม่มี พอเรียกแล้ว
 * ทั้งหน้าจะตายด้วย `TypeError: ... is not a function` เช่นเครื่อง Android 7 ซึ่ง
 * Google หยุดส่ง Chrome/WebView ให้ที่เวอร์ชัน 119 (Chrome 120 ตัด Android 7 ทิ้ง)
 *
 * ขอบเขตที่ไฟล์นี้ครอบคลุม: Chrome 95 – 126
 * ------------------------------------------
 * ขอบล่างไม่ได้เลือกเอง — bundle ของ Odoo 19 ทั้งสามก้อน (web.assets_web,
 * point_of_sale.assets_prod, web.assets_frontend) ต้องใช้ **ES2022 syntax**
 * (class fields / static blocks) ตรวจด้วย acorn แล้ว ถ้าเอนจินแปลง syntax นี้ไม่ได้
 * bundle จะพังตั้งแต่ parse เป็น SyntaxError ซึ่ง polyfill ช่วยอะไรไม่ได้เลย
 * ES2022 = Chrome 94+ / Safari 16.4+ ฉะนั้นอะไรที่มาก่อน Chrome 94 (`Array#at` 92,
 * `String#replaceAll` 85, `Object.hasOwn` 93) การันตีว่ามีอยู่แล้ว ไม่ต้อง back-fill
 *
 * ทุกตัวด้านล่างสำรวจมาจาก bundle จริงบน production (2026-09-05) ไม่ได้เดา
 * ตัวเลขในวงเล็บคือเวอร์ชัน Chrome ที่ built-in นั้นออก
 *
 * หมายเหตุความปลอดภัย: ไฟล์นี้รันเป็นสคริปต์ธรรมดา (ไม่ใช่ Odoo module) และรัน
 * ก่อนโค้ดอื่นทั้งหมด ถ้ามันพัง = ทั้งระบบพังกับทุกคน จึงห่อ try/catch ไว้ทั้งก้อน
 * และทุก def() เป็น no-op บนเบราว์เซอร์ที่มี built-in นั้นอยู่แล้ว
 */
(function () {
    "use strict";

    try {
        /** ติดตั้งเมธอดเฉพาะเมื่อยังไม่มี — non-enumerable เหมือน built-in จริง */
        const def = (target, name, value) => {
            if (!target || name in target) {
                return;
            }
            Object.defineProperty(target, name, {
                value,
                writable: true,
                enumerable: false,
                configurable: true,
            });
        };

        /** ToIntegerOrInfinity แบบย่อ ใช้กับ index ของ Array */
        const toIndex = (value) => Math.trunc(Number(value)) || 0;

        const ArrayP = Array.prototype;

        // ── Chrome 97 ── Array#findLast / findLastIndex
        // ใช้ที่: web/core (13 จุด), POS (3 จุด)
        def(ArrayP, "findLast", function findLast(predicate, thisArg) {
            if (typeof predicate !== "function") {
                throw new TypeError(`${predicate} is not a function`);
            }
            const self = Object(this);
            for (let i = (self.length >>> 0) - 1; i >= 0; i--) {
                if (predicate.call(thisArg, self[i], i, self)) {
                    return self[i];
                }
            }
            return undefined;
        });

        def(ArrayP, "findLastIndex", function findLastIndex(predicate, thisArg) {
            if (typeof predicate !== "function") {
                throw new TypeError(`${predicate} is not a function`);
            }
            const self = Object(this);
            for (let i = (self.length >>> 0) - 1; i >= 0; i--) {
                if (predicate.call(thisArg, self[i], i, self)) {
                    return i;
                }
            }
            return -1;
        });

        // ── Chrome 110 ── Array แบบไม่แก้ของเดิม (change-by-copy)
        // ใช้ที่: เครื่องคิดภาษี flatten_taxes_and_sort_them → **กระทบยอดเงินใน POS**
        def(ArrayP, "toSorted", function toSorted(compareFn) {
            if (compareFn !== undefined && typeof compareFn !== "function") {
                throw new TypeError("The comparison function must be either a function or undefined");
            }
            return ArrayP.slice.call(this).sort(compareFn);
        });

        def(ArrayP, "toReversed", function toReversed() {
            return ArrayP.slice.call(this).reverse();
        });

        def(ArrayP, "toSpliced", function toSpliced() {
            const copy = ArrayP.slice.call(this);
            ArrayP.splice.apply(copy, arguments);
            return copy;
        });

        def(ArrayP, "with", function (index, value) {
            const copy = ArrayP.slice.call(this);
            const relative = toIndex(index);
            const actual = relative < 0 ? copy.length + relative : relative;
            if (actual < 0 || actual >= copy.length) {
                throw new RangeError(`Invalid index : ${index}`);
            }
            copy[actual] = value;
            return copy;
        });

        // ── Chrome 117 ── Object.groupBy / Map.groupBy
        // ใช้ที่: UseComposerActions.partition (chatter — อยู่แทบทุกหน้า backend)
        //        และ analytic_search_model
        // นี่คือตัวที่ทำให้เจ้าของเจอ OwlError เมื่อ 2026-09-05
        def(Object, "groupBy", function groupBy(items, callbackFn) {
            if (typeof callbackFn !== "function") {
                throw new TypeError(`${callbackFn} is not a function`);
            }
            // ของจริงคืน object ที่ prototype เป็น null — โค้ดที่เรียกพึ่งพาข้อนี้ได้
            const result = Object.create(null);
            let index = 0;
            for (const item of items) {
                let key = callbackFn(item, index++);
                if (typeof key !== "symbol") {
                    key = String(key);
                }
                if (!(key in result)) {
                    result[key] = [];
                }
                result[key].push(item);
            }
            return result;
        });

        def(Map, "groupBy", function groupBy(items, callbackFn) {
            if (typeof callbackFn !== "function") {
                throw new TypeError(`${callbackFn} is not a function`);
            }
            // Map ใช้ SameValueZero อยู่แล้ว จึงไม่ต้องจัดการ -0 เอง
            const result = new Map();
            let index = 0;
            for (const item of items) {
                const key = callbackFn(item, index++);
                if (!result.has(key)) {
                    result.set(key, []);
                }
                result.get(key).push(item);
            }
            return result;
        });

        // ── Chrome 119 ── Promise.withResolvers
        // Odoo มี polyfill ของตัวเองใน web/static/src/polyfills/promise.js อยู่แล้ว
        // แต่ของเรารันก่อน จึงใส่ไว้ให้ครบ (ของ Odoo จะกลายเป็น no-op)
        def(Promise, "withResolvers", function withResolvers() {
            let resolve;
            let reject;
            const promise = new this((res, rej) => {
                resolve = res;
                reject = rej;
            });
            return { promise, resolve, reject };
        });

        // ── Chrome 120 / 126 ── URL.canParse / URL.parse
        // ใช้ที่: เครื่องมือแทรกลิงก์และวิดีโอของ HTML editor
        // ส่ง base เฉพาะตอนที่ผู้เรียกส่งมาจริง — บางเอนจินเก่าแปลง undefined
        // เป็นสตริง "undefined" แล้ว throw
        if (typeof URL !== "undefined") {
            const build = (url, base) => (base === undefined ? new URL(url) : new URL(url, base));

            def(URL, "canParse", function canParse(url, base) {
                try {
                    build(url, base);
                    return true;
                } catch {
                    return false;
                }
            });

            def(URL, "parse", function parse(url, base) {
                try {
                    return build(url, base);
                } catch {
                    return null;
                }
            });
        }

        // ── Chrome 103 / 116 ── AbortSignal.timeout / AbortSignal.any
        // ใช้ที่: เส้นทางคุยกับ IoT box — คือ **เครื่องพิมพ์ครัวและลิ้นชักเงิน**
        if (typeof AbortSignal !== "undefined" && typeof AbortController !== "undefined") {
            def(AbortSignal, "timeout", function timeout(milliseconds) {
                const controller = new AbortController();
                setTimeout(() => {
                    // abort(reason) เพิ่งมีใน Chrome 98 — ที่เก่ากว่านั้นจะได้
                    // AbortError ตามค่าเริ่มต้นแทน TimeoutError ซึ่งยอมรับได้
                    controller.abort(new DOMException("signal timed out", "TimeoutError"));
                }, Number(milliseconds) || 0);
                return controller.signal;
            });

            def(AbortSignal, "any", function any(signals) {
                const controller = new AbortController();
                const list = Array.from(signals);

                for (const signal of list) {
                    if (signal.aborted) {
                        controller.abort(signal.reason);
                        return controller.signal;
                    }
                }

                const onAbort = function () {
                    controller.abort(this.reason);
                    cleanup();
                };
                const cleanup = () => {
                    for (const signal of list) {
                        signal.removeEventListener("abort", onAbort);
                    }
                };

                for (const signal of list) {
                    signal.addEventListener("abort", onAbort);
                }
                controller.signal.addEventListener("abort", cleanup);
                return controller.signal;
            });
        }

        // ── Chrome 122 ── เมธอดทฤษฎีเซตของ Set
        // ใช้ที่: การไฮไลต์ช่องในมุมมองปฏิทิน (allSelectedCells.union / …)
        // spec รับ "set-like" (มี size / has / keys) — ของ Odoo ส่ง Set จริงมาเสมอ
        // แต่เรารับ iterable ธรรมดาด้วยเพื่อความทนทาน
        const SetP = Set.prototype;
        const asSetLike = (other) => {
            if (
                other &&
                typeof other.has === "function" &&
                typeof other.keys === "function" &&
                typeof other.size === "number"
            ) {
                return other;
            }
            return new Set(other);
        };

        def(SetP, "union", function union(other) {
            const target = asSetLike(other);
            const result = new Set(this);
            for (const value of target.keys()) {
                result.add(value);
            }
            return result;
        });

        def(SetP, "intersection", function intersection(other) {
            const target = asSetLike(other);
            const result = new Set();
            for (const value of this) {
                if (target.has(value)) {
                    result.add(value);
                }
            }
            return result;
        });

        def(SetP, "difference", function difference(other) {
            const target = asSetLike(other);
            const result = new Set();
            for (const value of this) {
                if (!target.has(value)) {
                    result.add(value);
                }
            }
            return result;
        });

        def(SetP, "symmetricDifference", function symmetricDifference(other) {
            const target = asSetLike(other);
            const result = new Set(this);
            for (const value of target.keys()) {
                if (this.has(value)) {
                    result.delete(value);
                } else {
                    result.add(value);
                }
            }
            return result;
        });

        def(SetP, "isSubsetOf", function isSubsetOf(other) {
            const target = asSetLike(other);
            if (this.size > target.size) {
                return false;
            }
            for (const value of this) {
                if (!target.has(value)) {
                    return false;
                }
            }
            return true;
        });

        def(SetP, "isSupersetOf", function isSupersetOf(other) {
            const target = asSetLike(other);
            if (this.size < target.size) {
                return false;
            }
            for (const value of target.keys()) {
                if (!this.has(value)) {
                    return false;
                }
            }
            return true;
        });

        def(SetP, "isDisjointFrom", function isDisjointFrom(other) {
            const target = asSetLike(other);
            for (const value of this) {
                if (target.has(value)) {
                    return false;
                }
            }
            return true;
        });
    } catch (error) {
        // อย่าให้ไฟล์นี้เป็นสาเหตุที่ทำให้ระบบล่ม — บนเบราว์เซอร์ใหม่มันเป็น no-op ทั้งก้อนอยู่แล้ว
        console.warn("[ko_pos_compat] ติดตั้ง polyfill ไม่สำเร็จ:", error);
    }
})();
