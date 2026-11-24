/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoonlightApp } from '../js/app.js';
import { Toast } from '../js/ui/Toast.js';

/*
 * The quality ladder after the stream adaptation review (23/11/2026): one
 * detection used to cost four relaunches (one down, three back up 75 s apart)
 * and four toasts. Now it comes back up in one relaunch, stops trying after
 * two flaps, respects a cap the page sets, keeps quiet when the swap is
 * seamless, and answers a slow decoder with frame rate or size.
 */

const KEYS = [
    'streamView',
    '_nav',
    '_standbyView',
    '_lastStreamNative',
    '_lastStreamKeepsSize',
    '_lastStreamingSettings',
    '_degradeOverrides',
    '_degradeLevel',
    '_lastDegradeTime',
    '_lastUpgradeTime',
    '_lastCongSignal',
    '_upgradeStableMs',
    '_originalStreamHeight',
    '_transportChain',
    '_transportIndex',
    '_enhancementAutoForced',
    '_flapCount',
    '_upgradeHeld',
    '_degradeToldPlayer',
    '_deviceHold',
    '_dualSupported',
];
let saved;
let relaunch;
let now;

beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, MoonlightApp[k]]));
    delete globalThis.mwQualityPolicy;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Toast, 'info').mockImplementation(() => {});
    vi.spyOn(Toast, 'warning').mockImplementation(() => {});
    vi.spyOn(MoonlightApp, '_sharePinsQuality').mockReturnValue(false);
    relaunch = vi.spyOn(MoonlightApp, '_qualityRelaunch').mockImplementation(() => {});
    now = 1e6;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    Object.assign(MoonlightApp, {
        _nav: { overlay: 'streaming' },
        _standbyView: null,
        _lastStreamNative: false,
        _lastStreamKeepsSize: true, // a Wolf seat
        _lastStreamingSettings: { stream_height: 1440, stream_bitrate: 36000, stream_fps: 60 },
        _degradeOverrides: {},
        _degradeLevel: 0,
        _lastDegradeTime: 0,
        _lastUpgradeTime: 0,
        _lastCongSignal: 0,
        _upgradeStableMs: 75000,
        _originalStreamHeight: undefined,
        _transportChain: ['webrtc-dc-udp', 'webrtc-media-udp'],
        _transportIndex: 0,
        _enhancementAutoForced: false,
        _flapCount: 0,
        _upgradeHeld: false,
        _degradeToldPlayer: false,
        _deviceHold: {},
        _dualSupported: true,
        // A live view: quality changes swap seamlessly.
        streamView: { _firstFrameRendered: true, currentFrameHeight: () => 1440 },
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.mwQualityPolicy;
    Object.assign(MoonlightApp, saved);
});

/** Quiet long enough for an upgrade, then poll. */
function quietThenPoll() {
    now += (MoonlightApp._upgradeStableMs || 75000) + 1000;
    MoonlightApp._maybeUpgradeQuality();
}

describe('the ladder after the review', () => {
    it('comes back up in one relaunch, to the session settings', () => {
        MoonlightApp._onStreamCongested();
        now += 20000;
        MoonlightApp._onStreamCongested(); // two steps down
        expect(relaunch).toHaveBeenCalledTimes(2);
        expect(Object.keys(MoonlightApp._degradeOverrides).length).toBeGreaterThan(0);
        quietThenPoll();
        expect(relaunch).toHaveBeenCalledTimes(3);
        expect(MoonlightApp._degradeOverrides).toEqual({});
        expect(MoonlightApp._degradeLevel).toBe(0);
        quietThenPoll(); // nothing left to restore: no further relaunch
        expect(relaunch).toHaveBeenCalledTimes(3);
    });

    it('stops coming back up after falling twice within 5 minutes of it', () => {
        MoonlightApp._onStreamCongested();
        quietThenPoll(); // up
        now += 134000;
        MoonlightApp._onStreamCongested(); // flap 1: quiet time doubled
        expect(MoonlightApp._upgradeStableMs).toBe(150000);
        quietThenPoll(); // up again
        now += 60000;
        MoonlightApp._onStreamCongested(); // flap 2: hold
        expect(MoonlightApp._upgradeHeld).toBe(true);
        const before = relaunch.mock.calls.length;
        quietThenPoll();
        expect(relaunch.mock.calls.length).toBe(before);
    });

    it('takes no more steps than the page allows', () => {
        globalThis.mwQualityPolicy = { maxDegradeSteps: 1 };
        MoonlightApp._onStreamCongested();
        now += 20000;
        MoonlightApp._onStreamCongested();
        expect(relaunch).toHaveBeenCalledTimes(1);
    });

    it('says nothing when the swap is seamless, coming down or going up', () => {
        MoonlightApp._onStreamCongested();
        quietThenPoll();
        expect(Toast.info).not.toHaveBeenCalled();
        expect(Toast.warning).not.toHaveBeenCalled();
    });

    it('says the picture was lowered once, and that it is back once, when the player sees it', () => {
        MoonlightApp.streamView = null; // no live view: the relaunch shows
        MoonlightApp._onStreamCongested();
        expect(Toast.info).toHaveBeenCalledTimes(1);
        expect(Toast.info.mock.calls[0][0]).toMatch(/qualityLowered|picture quality/i);
        MoonlightApp.streamView = { _firstFrameRendered: true, currentFrameHeight: () => 1440 };
        quietThenPoll();
        expect(Toast.info).toHaveBeenCalledTimes(2);
        expect(Toast.info.mock.calls[1][0]).toMatch(/qualityRestored|full picture quality/i);
        expect(Toast.warning).not.toHaveBeenCalled();
    });

    it('answers a slow decoder with frame rate, never transport or bitrate', () => {
        MoonlightApp._onDeviceStrained();
        const o = MoonlightApp._degradeOverrides;
        expect(o.stream_fps).toBe(30); // a Wolf seat keeps its size
        expect(o.transport_mode).toBeUndefined();
        expect(o.stream_bitrate).toBeUndefined();
        expect(relaunch).toHaveBeenCalledTimes(1);
    });

    it('keeps what the decoder needed when the network ladder comes back up', () => {
        MoonlightApp._onDeviceStrained();
        now += 20000;
        MoonlightApp._onStreamCongested();
        quietThenPoll();
        expect(MoonlightApp._degradeOverrides).toEqual({ stream_fps: 30 });
    });
});
