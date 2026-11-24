/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A transport's reasons for ending go to the console, the worker log and the
 * trace, in English like every other line there (api/transportErrors.js).
 * They were in French: on 24/11/2026 an English page on LOLA logged
 * "Connexion au serveur de streaming impossible" for a signalling socket that
 * failed.
 */

// The signalling socket each transport opens, kept so a test can close it.
let socket = null;
vi.mock('../js/net/tunnelBridge.js', () => ({
    openSignalingSocket: () => {
        socket = { readyState: 0, send: vi.fn(), close: vi.fn() };
        return socket;
    },
}));

const { WebRtcDataChannel } = await import('../js/api/WebRtcDataChannel.js');
const { WebRtcMedia } = await import('../js/api/WebRtcMedia.js');
const { SIGNALING_UNREACHABLE, SIGNALING_TLS_FAILED } =
    await import('../js/api/transportErrors.js');

describe.each([
    ['WebRtcDataChannel', () => new WebRtcDataChannel('ws://test.invalid/ws')],
    ['WebRtcMedia', () => new WebRtcMedia('ws://test.invalid/ws')],
])('%s — a signalling socket that fails before it opens', (_name, make) => {
    beforeEach(() => {
        socket = null;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    /** The message the transport hands onError when its socket closes so. */
    function reasonFor(closeEvent) {
        const t = make();
        const onError = vi.fn();
        t.onError = onError;
        t.connect();
        socket.onerror?.(new Event('error'));
        socket.onclose(closeEvent);
        expect(onError).toHaveBeenCalledTimes(1);
        return onError.mock.calls[0][0].message;
    }

    it('says the server could not be reached, in English', () => {
        expect(reasonFor({ code: 1006, reason: '' })).toBe(SIGNALING_UNREACHABLE);
    });

    it('says a TLS handshake failed, in English', () => {
        expect(reasonFor({ code: 1015, reason: '' })).toBe(SIGNALING_TLS_FAILED);
    });
});

describe('transport reasons', () => {
    it('are English: none of the French they replaced', async () => {
        const reasons = Object.values(await import('../js/api/transportErrors.js'));
        expect(reasons.length).toBe(5);
        for (const r of reasons) {
            expect(typeof r).toBe('string');
            expect(r).not.toMatch(/serveur|connexion|vérifiez|verifiez|erreur|réseau/i);
        }
    });
});
