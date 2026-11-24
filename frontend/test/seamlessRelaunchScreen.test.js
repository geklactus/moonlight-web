/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoonlightApp } from '../js/app.js';

/**
 * The view a seamless relaunch swaps in follows this screen like the first one.
 *
 * N95 bench, 16/10/2026, "Match my screen": the client's screen changed, the
 * stream was relaunched seamlessly at the new size — and a second change
 * relaunched nothing. The standby view promoted on its first frame never got
 * onClientScreenChanged, the one callback a first launch wires that the swap
 * did not.
 */

const LIVE_CALLBACKS = [
    'onQuit',
    'onConnectionFailed',
    'onCongestion',
    'onCongestionSignal',
    'onDeviceStrain',
    'onHostDisplayFormat',
    'onClientScreenChanged',
];

function view() {
    return {
        activate: vi.fn(),
        captureViewState: () => null,
        restoreViewState: vi.fn(),
        quit: vi.fn(async () => {}),
    };
}

let saved;

beforeEach(() => {
    saved = {
        streamView: MoonlightApp.streamView,
        _standbyView: MoonlightApp._standbyView,
        _standbyResult: MoonlightApp._standbyResult,
        _activeSlot: MoonlightApp._activeSlot,
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(MoonlightApp, '_armUpgradeTimer').mockImplementation(() => {});
    vi.spyOn(MoonlightApp, '_adoptNativeFormat').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(MoonlightApp, saved);
});

/** The live view, a standby on its first frame: the swap. */
function swap() {
    const old = view();
    const standby = view();
    MoonlightApp.streamView = old;
    MoonlightApp._standbyView = standby;
    MoonlightApp._standbyResult = { slot: 1 };
    MoonlightApp._promoteStandby();
    return { old, standby };
}

describe('a seamless relaunch', () => {
    it('swaps in a view whose screen changes reach the app, so the next one relaunches', () => {
        const changed = vi
            .spyOn(MoonlightApp, '_onClientScreenChanged')
            .mockImplementation(() => {});
        const { old, standby } = swap();
        expect(MoonlightApp.streamView).toBe(standby);
        expect(old.quit).toHaveBeenCalledWith({ silent: true, retire: true });

        const screen = { width: 1366, height: 768 };
        standby.onClientScreenChanged(screen);
        expect(changed).toHaveBeenCalledWith(screen);
    });

    it('wires the swapped-in view with every callback of a first launch', () => {
        const { standby } = swap();
        for (const name of LIVE_CALLBACKS) expect(typeof standby[name], name).toBe('function');
        expect(standby.onFirstFrame).toBe(null);
    });
});
