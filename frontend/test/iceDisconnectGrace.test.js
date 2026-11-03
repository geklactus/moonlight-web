/*
 * MoonlightWeb — TNR suite.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebRtcDataChannel } from '../js/api/WebRtcDataChannel.js';
import { WebRtcMedia } from '../js/api/WebRtcMedia.js';

/**
 * A stream whose link drops for a moment — ICE 'disconnected', the transient
 * state, as on a phone changing radios — gets DISCONNECT_GRACE_MS to come back
 * before it is ended; 'failed', or the grace running out, ends it as before.
 * Before, 'disconnected' ended the stream at once and every hiccup became a
 * full relaunch (a new peer connection, a new host session, a keyframe wait).
 */

/** A peer connection that does nothing: any method is a no-op returning a stub. */
function fakePcClass() {
    const stub = () =>
        new Proxy(
            {},
            {
                get: (o, k) => (k in o ? o[k] : k === 'then' ? undefined : () => stub()),
                set: (o, k, v) => ((o[k] = v), true),
            },
        );
    return class {
        constructor() {
            this.iceConnectionState = 'new';
            return new Proxy(this, {
                get: (o, k) => (k in o ? o[k] : k === 'then' ? undefined : () => stub()),
                set: (o, k, v) => ((o[k] = v), true),
            });
        }
    };
}

function ice(t, state) {
    t.pc.iceConnectionState = state;
    t.pc.oniceconnectionstatechange();
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe.each([
    ['WebRtcDataChannel', () => new WebRtcDataChannel('ws://test.invalid')],
    ['WebRtcMedia', () => new WebRtcMedia('ws://test.invalid')],
])('%s — a link that drops for a moment', (_name, make) => {
    function connected() {
        vi.useFakeTimers();
        vi.stubGlobal('RTCPeerConnection', fakePcClass());
        const t = make();
        t.onError = vi.fn();
        t._createPeerConnection();
        ice(t, 'connected');
        return t;
    }

    it('a drop that comes back within the grace ends nothing', () => {
        const t = connected();
        ice(t, 'disconnected');
        expect(t.linkQuietUntil).toBe(Infinity);
        vi.advanceTimersByTime(t.DISCONNECT_GRACE_MS - 1000);
        ice(t, 'connected');
        vi.advanceTimersByTime(t.DISCONNECT_GRACE_MS * 2);
        expect(t.onError).not.toHaveBeenCalled();
        // The congestion monitor stays quiet for a while after, then not.
        expect(t.linkQuietUntil).toBeGreaterThan(performance.now());
        expect(t.linkQuietUntil).toBeLessThan(Infinity);
    });

    it('a drop that outlasts the grace ends the stream, as before', () => {
        const t = connected();
        ice(t, 'disconnected');
        vi.advanceTimersByTime(t.DISCONNECT_GRACE_MS - 1);
        expect(t.onError).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2);
        expect(t.onError).toHaveBeenCalledTimes(1);
    });

    it("'failed' ends it at once, grace or not", () => {
        const t = connected();
        ice(t, 'disconnected');
        ice(t, 'failed');
        expect(t.onError).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(t.DISCONNECT_GRACE_MS * 2);
        expect(t.onError).toHaveBeenCalledTimes(1);
    });

    it('closing during the grace ends nothing more', () => {
        const t = connected();
        ice(t, 'disconnected');
        t.close();
        vi.advanceTimersByTime(t.DISCONNECT_GRACE_MS * 2);
        expect(t.onError).not.toHaveBeenCalled();
    });
});
