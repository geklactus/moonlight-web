/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A stream whose browser changed networks keeps running (stream/Reattach.js).
 *
 * The view builds a new media transport to the same worker, with the token
 * /start gave it, and keeps everything else; the old transport's last
 * callbacks no longer reach it. A reattach that fails, or takes longer than
 * the worker waits, hands the loss on exactly as a lost link always was.
 */

// The transports the view builds, recorded. The real class opens sockets.
const built = [];
vi.mock('../js/api/WebRtcMedia.js', () => ({
    WebRtcMedia: class {
        constructor(url, options = {}) {
            this.url = url;
            this.options = options;
            this.connect = vi.fn();
            this.close = vi.fn();
            this.markStopping = vi.fn();
            this.send = vi.fn();
            this.setVideoElement = vi.fn((el) => {
                this.videoElement = el;
            });
            built.push(this);
        }
    },
}));

const { StreamView } = await import('../js/ui/StreamView.js');
const { REATTACH_WINDOW_MS } = await import('../js/stream/Reattach.js');

/** The transport a view starts with. */
function firstTransport() {
    return {
        connect: vi.fn(),
        close: vi.fn(),
        markStopping: vi.fn(),
        send: vi.fn(),
        videoElement: {},
        audioElement: { id: 'audio' },
        mic: null,
        _unpairedGuest: false,
    };
}

/** A StreamView reduced to its transport handlers and what onOpen touches. */
function reattachView(overrides = {}) {
    const P = StreamView.prototype;
    const videoEl = document.createElement('video');
    const sv = {
        webrtc: firstTransport(),
        signalingUrl: 'wss://host/ws',
        videoEl,
        _transport: 'webrtc-media',
        _nativeAudio: true,
        _everConnected: true,
        _firstFrameRendered: true,
        _quitting: false,
        _manualQuitting: false,
        _takenOver: false,
        _standby: false,
        _playerMode: false,
        connected: true,
        onConnectionFailed: null,
        onLinkLost: vi.fn(),
        setStatus: vi.fn(),
        quit: vi.fn(async () => {}),
        _reattachToken: 'tok0',
        _reattaching: false,
        _reattachTimer: null,
        _reattachStartedAt: 0,
        _padHolds: new Set(),
        _gamepadManager: { setExcluded: vi.fn(), setPaused: vi.fn(), start: vi.fn() },
        _ensureHidPassthrough: () => null,
        _updateStartupStep: vi.fn(),
        _sendInputState: vi.fn(),
        _sendCursorMode: vi.fn(),
        _sendFrameFloor: vi.fn(),
        _checkLinkStall: vi.fn(),
        _startAudioStatsPolling: vi.fn(),
        _startLinkReporting: vi.fn(),
        _startRefreshWatch: vi.fn(),
        _startScreenWatch: vi.fn(),
        _startMediaStatsPolling: vi.fn(),
        _stopMediaStatsPolling: vi.fn(),
        _notePresentation: vi.fn(),
        _markFirstFrame: vi.fn(),
        _initMobileFullscreen: vi.fn(),
        _applyFullscreenOnStart: vi.fn(),
        _handleStatsMessage: vi.fn(),
        _handleTakeover: vi.fn(),
        _handleRevoked: vi.fn(),
        _handleSessionEnded: vi.fn(),
        _handleHostEnded: vi.fn(),
        _handleHostLost: vi.fn(),
        _reportConnectionFailed: P._reportConnectionFailed,
        _reattachTransport: P._reattachTransport,
        _abandonReattach: P._abandonReattach,
        _wireTransportMessages: P._wireTransportMessages,
        _noteNetworkChange: P._noteNetworkChange,
        _handOffLinkLoss: P._handOffLinkLoss,
        _linkLostDefault: P._linkLostDefault,
        setupWebRtc: P.setupWebRtc,
        ...overrides,
    };
    sv._wireTransportMessages();
    sv.setupWebRtc();
    return sv;
}

/** What a transport does when its link goes: onError, then onClose. */
function loseLink(transport) {
    transport.onError?.(new Error('ICE disconnected'));
    transport.onClose?.();
}

