/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

/**
 * CongestionMonitor — one loss counts once, PLIs count only with real loss,
 * and a slow decoder is never taken for a congested link.
 */
import { describe, it, expect } from 'vitest';
import {
    CongestionMonitor,
    EncoderRate,
    RATE_MIN_FRAMES,
    RATE_WINDOW_MS,
    EPISODE_MS,
    COOLDOWN_MS,
    WINDOW_MS,
    isDeviceReason,
    lossEvidence,
} from '../js/stream/CongestionMonitor.js';

const LOSSY = { lossFraction: 0.02, frozenFraction: 0 };
const CLEAN = { lossFraction: 0, frozenFraction: 0 };

describe('CongestionMonitor', () => {
    it('counts one lost frame once, however many signals it raises', () => {
        // The old monitor's ladder step for one loss: a frame gap, the
        // transport's own request, reference-invalid retries, a drop batch.
        const m = new CongestionMonitor();
        const r = [
            m.record('idr', 1000),
            m.record('idr', 1050),
            m.record('drops', 1200),
            m.record('idr', 2050),
            m.record('idr', 2900),
        ];
        expect(r.filter((x) => x.counted)).toHaveLength(1);
        expect(r.some((x) => x.congested)).toBe(false);
    });

    it('opens a new episode once a keyframe has answered the last one', () => {
        const m = new CongestionMonitor();
        expect(m.record('idr', 1000).counted).toBe(true);
        m.keyframe();
        expect(m.record('idr', 1200).counted).toBe(true);
    });

    it('opens a new episode when no keyframe comes', () => {
        const m = new CongestionMonitor();
        m.record('idr', 1000);
        expect(m.record('idr', 1000 + EPISODE_MS - 1).counted).toBe(false);
        expect(m.record('idr', 1000 + EPISODE_MS).counted).toBe(true);
    });

    it('still detects a link that keeps losing', () => {
        const m = new CongestionMonitor();
        let fired = 0;
        for (let t = 0; t < WINDOW_MS; t += 500) {
            if (m.record('drops', t).congested) fired++;
        }
        expect(fired).toBe(1);
    });

    it('waits the cooldown between two detections', () => {
        const m = new CongestionMonitor();
        const at = [];
        for (let t = 0; t < 40000; t += 250) {
            if (m.record('drops', t).congested) at.push(t);
            m.keyframe();
        }
        expect(at.length).toBeGreaterThanOrEqual(2);
        expect(at[1] - at[0]).toBeGreaterThan(COOLDOWN_MS);
    });

    it('ignores PLIs over a poll with no loss and no frozen time', () => {
        const m = new CongestionMonitor();
        for (let t = 0; t < WINDOW_MS; t += 1000) {
            const r = m.record('pli', t, CLEAN);
            expect(r.counted).toBe(false);
            expect(r.congested).toBe(false);
        }
    });

    it('counts PLIs at the judge bars: 1 % lost or 3 % frozen', () => {
        const m = new CongestionMonitor();
        expect(m.record('pli', 0, { lossFraction: 0.009, frozenFraction: 0.02 }).counted).toBe(
            false,
        );
        expect(m.record('pli', 1000, { lossFraction: 0.01, frozenFraction: 0 }).counted).toBe(true);
        m.keyframe();
        expect(m.record('pli', 2000, { lossFraction: 0, frozenFraction: 0.03 }).counted).toBe(true);
        m.keyframe();
        expect(m.record('pli', 3000).counted).toBe(false); // no evidence, no count
    });

    it('detects sustained PLIs with real loss', () => {
        const m = new CongestionMonitor();
        let fired = false;
        for (let t = 0; t < WINDOW_MS; t += 1000) {
            if (m.record('pli', t, LOSSY).congested) fired = true;
        }
        expect(fired).toBe(true);
    });

    it('never calls a slow decoder congestion', () => {
        const m = new CongestionMonitor();
        let congested = false;
        let strained = 0;
        for (let t = 0; t < WINDOW_MS; t += 1000) {
            const r = m.record('device', t);
            if (r.congested) congested = true;
            if (r.deviceStrained) strained++;
        }
        expect(congested).toBe(false);
        expect(strained).toBe(1);
    });

    it('keeps the decoder counter apart from the link counter', () => {
        const m = new CongestionMonitor();
        m.record('device', 1000);
        expect(m.record('idr', 1100).counted).toBe(true);
    });

    it('forgets what it counted on reset', () => {
        const m = new CongestionMonitor();
        for (const t of [0, 3000, 6000]) m.record('drops', t);
        m.reset();
        expect(m.record('drops', 9000).congested).toBe(false);
    });
});

