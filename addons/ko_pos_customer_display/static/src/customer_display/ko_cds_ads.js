import { Component, useState, useRef, useEffect, onMounted, onWillUnmount } from "@odoo/owl";

/**
 * สไลด์โชว์โฆษณาบนจอลูกค้า — เล่นทั้งภาพนิ่งและวิดีโอวนตาม playlist
 *
 * กติกา:
 * - ภาพนิ่ง: แสดงตามวินาทีของภาพนั้น (หรือค่ากลาง imageSeconds) แล้วไปรายการถัดไป
 * - วิดีโอ: เล่นแบบไม่มีเสียงจนจบแล้วไปต่อ; ถ้าโหลด/เล่นไม่ได้ ข้ามทันที
 *   ไม่ปล่อยให้จอค้างดำ (watchdog: metadata ไม่มาใน 25 วิ ก็ข้าม,
 *   เล่นเกินความยาวจริง +10 วิ ก็ข้าม)
 */
export class KoCdsAds extends Component {
    static template = "ko_pos_customer_display.KoCdsAds";
    static props = {
        playlist: Array,
        imageSeconds: Number,
    };

    setup() {
        this.state = useState({ idx: 0 });
        this.rootRef = useRef("root");
        this.timer = null;
        this.watchdog = null;
        onMounted(() => this.startCurrent());
        onWillUnmount(() => this.clearTimers());
        // ผูก event ของ <video> ตรง ๆ ใน effect: media event (error/ended) ไม่ bubble
        // และพิสูจน์จาก QA แล้วว่า handler ผ่าน template ไม่ยิงบน element นี้
        // muted ก็ต้องตั้งเป็น property จริงก่อนสั่ง play ไม่งั้น browser บล็อก autoplay
        useEffect(
            () => {
                const video = this.rootRef.el?.querySelector("video");
                if (!video) {
                    return;
                }
                video.muted = true;
                const advance = () => this.next();
                const onMeta = (ev) => this.onVideoMetadata(ev);
                video.addEventListener("error", advance);
                video.addEventListener("ended", advance);
                video.addEventListener("loadedmetadata", onMeta);
                if (video.error) {
                    // ไฟล์พังตั้งแต่ก่อน effect ทำงาน — ข้ามเลย ไม่รอ watchdog
                    advance();
                } else {
                    // play ถูกปฏิเสธ (เช่น autoplay policy) ไม่มี error event —
                    // ปล่อยให้ watchdog เดินหน้าต่อเอง
                    video.play().catch(() => {});
                }
                return () => {
                    video.removeEventListener("error", advance);
                    video.removeEventListener("ended", advance);
                    video.removeEventListener("loadedmetadata", onMeta);
                };
            },
            () => [this.state.idx]
        );
    }

    get current() {
        const list = this.props.playlist;
        return list.length ? list[this.state.idx % list.length] : null;
    }

    clearTimers() {
        clearTimeout(this.timer);
        clearTimeout(this.watchdog);
        this.timer = null;
        this.watchdog = null;
    }

    startCurrent() {
        this.clearTimers();
        const item = this.current;
        if (!item) {
            return;
        }
        if (item.type === "image") {
            const seconds = item.seconds || this.props.imageSeconds || 8;
            this.timer = setTimeout(() => this.next(), seconds * 1000);
        } else {
            this.watchdog = setTimeout(() => this.next(), 25000);
        }
        this.preloadNext();
    }

    onVideoMetadata(ev) {
        clearTimeout(this.watchdog);
        const duration = ev.target.duration;
        const capMs =
            Number.isFinite(duration) && duration > 0 ? (duration + 10) * 1000 : 10 * 60 * 1000;
        this.watchdog = setTimeout(() => this.next(), capMs);
    }

    next() {
        const list = this.props.playlist;
        if (!list.length) {
            return;
        }
        this.state.idx = (this.state.idx + 1) % list.length;
        this.startCurrent();
    }

    preloadNext() {
        const list = this.props.playlist;
        if (list.length < 2) {
            return;
        }
        const nextItem = list[(this.state.idx + 1) % list.length];
        if (nextItem?.type === "image") {
            new Image().src = nextItem.url;
        }
    }
}
