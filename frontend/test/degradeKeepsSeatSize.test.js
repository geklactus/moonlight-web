/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoonlightApp } from '../js/app.js';
import { Toast } from '../js/ui/Toast.js';

/**
 * The congestion ladder on a Wolf seat leaves the resolution alone.
 *
 * LOLA, 20/11/2026: a 1080p stream of a Wolf seat stalled three times in four
 * seconds, the ladder relaunched it at 720p, and from then on the mouse was
 * off. Wolf resumes a session on the display it already has (1920×1080) and
 * scales the video for the new stream, but it scales the mouse's position to
 * the new stream's size and places it by that on the old display: the pointer
 * landed two thirds of the way to wherever the mouse was. A seat's display
 * cannot follow the stream, so on a Wolf host the ladder uses its other knobs.
 */

let saved;

beforeEach(() => {
    saved = {
        streamView: MoonlightApp.streamView,
        _nav: MoonlightApp._nav,
        _standbyView: MoonlightApp._standbyView,
        _lastStreamNative: MoonlightApp._lastStreamNative,
        _lastStreamKeepsSize: MoonlightApp._lastStreamKeepsSize,
        _lastStreamingSettings: MoonlightApp._lastStreamingSettings,
        _degradeOverrides: MoonlightApp._degradeOverrides,
        _degradeLevel: MoonlightApp._degradeLevel,
        _lastDegradeTime: MoonlightApp._lastDegradeTime,
        _lastUpgradeTime: MoonlightApp._lastUpgradeTime,
        _originalStreamHeight: MoonlightApp._originalStreamHeight,
        _transportChain: MoonlightApp._transportChain,
        _transportIndex: MoonlightApp._transportIndex,
        _enhancementAutoForced: MoonlightApp._enhancementAutoForced,
    };
    vi.spyOn(globalThis.console, 'warn').mockImplementation(() => {});
    vi.spyOn(Toast, 'warning').mockImplementation(() => {});
    vi.spyOn(Toast, 'info').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(MoonlightApp, saved);
});

/** A 1080p stream at 20 Mbit over the DataChannel that has just been called congested. */
function congested({ keepsSize }) {
    MoonlightApp._nav = { overlay: 'streaming' };
    MoonlightApp._standbyView = null;
    MoonlightApp._lastStreamNative = false;
    MoonlightApp._lastStreamKeepsSize = keepsSize;
    MoonlightApp._lastStreamingSettings = {
        stream_height: 1080,
        stream_bitrate: 20000,
        stream_fps: 60,
    };
    MoonlightApp._degradeOverrides = {};
    MoonlightApp._degradeLevel = 0;
    MoonlightApp._lastDegradeTime = 0;
    MoonlightApp._lastUpgradeTime = 0;
    MoonlightApp._originalStreamHeight = undefined;
    MoonlightApp._transportChain = ['webrtc-dc-udp', 'webrtc-dc-tcp', 'wss', 'webrtc-media-udp'];
    MoonlightApp._transportIndex = 0;
    vi.spyOn(MoonlightApp, '_sharePinsQuality').mockReturnValue(false);
    const relaunch = vi.spyOn(MoonlightApp, '_qualityRelaunch').mockImplementation(() => {});
    MoonlightApp._onStreamCongested();
    return relaunch;
}

describe('the congestion ladder and the size of the picture', () => {
    it('steps the resolution down on a host whose display follows the stream', () => {
        const relaunch = congested({ keepsSize: false });
        expect(MoonlightApp._degradeOverrides.stream_height).toBe(720);
        expect(MoonlightApp._originalStreamHeight).toBe(1080);
        expect(relaunch).toHaveBeenCalledTimes(1);
    });

    it('leaves it alone on a Wolf seat, and still cuts the bitrate', () => {
        const relaunch = congested({ keepsSize: true });
        expect(MoonlightApp._degradeOverrides.stream_height).toBeUndefined();
        expect(MoonlightApp._originalStreamHeight).toBeUndefined();
        expect(MoonlightApp._degradeOverrides.stream_bitrate).toBe(10000);
        // Nor its transport: on the LAN the media transport ran slower than the
        // DataChannel it replaced (review of 23/11/2026). Bitrate only.
        expect(MoonlightApp._degradeOverrides.transport_mode).toBeUndefined();
        expect(relaunch).toHaveBeenCalledTimes(1);
    });

    it('never reaches the resolution on a Wolf seat, however long the link stays bad', () => {
        congested({ keepsSize: true });
        for (let i = 0; i < 12; i++) {
            MoonlightApp._lastDegradeTime = 0;
            MoonlightApp._onStreamCongested();
        }
        expect(MoonlightApp._degradeOverrides.stream_height).toBeUndefined();
        expect(MoonlightApp._degradeOverrides.stream_bitrate).toBe(2000);
    });
});
