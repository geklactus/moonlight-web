/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * H.265 on the media transport (webrtc-media): whether this browser's own
 * WebRTC decoder takes it, and in which profile.
 *
 * The media transport hands the RTP stream to the browser's RTCPeerConnection,
 * which decodes it into a <video> element — not to WebCodecs. Which codecs
 * that decoder takes is its own question: Chrome decoded HEVC in WebCodecs
 * long before it listed H265 in RTCRtpReceiver.getCapabilities, and Firefox
 * lists it nowhere. So the launch asks the receiver, and sends the host what
 * it said (`media_h265`, `media_h265_fmtp`); the host offers H.265 on the
 * track only then, with that very fmtp line — libwebrtc matches an H265 codec
 * on profile, tier and level, so an offer that differs on any of them is
 * answered with no codec at all. Without the word, the host offers H.264 as it
 * always did.
 *
 * Main profile only (profile-id=1, the default when the line names none):
 * HDR's Main10 and 4:4:4's RExt stay with the DataChannel transports, where
 * the page decodes and tone-maps the picture itself.
 *
 * Where it failed after all — an H.265 the browser listed but never decoded a
 * frame of — the verdict is kept for this browser version (rtpH265FailedHere),
 * for RTP_H265_FAILED_DAYS, and the media transport carries H.264 meanwhile.
 */

/** What may go into the host's SDP offer as the fmtp line, and nothing else. */
const FMTP_RE = /^[A-Za-z0-9-]+=[A-Za-z0-9-]+(?:;[A-Za-z0-9-]+=[A-Za-z0-9-]+)*$/;

/** The browsers whose H.265 RTP decoder failed: user agent → when (ms). */
const RTP_H265_FAILED_KEY = 'mw_rtp_h265_failed';

/** How long such a verdict holds. Past it, the media track is offered H.265 again. */
export const RTP_H265_FAILED_DAYS = 30;
const RTP_H265_FAILED_MS = RTP_H265_FAILED_DAYS * 24 * 3600 * 1000;

/** localStorage, or null where reading it throws (sandboxed frame, privacy mode). */
function store() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (e) {
        return null;
    }
}

function userAgent() {
    try {
        return typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    } catch (e) {
        return '';
    }
}

/** The receiver's video capabilities, or null where the API is missing or throws. */
function receiverVideoCapabilities() {
    try {
        if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return null;
        return RTCRtpReceiver.getCapabilities('video');
    } catch (e) {
        return null;
    }
}

/** The `profile-id` of an H.265 fmtp line; 1 (Main) when it names none. */
function profileId(fmtp) {
    const m = /(?:^|;)profile-id=(\d+)(?:;|$)/.exec(fmtp || '');
    return m ? Number(m[1]) : 1;
}

/**
 * The H.265 Main-profile entry of this browser's RTP video receiver, as
 * {fmtp}: the line the host repeats in its offer ('' when the receiver lists
 * none, which libwebrtc reads as Main, tier 0, level 3.1). Null where the
 * receiver lists no H.265, lists it in other profiles only, or lists a line
 * that could not go into an SDP as it is.
 * @param {RTCRtpCapabilities|null} [caps] RTCRtpReceiver.getCapabilities('video')
 * @returns {{fmtp: string}|null}
 */
export function rtpH265Capability(caps = receiverVideoCapabilities()) {
    const codecs = caps && Array.isArray(caps.codecs) ? caps.codecs : [];
    for (const c of codecs) {
        if (!c || String(c.mimeType || '').toLowerCase() !== 'video/h265') continue;
        const fmtp = typeof c.sdpFmtpLine === 'string' ? c.sdpFmtpLine.trim() : '';
        if (fmtp && !FMTP_RE.test(fmtp)) continue;
        if (profileId(fmtp) !== 1) continue;
        return { fmtp };
    }
    return null;
}

/** The kept verdicts, or {} where the store cannot be read. */
function verdicts(s) {
    try {
        const kept = s && JSON.parse(s.getItem(RTP_H265_FAILED_KEY) || '{}');
        return kept && typeof kept === 'object' ? kept : {};
    } catch (e) {
        return {};
    }
}

/**
 * Whether this browser's H.265 RTP decoder was seen failing: it listed the
 * codec, the host offered it, and no frame ever came out (noteRtpH265Failed).
 * Kept under the user agent, so a new version of the browser is asked again,
 * and for RTP_H265_FAILED_DAYS at most. A clock set back reads as no verdict.
 * @param {string} [ua]
 * @param {Storage|null} [s]
 * @param {number} [now]
 */
export function rtpH265FailedHere(ua = userAgent(), s = store(), now = Date.now()) {
    const seen = verdicts(s)[ua];
    return typeof seen === 'number' && now >= seen && now - seen < RTP_H265_FAILED_MS;
}

/**
 * Remember it (rtpH265FailedHere), dropping the verdicts past their time.
 * Nothing is kept where the store cannot be written.
 * @param {string} [ua]
 * @param {Storage|null} [s]
 * @param {number} [now]
 */
export function noteRtpH265Failed(ua = userAgent(), s = store(), now = Date.now()) {
    if (!s) return;
    try {
        const kept = {};
        for (const [k, seen] of Object.entries(verdicts(s))) {
            if (typeof seen === 'number' && now >= seen && now - seen < RTP_H265_FAILED_MS)
                kept[k] = seen;
        }
        kept[ua] = now;
        s.setItem(RTP_H265_FAILED_KEY, JSON.stringify(kept));
    } catch (e) {
        // Not kept: the host is told again next time, and the stream falls back again.
    }
}

/**
 * What /start (and a guest's join) says about this browser's RTP decoder:
 * `media_h265: true` with the receiver's fmtp line in `media_h265_fmtp`, or
 * nothing at all — a browser without the codec, one whose H.265 failed here
 * (rtpH265FailedHere), or one that lists it in another profile only. An
 * older host ignores both keys.
 * @param {{cap?: {fmtp: string}|null, failed?: boolean}} [over] for the tests
 * @returns {{media_h265?: true, media_h265_fmtp?: string}}
 */
export function rtpH265RequestFields(over = {}) {
    const cap = over.cap !== undefined ? over.cap : rtpH265Capability();
    const failed = over.failed !== undefined ? over.failed : rtpH265FailedHere();
    if (!cap || failed) return {};
    return { media_h265: true, media_h265_fmtp: cap.fmtp };
}

/**
 * The video codecs an SDP names on its a=rtpmap lines, upper-cased ('H264',
 * 'H265'…), in the order of the lines.
 * @param {string} sdp
 * @returns {string[]}
 */
export function sdpVideoCodecs(sdp) {
    const out = [];
    const re = /^a=rtpmap:\d+\s+([A-Za-z0-9-]+)\/90000/gim;
    let m;
    while ((m = re.exec(sdp || '')) !== null) {
        const name = m[1].toUpperCase();
        if (!out.includes(name)) out.push(name);
    }
    return out;
}