describe('isDeviceReason', () => {
    it('names the decoder falling behind, and nothing else', () => {
        expect(isDeviceReason('decode queue overflow')).toBe(true);
        expect(isDeviceReason('decode queue stalled')).toBe(true);
        expect(isDeviceReason('frame gap')).toBe(false);
        expect(isDeviceReason('decoder error')).toBe(false);
    });
});

describe('lossEvidence', () => {
    it('gives the loss and frozen shares between two reports', () => {
        const e = lossEvidence(
            { packetsLost: 10, packetsReceived: 1000, totalFreezesDuration: 0.5 },
            { packetsLost: 30, packetsReceived: 1980, totalFreezesDuration: 0.6 },
            1,
        );
        expect(e.lossFraction).toBeCloseTo(20 / 1000);
        expect(e.frozenFraction).toBeCloseTo(0.1);
    });

    it('is zero with no earlier report, no time, or counters that went back', () => {
        const cur = { packetsLost: 5, packetsReceived: 100, totalFreezesDuration: 1 };
        expect(lossEvidence(null, cur, 1)).toEqual({ lossFraction: 0, frozenFraction: 0 });
        expect(lossEvidence(cur, cur, 0)).toEqual({ lossFraction: 0, frozenFraction: 0 });
        // A reattach starts a new peer connection: its counters restart at 0.
        expect(
            lossEvidence(cur, { packetsLost: 0, packetsReceived: 50, totalFreezesDuration: 0 }, 1),
        ).toEqual({ lossFraction: 0, frozenFraction: 0 });
    });

    it('caps frozen time at the whole poll', () => {
        const e = lossEvidence({ totalFreezesDuration: 0 }, { totalFreezesDuration: 5 }, 1);
        expect(e.frozenFraction).toBe(1);
    });
});

describe('EncoderRate', () => {
    // A stream's frames, `size` bytes each at `fps`, from `from` for `ms`;
    // `stalls` are [start, length] spans in which nothing arrives.
    function feed(r, { from = 0, ms, fps = 60, size, stalls = [] }) {
        for (let t = from; t < from + ms; t += 1000 / fps) {
            if (stalls.some(([s, len]) => t >= s && t < s + len)) continue;
            r.note(size, 1, t);
        }
    }

    it('says nothing before enough frames came', () => {
        const r = new EncoderRate();
        feed(r, { ms: (RATE_MIN_FRAMES - 1) * (1000 / 60), size: 40000 });
        expect(r.kbps(1000, 60)).toBe(null);
    });

    it('reads a paused game as the few kbps it is (24/11/2026, 00:16)', () => {
        // ~40-byte frames of a still screen, a 5 kB keyframe after each of the
        // two stalls, as the Wolf seat sent them.
        const r = new EncoderRate();
        feed(r, {
            ms: 10000,
            size: 40,
            stalls: [
                [2000, 1836],
                [6000, 2590],
            ],
        });
        r.note(5016, 1, 3900);
        r.note(5016, 1, 8600);
        const kbps = r.kbps(10000, 60);
        expect(kbps).toBeGreaterThan(10);
        expect(kbps).toBeLessThan(100);
    });

    it('reads a full stream as full, even through its stalls', () => {
        // 20 Mbit/s at 60 fps: frames of ~41.7 kB. Stalls take frames away,
        // not size: the estimate stays at the encoder's rate.
        const r = new EncoderRate();
        feed(r, { ms: 10000, size: 41667, stalls: [[3000, 2500]] });
        expect(r.kbps(10000, 60)).toBeCloseTo(20000, -2);
    });

    it('catches up within seconds when a paused game resumes', () => {
        const r = new EncoderRate();
        feed(r, { ms: 15000, size: 40 });
        feed(r, { from: 15000, ms: 5000, size: 41667 });
        // Half the window at full size: well over a quarter of a 20 Mbit/s cap.
        expect(r.kbps(20000, 60)).toBeGreaterThan(20000 * 0.25);
    });

    it('forgets what left the window, and takes counts from a stats poll', () => {
        const r = new EncoderRate();
        feed(r, { ms: 5000, size: 41667 });
        feed(r, { from: 5000 + RATE_WINDOW_MS, ms: 2000, size: 40 });
        expect(r.kbps(7000 + RATE_WINDOW_MS, 60)).toBeLessThan(100);
        // Media transport: bytes and frames since the last inbound-rtp report.
        const m = new EncoderRate();
        m.note(1_000_000, 120, 2000);
        expect(m.kbps(2000, 60)).toBe(4000);
        m.note(500, 0, 2500); // no frames: nothing to divide by, ignored
        expect(m.kbps(2500, 60)).toBe(4000);
    });
});
