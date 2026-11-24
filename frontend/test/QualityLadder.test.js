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
 * QualityLadder — which knob a step turns, what the page allows, when a
 * session stops trying to come back up, and what a slow decoder gets.
 */
import { describe, it, expect } from 'vitest';
import {
    degradeRung,
    pagePolicy,
    flapVerdict,
    deviceRelief,
    FLAP_WINDOW_MS,
} from '../js/stream/QualityLadder.js';

const base = {
    curHeight: 1080,
    keepsSize: false,
    onMedia: false,
    transportForced: false,
    curFps: 60,
    fpsCapped: false,
    bitrateCanDrop: true,
};

describe('degradeRung', () => {
    it('drops the size first on a host whose display follows the stream', () => {
        expect(degradeRung(base)).toBe('resolution');
    });

    it('switches to the media transport once at 720p', () => {
        expect(degradeRung({ ...base, curHeight: 720 })).toBe('transport');
    });

    it('never changes a Wolf seat transport: bitrate instead', () => {
        expect(degradeRung({ ...base, curHeight: 1440, keepsSize: true })).toBe('bitrate');
    });

    it('caps a high frame rate before cutting bitrate further', () => {
        expect(degradeRung({ ...base, curHeight: 720, onMedia: true, curFps: 120 })).toBe('fps');
        expect(
            degradeRung({ ...base, curHeight: 720, onMedia: true, curFps: 120, fpsCapped: true }),
        ).toBe('bitrate');
    });

    it('restarts when every knob is at its floor', () => {
        expect(degradeRung({ ...base, curHeight: 720, onMedia: true, bitrateCanDrop: false })).toBe(
            'restart',
        );
    });
});

describe('pagePolicy', () => {
    it('is uncapped when the page says nothing', () => {
        expect(pagePolicy({}).maxDegradeSteps).toBe(Infinity);
        expect(pagePolicy(undefined).maxDegradeSteps).toBe(Infinity);
    });

    it('reads a cap the page set', () => {
        expect(pagePolicy({ mwQualityPolicy: { maxDegradeSteps: 1 } }).maxDegradeSteps).toBe(1);
        expect(pagePolicy({ mwQualityPolicy: { maxDegradeSteps: 0 } }).maxDegradeSteps).toBe(0);
    });

    it('ignores a cap that is not a whole number of steps', () => {
        for (const v of [-1, 1.5, 'x', null]) {
            expect(pagePolicy({ mwQualityPolicy: { maxDegradeSteps: v } }).maxDegradeSteps).toBe(
                Infinity,
            );
        }
    });
});

describe('flapVerdict', () => {
    it('is no flap without an upgrade, or long after one', () => {
        const s = { now: 1e6, lastUpgradeAt: 0, flaps: 0, stableMs: 75000 };
        expect(flapVerdict(s).flap).toBe(false);
        expect(flapVerdict({ ...s, lastUpgradeAt: 1e6 - FLAP_WINDOW_MS }).flap).toBe(false);
    });

    it('doubles the quiet time on the first flap, holds on the second', () => {
        const first = flapVerdict({
            now: 1e6,
            lastUpgradeAt: 1e6 - 134000,
            flaps: 0,
            stableMs: 75000,
        });
        expect(first).toEqual({ flap: true, flaps: 1, stableMs: 150000, hold: false });
        const second = flapVerdict({
            now: 2e6,
            lastUpgradeAt: 2e6 - 60000,
            flaps: 1,
            stableMs: 150000,
        });
        expect(second.hold).toBe(true);
    });

    it('caps the quiet time at 10 minutes', () => {
        expect(
            flapVerdict({ now: 1e6, lastUpgradeAt: 1e6 - 1000, flaps: 0, stableMs: 500000 })
                .stableMs,
        ).toBe(600000);
    });
});

describe('deviceRelief', () => {
    it('lowers a high frame rate first', () => {
        expect(deviceRelief({ curFps: 120, curHeight: 1440, keepsSize: false })).toEqual({
            stream_fps: 60,
        });
    });

    it('then one size down, except on a seat that keeps its size', () => {
        expect(deviceRelief({ curFps: 60, curHeight: 1440, keepsSize: false })).toEqual({
            stream_height: 1080,
        });
        expect(deviceRelief({ curFps: 60, curHeight: 1440, keepsSize: true })).toEqual({
            stream_fps: 30,
        });
    });

    it('has nothing left at 720p and 30 fps', () => {
        expect(deviceRelief({ curFps: 30, curHeight: 720, keepsSize: false })).toBe(null);
    });
});