describe('StreamView: a link that goes on the media transport', () => {
    beforeEach(() => {
        built.length = 0;
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('builds one new transport to the same worker, with the token', () => {
        const sv = reattachView();
        const old = sv.webrtc;
        loseLink(old);
        vi.advanceTimersByTime(0);
        expect(built).toHaveLength(1);
        const next = built[0];
        expect(next.url).toBe('wss://host/ws');
        expect(next.options).toEqual({ reattachToken: 'tok0' });
        expect(next.connect).toHaveBeenCalledTimes(1);
        expect(sv.webrtc).toBe(next);
        // The same picture and sound elements, nothing handed to the app.
        expect(next.videoElement).toBe(sv.videoEl);
        expect(next.audioElement).toBe(old.audioElement);
        expect(sv.onLinkLost).not.toHaveBeenCalled();
        expect(sv.quit).not.toHaveBeenCalled();
        expect(sv.setStatus).toHaveBeenCalledWith('connecting', 'Reconnecting...');
    });

    it("leaves the old transport's picture alone and stops hearing it", () => {
        const sv = reattachView();
        const old = sv.webrtc;
        old.onError(new Error('ICE disconnected'));
        expect(old.onClose).toBe(null); // its onClose, next, reaches nobody
        expect(old.videoElement).toBe(null); // its close() keeps the last frame
        expect(sv._stopMediaStatsPolling).toHaveBeenCalledTimes(1);
    });

    it('is done when the new transport opens: the window stops, the token turns over', () => {
        const sv = reattachView();
        loseLink(sv.webrtc);
        vi.advanceTimersByTime(0);
        const next = built[0];
        next.onReattachToken('tok1');
        expect(sv._reattachToken).toBe('tok1');
        next.onOpen();
        expect(sv._reattaching).toBe(false);
        expect(sv._startMediaStatsPolling).toHaveBeenCalledTimes(1);
        expect(sv._updateStartupStep).not.toHaveBeenCalled(); // no startup screen again
        sv.videoEl.dispatchEvent(new Event('playing'));
        expect(sv.setStatus).toHaveBeenLastCalledWith('live', 'Live');
        vi.advanceTimersByTime(REATTACH_WINDOW_MS * 2);
        expect(sv.onLinkLost).not.toHaveBeenCalled();
    });

    it('a second loss later reattaches again, with the next token', () => {
        const sv = reattachView();
        loseLink(sv.webrtc);
        vi.advanceTimersByTime(0);
        built[0].onReattachToken('tok1');
        built[0].onOpen();
        loseLink(built[0]);
        vi.advanceTimersByTime(0);
        expect(built).toHaveLength(2);
        expect(built[1].options).toEqual({ reattachToken: 'tok1' });
    });

    it('hands the loss on as before when the new transport fails', () => {
        const sv = reattachView();
        loseLink(sv.webrtc);
        vi.advanceTimersByTime(0);
        const next = built[0];
        loseLink(next);
        vi.runAllTimers();
        expect(next.markStopping).toHaveBeenCalled();
        expect(next.close).toHaveBeenCalled();
        expect(sv.onLinkLost).toHaveBeenCalledTimes(1);
        expect(sv._reattachToken).toBe(null); // no second try on a spent token
        expect(built).toHaveLength(1);
    });

    it('hands the loss on as before when the worker does not answer in time', () => {
        const sv = reattachView();
        loseLink(sv.webrtc);
        vi.advanceTimersByTime(0);
        vi.advanceTimersByTime(REATTACH_WINDOW_MS);
        vi.runAllTimers();
        expect(built[0].close).toHaveBeenCalled();
        expect(sv.onLinkLost).toHaveBeenCalledTimes(1);
        expect(sv._reattaching).toBe(false);
    });

    it('does not reattach without a token, before the first connect, or for a standby leg', () => {
        for (const flags of [
            { _reattachToken: null },
            { _transport: 'webrtc' },
            { _takenOver: true },
        ]) {
            built.length = 0;
            const sv = reattachView(flags);
            loseLink(sv.webrtc);
            vi.runAllTimers();
            expect(built, JSON.stringify(flags)).toHaveLength(0);
        }
        built.length = 0;
        const failed = vi.fn();
        const standby = reattachView({ _standby: true, onConnectionFailed: failed });
        loseLink(standby.webrtc);
        vi.runAllTimers();
        expect(built).toHaveLength(0);
        expect(failed).toHaveBeenCalledTimes(1);
    });

    it('builds nothing when Stop is pressed before the new transport is made', () => {
        const sv = reattachView();
        loseLink(sv.webrtc);
        sv._manualQuitting = true;
        vi.advanceTimersByTime(0);
        expect(built).toHaveLength(0);
    });

    it('passes a network change to the transport, not during a reattach', () => {
        const sv = reattachView();
        sv.webrtc.noteNetworkChange = vi.fn();
        sv._noteNetworkChange();
        expect(sv.webrtc.noteNetworkChange).toHaveBeenCalledTimes(1);
        loseLink(sv.webrtc);
        vi.advanceTimersByTime(0);
        built[0].noteNetworkChange = vi.fn();
        sv._noteNetworkChange();
        expect(built[0].noteNetworkChange).not.toHaveBeenCalled();
    });
});
