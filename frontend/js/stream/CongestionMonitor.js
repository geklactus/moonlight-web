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
 * CongestionMonitor — decides when the stream is congested enough to step the
 * quality ladder, from the signals StreamView sees.
 *
 * One loss, one event. A single lost frame used to reach the ladder as several
 * events: the frame-gap IDR request, the transport's own IDR request for the
 * same frame (dc:), a reference-invalid retry every second until the keyframe
 * landed, and the backend's drop batch — four in a few seconds, a ladder step
 * for one loss. An episode opens with the first counted signal and closes on
 * the next keyframe, or after EPISODE_MS if none comes; whatever arrives inside
 * it is the same loss and is not counted again. A link that keeps losing still
 * opens a new episode every few seconds, so sustained congestion is still seen.
 *
 * Receiver PLIs (media transport) count only when the same poll saw real loss
 * or frozen time, at the bars LOLA's judge uses for a struggling network: 1 %
 * of packets lost, or 3 % of the time frozen. Before this, every outside
 * detection fired on PLIs at a median packet loss of 0 % (review, 23/11/2026).
 *
 * Decoder strain (the decode queue overflowing, or stalling until the decoder
 * is reset) is this device's limit, not the link's: a lower bitrate does not
 * make a slow decoder faster. It has its own counter and reports through
 * `deviceStrained`, never `congested`.
 */

/** Sliding window the events are counted over. */
export const WINDOW_MS = 20000;
/** Events in the window that make a detection. */
export const THRESHOLD = 4;
/** Minimum time between two detections. */
export const COOLDOWN_MS = 15000;
/** How long an episode stays open when no keyframe closes it. */
export const EPISODE_MS = 3000;
/** Packet loss over one stats poll that makes a PLI count (LOLA judge: LOSS_MAX). */
export const LOSS_MIN = 0.01;
/** Share of one stats poll spent frozen that makes a PLI count (LOLA judge: FROZEN_MAX). */
export const FROZEN_MIN = 0.03;

const DEVICE_REASONS = new Set(['decode queue overflow', 'decode queue stalled']);

/**
 * Whether an IDR request's reason is this device's decoder falling behind.
 * @param {string} reason
 */
export function isDeviceReason(reason) {
    return DEVICE_REASONS.has(reason);
}

/**
 * Loss and frozen-time shares between two inbound-rtp video stats reports.
 * @param {{packetsLost?: number, packetsReceived?: number, totalFreezesDuration?: number} | null} prev
 * @param {{packetsLost?: number, packetsReceived?: number, totalFreezesDuration?: number}} cur
 * @param {number} seconds time between the two reports
 * @returns {{lossFraction: number, frozenFraction: number}}
 */
export function lossEvidence(prev, cur, seconds) {
    if (!prev || !(seconds > 0)) return { lossFraction: 0, frozenFraction: 0 };
    const lost = Math.max(0, (cur.packetsLost || 0) - (prev.packetsLost || 0));
    const received = Math.max(0, (cur.packetsReceived || 0) - (prev.packetsReceived || 0));
    const frozen = Math.max(0, (cur.totalFreezesDuration || 0) - (prev.totalFreezesDuration || 0));
    return {
        lossFraction: lost + received > 0 ? lost / (lost + received) : 0,
        frozenFraction: Math.min(1, frozen / seconds),
    };
}

class Counter {
    constructor() {
        this.firedAt = -Infinity;
        this.reset();
    }

    reset() {
        /** @type {number[]} */
        this.events = [];
        this.episodeUntil = -Infinity;
    }

    /**
     * @param {number} now
     * @returns {{counted: boolean, fired: boolean}}
     */
    add(now) {
        if (now < this.episodeUntil) return { counted: false, fired: false };
        this.episodeUntil = now + EPISODE_MS;
        this.events.push(now);
        while (this.events.length > 0 && now - this.events[0] > WINDOW_MS) this.events.shift();
        if (this.events.length >= THRESHOLD && now - this.firedAt > COOLDOWN_MS) {
            this.firedAt = now;
            this.events.length = 0;
            return { counted: true, fired: true };
        }
        return { counted: true, fired: false };
    }
}

export class CongestionMonitor {
    constructor() {
        this._link = new Counter();
        this._device = new Counter();
    }

