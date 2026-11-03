/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The media transport's side of a reattach (stream/Reattach.js): the token
 * goes first on the signalling socket, the host's next token is handed up, and
 * a network change gives up a path ICE shows gone without waiting for ICE to
 * call it dead.
 */

const sockets = [];
vi.mock('../js/net/tunnelBridge.js', () => ({
    openSignalingSocket: (url) => {
        const ws = {
            url,
            readyState: 1,
            sent: [],
            send: vi.fn((m) => ws.sent.push(m)),
            close: vi.fn(),
        };
        sockets.push(ws);
        return ws;
    },
}));
// No MW-BIND key in this browser: no hello follows the reattach.
vi.mock('../js/util/pairingCrypto.js', async (orig) => ({
    ...(await orig()),
    beginHandshake: () => Promise.resolve(null),
}));

const { WebRtcMedia } = await import('../js/api/WebRtcMedia.js');
const { WebRtcDataChannel } = await import('../js/api/WebRtcDataChannel.js');
const { NETWORK_SETTLE_MS, REATTACH_WINDOW_MS, canReattach, pathDown } =
    await import('../js/stream/Reattach.js');

describe('Reattach: when a lost link may be reattached', () => {
    const base = {
        transport: 'webrtc-media',
        token: 'tok',
        everConnected: true,
        reattaching: false,
        standby: false,
        takenOver: false,
        quitting: false,
    };

    it('on either WebRTC transport, with a token, once the stream ran', () => {
        expect(canReattach(base)).toBe(true);
        expect(canReattach({ ...base, transport: 'webrtc' })).toBe(true); // DataChannel
    });

    it('never otherwise', () => {
        for (const change of [
            { transport: 'wss' },
            { token: null },
            { token: '' },
            { everConnected: false },
            { reattaching: true },
            { standby: true },
            { takenOver: true },
            { quitting: true },
        ]) {
            expect(canReattach({ ...base, ...change }), JSON.stringify(change)).toBe(false);
        }
    });

    it('waits less than the worker does', () => {
        expect(REATTACH_WINDOW_MS).toBeLessThan(20000);
        expect(REATTACH_WINDOW_MS).toBeGreaterThan(10000);
    });

    it('reads a path as gone in the states where ICE has lost it', () => {
        expect(pathDown('disconnected')).toBe(true);
        expect(pathDown('failed')).toBe(true);
        expect(pathDown('checking')).toBe(true);
        expect(pathDown('connected')).toBe(false);
        expect(pathDown('completed')).toBe(false);
        expect(pathDown(undefined)).toBe(false);
    });
});

describe.each([
    ['WebRtcMedia', WebRtcMedia],
    ['WebRtcDataChannel', WebRtcDataChannel],
])('%s: reattaching', (_name, Transport) => {
    let peers;
    /** A signalling message from the host. */
    const hostSays = (msg) => sockets[0].onmessage({ data: JSON.stringify(msg) });
    beforeEach(() => {
        sockets.length = 0;
        peers = [];
        vi.useFakeTimers();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        globalThis.RTCPeerConnection = class {
            constructor() {
                this.iceConnectionState = 'new';
                peers.push(this);
            }
            createDataChannel() {
                return { readyState: 'connecting', close() {} };
            }
            close() {}
        };
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        delete globalThis.RTCPeerConnection;
    });

    it('says reattach, with its token, before anything else', () => {
        const t = new Transport('wss://host/ws', { reattachToken: 'tok0' });
        t.connect();
        sockets[0].onopen();
        expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: 'reattach', token: 'tok0' });
        t.close();
    });

    it('says nothing of the kind on a first connection', () => {
        const t = new Transport('wss://host/ws');
        t.connect();
        sockets[0].onopen();
        hostSays({ type: 'ice-config', iceServers: [] });
        expect(sockets[0].sent.map((m) => JSON.parse(m).type)).not.toContain('reattach');
        t.close();
    });

    it("hands the host's next token up", () => {
        const t = new Transport('wss://host/ws');
        const got = vi.fn();
        t.onReattachToken = got;
        t.connect();
        sockets[0].onopen();
        hostSays({ type: 'ice-config', iceServers: [] });
        t.dataChannels.input.onmessage({
            data: JSON.stringify({ type: 'reattach-token', token: 'tok1' }),
        });
        expect(got).toHaveBeenCalledWith('tok1');
        t.close();
    });

    it('gives the link up after a network change that took the path', () => {
        const t = new Transport('wss://host/ws');
        const onError = vi.fn();
        t.onError = onError;
        t.connect();
        sockets[0].onopen();
        hostSays({ type: 'ice-config', iceServers: [] });
        t.connected = true;
        t.noteNetworkChange();
        peers[0].iceConnectionState = 'disconnected';
        vi.advanceTimersByTime(NETWORK_SETTLE_MS - 1);
        expect(onError).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0].message).toContain('network changed');
    });

    it('keeps a link whose path survived the change', () => {
        const t = new Transport('wss://host/ws');
        const onError = vi.fn();
        t.onError = onError;
        t.connect();
        sockets[0].onopen();
        hostSays({ type: 'ice-config', iceServers: [] });
        t.connected = true;
        peers[0].iceConnectionState = 'connected';
        t.noteNetworkChange();
        vi.advanceTimersByTime(NETWORK_SETTLE_MS * 3);
        expect(onError).not.toHaveBeenCalled();
        t.close();
    });

    it('cuts the disconnect grace short after a network change', () => {
        const t = new WebRtcMedia('wss://host/ws');
        const onError = vi.fn();
        t.onError = onError;
        t.connect();
        sockets[0].onopen();
        t.connected = true;
        t._iceConnected = true;
        peers[0].iceConnectionState = 'disconnected';
        peers[0].oniceconnectionstatechange(); // the grace starts
        t.noteNetworkChange();
        vi.advanceTimersByTime(NETWORK_SETTLE_MS);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(NETWORK_SETTLE_MS).toBeLessThan(t.DISCONNECT_GRACE_MS);
        vi.advanceTimersByTime(t.DISCONNECT_GRACE_MS);
        expect(onError).toHaveBeenCalledTimes(1); // the grace's own end went with the close
    });

    it('ignores a network change before it connected or once closed', () => {
        const t = new Transport('wss://host/ws');
        const onError = vi.fn();
        t.onError = onError;
        t.connect();
        sockets[0].onopen();
        hostSays({ type: 'ice-config', iceServers: [] });
        peers[0].iceConnectionState = 'disconnected';
        t.noteNetworkChange(); // not connected yet: the connection chain owns it
        vi.advanceTimersByTime(NETWORK_SETTLE_MS * 2);
        expect(onError).not.toHaveBeenCalled();
        t.connected = true;
        t.noteNetworkChange();
        t.close(); // the pending check goes with it
        vi.advanceTimersByTime(NETWORK_SETTLE_MS * 2);
        expect(onError).not.toHaveBeenCalled();
    });
});
