/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect } from 'vitest';
import {
    RTP_H265_FAILED_DAYS,
    noteRtpH265Failed,
    rtpH265Capability,
    rtpH265FailedHere,
    rtpH265RequestFields,
    sdpVideoCodecs,
} from '../js/util/RtpH265.js';

/**
 * H.265 on the media transport: the host offers it only to a browser whose
 * own RTP decoder lists it, in the Main profile, with the fmtp line that
 * receiver names — libwebrtc matches profile, tier and level, so the host
 * repeats the line as it is. A browser whose H.265 never decoded a frame
 * keeps the verdict, and the track carries H.264 meanwhile.
 */

const DAY = 24 * 3600 * 1000;
const CHROME = 'level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST';

function caps(...codecs) {
    return { codecs: codecs.map(([mimeType, sdpFmtpLine]) => ({ mimeType, sdpFmtpLine })) };
}

function memoryStore(init = {}) {
    const m = new Map(Object.entries(init));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        map: m,
    };
}

describe('RtpH265: what the receiver lists', () => {
    it('takes the H.265 Main entry with its fmtp line as it is', () => {
        const c = caps(
            ['video/VP8', ''],
            ['video/H264', 'profile-level-id=42e01f'],
            ['video/H265', CHROME],
        );
        expect(rtpH265Capability(c)).toEqual({ fmtp: CHROME });
    });

    it('reads the mime type whatever its case, and a line without a profile as Main', () => {
        expect(rtpH265Capability(caps(['video/h265', 'level-id=153']))).toEqual({
            fmtp: 'level-id=153',
        });
        expect(rtpH265Capability(caps(['video/H265', undefined]))).toEqual({ fmtp: '' });
        // Whitespace around the line is the browser's, not the SDP's.
        expect(rtpH265Capability(caps(['video/H265', ' profile-id=1 ']))).toEqual({
            fmtp: 'profile-id=1',
        });
    });

    it('passes over the other profiles for a Main entry', () => {
        const main10 = 'level-id=180;profile-id=2;tier-flag=0;tx-mode=SRST';
        expect(rtpH265Capability(caps(['video/H265', main10]))).toBeNull();
        expect(rtpH265Capability(caps(['video/H265', main10], ['video/H265', CHROME]))).toEqual({
            fmtp: CHROME,
        });
    });

    it('is null without the codec, the API, or a line fit for an SDP', () => {
        expect(rtpH265Capability(caps(['video/H264', ''], ['video/AV1', '']))).toBeNull();
        expect(rtpH265Capability(null)).toBeNull();
        expect(rtpH265Capability({})).toBeNull();
        expect(rtpH265Capability(caps(['video/H265', 'profile-id=1\r\na=sendrecv']))).toBeNull();
        expect(rtpH265Capability(caps(['video/H265', 'profile-id=1 tx-mode=SRST']))).toBeNull();
        expect(rtpH265Capability(caps(['video/H265', 'profile-id']))).toBeNull();
    });
});

describe('RtpH265: what the launch tells the host', () => {
    it('says media_h265 with the fmtp line when the receiver lists it', () => {
        expect(rtpH265RequestFields({ cap: { fmtp: CHROME }, failed: false })).toEqual({
            media_h265: true,
            media_h265_fmtp: CHROME,
        });
        expect(rtpH265RequestFields({ cap: { fmtp: '' }, failed: false })).toEqual({
            media_h265: true,
            media_h265_fmtp: '',
        });
    });

    it('says nothing without the codec, or once it failed here', () => {
        expect(rtpH265RequestFields({ cap: null, failed: false })).toEqual({});
        expect(rtpH265RequestFields({ cap: { fmtp: CHROME }, failed: true })).toEqual({});
    });
});

describe('RtpH265: the verdict on a browser whose H.265 never decoded', () => {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0 Safari/537.36';

    it('holds for this browser version, for a while, and not for a clock set back', () => {
        const s = memoryStore();
        const now = 1000 * DAY;
        expect(rtpH265FailedHere(UA, s, now)).toBe(false);
        noteRtpH265Failed(UA, s, now);
        expect(rtpH265FailedHere(UA, s, now + DAY)).toBe(true);
        expect(rtpH265FailedHere(UA.replace('142.0', '143.0'), s, now + DAY)).toBe(false);
        expect(rtpH265FailedHere(UA, s, now + (RTP_H265_FAILED_DAYS - 1) * DAY)).toBe(true);
        expect(rtpH265FailedHere(UA, s, now + RTP_H265_FAILED_DAYS * DAY)).toBe(false);
        expect(rtpH265FailedHere(UA, s, now - DAY)).toBe(false);
    });

    it('drops the verdicts past their time when it writes a new one', () => {
        const s = memoryStore();
        noteRtpH265Failed('old', s, 0);
        noteRtpH265Failed(UA, s, (RTP_H265_FAILED_DAYS + 1) * DAY);
        expect(Object.keys(JSON.parse(s.getItem('mw_rtp_h265_failed')))).toEqual([UA]);
    });

    it('offers H.265 again where the store can be neither read nor written', () => {
        const broken = {
            getItem() {
                throw new Error('denied');
            },
            setItem() {
                throw new Error('denied');
            },
        };
        expect(() => noteRtpH265Failed(UA, broken, 0)).not.toThrow();
        expect(rtpH265FailedHere(UA, broken, 0)).toBe(false);
        expect(rtpH265FailedHere(UA, null, 0)).toBe(false);
        expect(rtpH265FailedHere(UA, memoryStore({ mw_rtp_h265_failed: '[not json' }), 0)).toBe(
            false,
        );
    });
});

describe('RtpH265: the video codecs an SDP names', () => {
    it('reads the rtpmap lines at the video clock, once each, upper-cased', () => {
        const sdp =
            'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n' +
            'm=video 9 UDP/TLS/RTP/SAVPF 97 96\r\na=rtpmap:97 H265/90000\r\n' +
            'a=rtpmap:96 h264/90000\r\na=rtpmap:98 rtx/90000\r\na=rtpmap:97 H265/90000\r\n';
        expect(sdpVideoCodecs(sdp)).toEqual(['H265', 'H264', 'RTX']);
        expect(sdpVideoCodecs('')).toEqual([]);
        expect(sdpVideoCodecs(undefined)).toEqual([]);
    });
});