    /** Forget what was counted (back from the background, a new stream). */
    reset() {
        this._link.reset();
        this._device.reset();
    }

    /** A keyframe reached the decoder: the loss it answered is over. */
    keyframe() {
        this._link.episodeUntil = -Infinity;
        this._device.episodeUntil = -Infinity;
    }

    /**
     * Record one signal.
     *
     * - `idr`: an IDR request sent for a lost or broken reference (sv: or dc:).
     * - `drops`: a batch of backend backpressure drops.
     * - `pli`: receiver PLIs from a stats poll; needs `evidence` from that poll.
     * - `device`: the decoder falling behind (see isDeviceReason).
     *
     * @param {'idr'|'drops'|'pli'|'device'} kind
     * @param {number} now ms, monotonic
     * @param {{lossFraction: number, frozenFraction: number}} [evidence]
     * @returns {{counted: boolean, congested: boolean, deviceStrained: boolean}}
     */
    record(kind, now, evidence) {
        if (kind === 'device') {
            const r = this._device.add(now);
            return { counted: r.counted, congested: false, deviceStrained: r.fired };
        }
        if (kind === 'pli') {
            const loss = evidence ? evidence.lossFraction : 0;
            const frozen = evidence ? evidence.frozenFraction : 0;
            if (loss < LOSS_MIN && frozen < FROZEN_MIN) {
                return { counted: false, congested: false, deviceStrained: false };
            }
        }
        const r = this._link.add(now);
        return { counted: r.counted, congested: r.fired, deviceStrained: false };
    }
}

/**
 * How far back EncoderRate looks. Shorter than WINDOW_MS: a game resumed
 * after a pause should count at its new size within seconds, not after
 * twenty seconds of a still screen have left the average.
 */
export const RATE_WINDOW_MS = 10000;
/** Frames the estimate needs in its window before it says anything. */
export const RATE_MIN_FRAMES = 30;

/**
 * What the host's encoder is sending, estimated from the frames that arrive:
 * their mean size over the last RATE_WINDOW_MS, times the stream's frame rate.
 *
 * Not the rate received: a link that stalls delivers nothing for a moment,
 * so the received rate falls to zero on a link that is full and on one that
 * is idle alike. The frames that do arrive are the size the encoder made
 * them either way. A still screen is sent as frames of a few dozen bytes; on
 * 24/11/2026 a Switch game left paused on LOLA's Wolf seat came in at
 * 0.02 Mbit/s against its 20 Mbit/s cap, and two link stalls then stepped
 * that stream down a rung that could not lower anything.
 *
 * Kept as one-second buckets, so a frame costs an addition. When the link
 * is so slow that fewer than RATE_MIN_FRAMES arrive in the window, it says
 * nothing (null), and the ladder steps as it always did.
 */
export class EncoderRate {
    constructor() {
        /** @type {{s: number, bytes: number, frames: number}[]} */
        this._buckets = [];
    }

    /** Forget what was measured (a new stream). */
    reset() {
        this._buckets.length = 0;
    }

    /**
     * @param {number} bytes video payload that arrived
     * @param {number} frames how many frames it made
     * @param {number} now ms, monotonic
     */
    note(bytes, frames, now) {
        if (!(bytes >= 0) || !(frames > 0)) return;
        const s = Math.floor(now / 1000);
        const last = this._buckets[this._buckets.length - 1];
        if (last && last.s === s) {
            last.bytes += bytes;
            last.frames += frames;
        } else {
            this._buckets.push({ s, bytes, frames });
        }
        this._prune(now);
    }

    /**
     * @param {number} now ms, monotonic
     * @param {number} fps the stream's frame rate
     * @returns {number|null} kbps, or null when too few frames came to tell
     */
    kbps(now, fps) {
        this._prune(now);
        let bytes = 0;
        let frames = 0;
        for (const b of this._buckets) {
            bytes += b.bytes;
            frames += b.frames;
        }
        if (frames < RATE_MIN_FRAMES || !(fps > 0)) return null;
        return Math.round(((bytes / frames) * 8 * fps) / 1000);
    }

    _prune(now) {
        const oldest = Math.floor((now - RATE_WINDOW_MS) / 1000);
        while (this._buckets.length > 0 && this._buckets[0].s < oldest) this._buckets.shift();
    }
}
