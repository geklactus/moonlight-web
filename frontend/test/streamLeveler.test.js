/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    StreamLeveler,
    step,
    isOn,
    setOn,
    dbToGain,
    powerDb,
    TARGET_DB,
    MAX_DOWN_DB,
    TICK_MS,
} from '../js/audio/streamLeveler.js';

/** Mean square of a sine at `db` dBFS RMS. */
const sinePower = (db) => Math.pow(10, db / 10);

/** Run the pure step for `secs` of a steady sound. */
function settle(db, secs, on = true, from = { power: 0, gain: 1 }) {
    let s = from;
    for (let i = 0; i < (secs * 1000) / TICK_MS; i++) s = step(s, sinePower(db), on);
    return s;
}

/** A stand-in AudioContext: one source, one analyser that "hears" `level()` dBFS. */
function fakeContext(level, state = 'running') {
    const ctx = {
        state,
        resume: vi.fn(() => {
            ctx.state = 'running';
            return Promise.resolve();
        }),
        close: vi.fn(() => {
            ctx.state = 'closed';
            return Promise.resolve();
        }),
        createMediaStreamSource: vi.fn(() => src),
        createAnalyser: vi.fn(() => meter),
    };
    const meter = {
        context: ctx,
        fftSize: 2048,
        getFloatTimeDomainData: (buf) => {
            const a = Math.sqrt(sinePower(level())); // a constant at the level's RMS
            buf.fill(a);
        },
    };
    const src = { connect: vi.fn(), disconnect: vi.fn(), context: ctx };
    return { ctx, src, meter };
}

beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('step (pure)', () => {
    it('brings a game louder than the target down to it', () => {
        const s = settle(-8, 15);
        expect(powerDb(s.power)).toBeCloseTo(-8, 1);
        expect(20 * Math.log10(s.gain)).toBeCloseTo(TARGET_DB - -8, 0);
    });

    it('never raises a quieter one: the gain stays 1', () => {
        expect(settle(-35, 15).gain).toBe(1);
    });

    it('stops at MAX_DOWN_DB down however loud', () => {
        expect(settle(0, 30).gain).toBeCloseTo(dbToGain(-MAX_DOWN_DB), 3);
    });

    it('a pause leaves the level and the gain where they were', () => {
        const loud = settle(-8, 15);
        const after = settle(-90, 10, true, loud);
        expect(after.power).toBe(loud.power);
        expect(after.gain).toBeCloseTo(loud.gain, 6);
    });

    it('moves slowly: half a second into a loud game it has not dropped all the way', () => {
        const s = settle(-8, 0.5);
        expect(s.gain).toBeGreaterThan(dbToGain(TARGET_DB - -8) + 0.1);
        expect(s.gain).toBeLessThan(1);
    });

    it('off: heads back to 1', () => {
        expect(settle(-8, 15, false, settle(-8, 15)).gain).toBeCloseTo(1, 3);
    });
});

describe('the switch', () => {
    it('is on until said otherwise, and kept', () => {
        expect(isOn()).toBe(true);
        setOn(false);
        expect(isOn()).toBe(false);
        expect(localStorage.getItem('mw_stream_level')).toBe('off');
        setOn(true);
        expect(isOn()).toBe(true);
    });
});

describe('StreamLeveler', () => {
    it('listens to the stream on the side and only turns the volume down', () => {
        let db = -8;
        const f = fakeContext(() => db);
        const onGain = vi.fn();
        const lv = new StreamLeveler({ onGain, makeContext: () => f.ctx });
        lv.attachStream(/** @type {any} */ ({}));
        // The source feeds the analyser and nothing else: no path to the speakers.
        expect(f.src.connect).toHaveBeenCalledTimes(1);
        expect(f.src.connect).toHaveBeenCalledWith(f.meter);
        vi.advanceTimersByTime(15000);
        expect(onGain).toHaveBeenCalled();
        expect(20 * Math.log10(lv.gain())).toBeCloseTo(TARGET_DB - db, 0);
        lv.close();
        expect(f.ctx.close).toHaveBeenCalled();
    });

    it('switched off: gain 1 at once, and the view is told', () => {
        const f = fakeContext(() => -8);
        const onGain = vi.fn();
        const lv = new StreamLeveler({ onGain, makeContext: () => f.ctx });
        lv.attachStream(/** @type {any} */ ({}));
        vi.advanceTimersByTime(15000);
        setOn(false);
        onGain.mockClear();
        lv.changed();
        expect(lv.gain()).toBe(1);
        expect(onGain).toHaveBeenCalledTimes(1);
        lv.close();
    });

    it('a context the browser keeps suspended changes nothing, and is resumed at a gesture', () => {
        const f = fakeContext(() => -8, 'suspended');
        const lv = new StreamLeveler({ onGain: () => {}, makeContext: () => f.ctx });
        lv.attachStream(/** @type {any} */ ({}));
        vi.advanceTimersByTime(5000);
        expect(lv.gain()).toBe(1);
        window.dispatchEvent(new Event('pointerdown'));
        expect(f.ctx.resume).toHaveBeenCalled();
        lv.close();
    });

    it('no Web Audio at all: gain 1, no throw', () => {
        const lv = new StreamLeveler({
            onGain: () => {},
            makeContext: () => {
                throw new Error('no AudioContext');
            },
        });
        expect(() => lv.attachStream(/** @type {any} */ ({}))).not.toThrow();
        vi.advanceTimersByTime(5000);
        expect(lv.gain()).toBe(1);
    });

    it('the WSS pipeline: listens to its node in its own context, which it leaves open', () => {
        const f = fakeContext(() => -8);
        const lv = new StreamLeveler({ onGain: () => {} });
        lv.attachNode(/** @type {any} */ (f.src));
        vi.advanceTimersByTime(15000);
        expect(lv.gain()).toBeLessThan(1);
        lv.close();
        expect(f.src.disconnect).toHaveBeenCalledWith(f.meter);
        expect(f.ctx.close).not.toHaveBeenCalled();
    });
});
