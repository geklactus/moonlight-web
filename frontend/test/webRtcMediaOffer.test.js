/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebRtcMedia } from '../js/api/WebRtcMedia.js';

/**
 * The media transport's offer against this browser's RTP receiver: an H.265
 * offer the receiver does not list is handed to the view (onCodecUnsupported)
 * instead of answered — no picture could come of it — while an H.264 offer
 * goes on as it always did, listed or not.
 */

const OFFER_H265 =
    'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n' +
    'm=video 9 UDP/TLS/RTP/SAVPF 97\r\na=rtpmap:97 H265/90000\r\n' +
    'a=fmtp:97 level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST\r\n';
const OFFER_H264 =
    'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n' +
    'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n';

function receiverLists(...mimeTypes) {
    vi.stubGlobal('RTCRtpReceiver', {
        getCapabilities: () => ({ codecs: mimeTypes.map((mimeType) => ({ mimeType })) }),
    });
    // jsdom has no WebRTC: the description the answer path builds first.
    vi.stubGlobal(
        'RTCSessionDescription',
        class {
            constructor(init) {
                Object.assign(this, init);
            }
        },
    );
}

function media() {
    const m = new WebRtcMedia('wss://host.test/ws');
    m.onCodecUnsupported = vi.fn();
    m.onError = vi.fn();
    m.onClose = vi.fn();
    m.pc = {
        setRemoteDescription: vi.fn(async () => {}),
        createAnswer: vi.fn(async () => {
            throw new Error('stub');
        }),
        close: vi.fn(),
    };
    return m;
}

describe('WebRtcMedia — the offer against the receiver', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('hands an H.265 offer the receiver does not list to the view, unanswered', async () => {
        receiverLists('video/H264', 'video/VP8');
        const m = media();
        await m._handleSdpOffer({ sdp: OFFER_H265 });
        expect(m.onCodecUnsupported).toHaveBeenCalledWith('hevc');
        expect(m.pc.setRemoteDescription).not.toHaveBeenCalled();
    });

    it('answers an H.265 offer the receiver lists', async () => {
        receiverLists('video/H264', 'video/H265');
        const m = media();
        const pc = m.pc; // closed and dropped once the stub answer fails
        await m._handleSdpOffer({ sdp: OFFER_H265 });
        expect(m.onCodecUnsupported).not.toHaveBeenCalled();
        expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);
    });

    it('answers an H.264 offer as before, whatever the receiver lists', async () => {
        receiverLists('video/VP8');
        const m = media();
        const pc = m.pc;
        await m._handleSdpOffer({ sdp: OFFER_H264 });
        expect(m.onCodecUnsupported).not.toHaveBeenCalled();
        expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);
    });

    it("reads the offer's codecs for the view to see", () => {
        receiverLists('video/H265');
        const m = media();
        expect(m._validateCodecSupport(OFFER_H265)).toBe(true);
        expect(m._offerCodecs).toEqual(['H265']);
        expect(m._validateCodecSupport(OFFER_H264)).toBe(false);
        expect(m._offerCodecs).toEqual(['H264']);
    });
});
