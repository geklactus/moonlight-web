/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../js/util/RtpH265.js', async (importOriginal) => ({
    ...(await importOriginal()),
    noteRtpH265Failed: vi.fn(),
}));

import { StreamView } from '../js/ui/StreamView.js';
import { noteRtpH265Failed } from '../js/util/RtpH265.js';

/**
 * H.265 on the media track that the browser listed and never decodes: RTP
 * bytes arrive, framesDecoded stays at zero. After MEDIA_NEVER_DECODED_TICKS
 * ticks the view asks the codec fallback (back in H.264) and keeps the
 * verdict for this browser; an H.264 stream is left to the no-video watchdog.
 */
const P = StreamView.prototype;
const TICKS = StreamView.MEDIA_NEVER_DECODED_TICKS;

function view(over = {}) {
    return {
        videoCodec: 'hevc',
        _requestCodecFallback: vi.fn(),
        _checkMediaNeverDecoded: P._checkMediaNeverDecoded,
        _onMediaCodecUnsupported: P._onMediaCodecUnsupported,
        ...over,
    };
}

describe('StreamView — an H.265 media track that never decodes', () => {
    beforeEach(() => {
        noteRtpH265Failed.mockReset();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('falls back to H.264 after the ticks, and remembers it', () => {
        const v = view();
        for (let i = 1; i < TICKS; i++) {
            expect(v._checkMediaNeverDecoded({ bytesReceived: 1000 * i, framesDecoded: 0 })).toBe(
                false,
            );
        }
        expect(v._checkMediaNeverDecoded({ bytesReceived: 1000 * TICKS, framesDecoded: 0 })).toBe(
            true,
        );
        expect(v._requestCodecFallback).toHaveBeenCalledTimes(1);
        expect(noteRtpH265Failed).toHaveBeenCalledTimes(1);
    });

    it('does not count ticks without bytes, and never again once a frame decoded', () => {
        const v = view();
        for (let i = 0; i < 2 * TICKS; i++)
            expect(v._checkMediaNeverDecoded({ bytesReceived: 0, framesDecoded: 0 })).toBe(false);
        expect(v._checkMediaNeverDecoded({ bytesReceived: 500, framesDecoded: 1 })).toBe(false);
        for (let i = 0; i < 2 * TICKS; i++)
            expect(v._checkMediaNeverDecoded({ bytesReceived: 5000, framesDecoded: 1 })).toBe(
                false,
            );
        // A frozen decoder later is the decode-stall watchdog's, not this.
        expect(v._requestCodecFallback).not.toHaveBeenCalled();
        expect(noteRtpH265Failed).not.toHaveBeenCalled();
    });

    it('leaves an H.264 stream to the transport chain', () => {
        const v = view({ videoCodec: 'h264' });
        for (let i = 1; i <= 2 * TICKS; i++)
            expect(v._checkMediaNeverDecoded({ bytesReceived: 1000 * i, framesDecoded: 0 })).toBe(
                false,
            );
        expect(v._requestCodecFallback).not.toHaveBeenCalled();
        expect(noteRtpH265Failed).not.toHaveBeenCalled();
    });

    it('acts on the offer refused by the receiver the same way, for HEVC only', () => {
        const v = view();
        v._onMediaCodecUnsupported('h264');
        expect(v._requestCodecFallback).not.toHaveBeenCalled();
        v._onMediaCodecUnsupported('hevc');
        expect(v._requestCodecFallback).toHaveBeenCalledTimes(1);
        expect(noteRtpH265Failed).toHaveBeenCalledTimes(1);
    });
});
