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
