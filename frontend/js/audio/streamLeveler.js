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
 * Even out the sound (LOLA, 2026-11-27): one game, emulator or program after
 * another at about one loudness, with NOTHING added to the time the sound
 * takes to reach the speakers.
 *
 * The sound plays exactly as it does without this: the RTP track on the
 * view's own <audio> element, the WSS pipeline through its own gain. The
 * leveler only listens, on the side — an AnalyserNode fed from the same track
 * (a MediaStreamAudioSourceNode in a context of its own, connected to nothing
 * that plays) or from the pipeline's worklet node — and turns the volume that
 * is already there down, on the element (`volume`) or the pipeline's gain.
 * Measured 2026-11-27, headless Chromium 159, an Opus track over a loopback
 * PeerConnection: with the tap, the receiver's jitter buffer delay (32.5 ms)
 * and Chrome's playout delay (26.1 ms) were what they were without it.
 * Routing the track through Web Audio to the speakers instead would put its
 * sound on another output path (that context's base + output latency, 5.3 +
 * 16 ms there, and the source node's own buffer), so that is not done.
 *
 * Down only: an element's volume stops at 1, so a game louder than TARGET_DB
 * is brought down to it (by MAX_DOWN_DB at most) and a quieter one plays as it
 * would. The level is the sound's power, measured ten times a second and
 * averaged over about LEVEL_SECONDS; a tenth of a second quieter than
 * SILENT_DB isn't counted (a pause doesn't move it). The volume follows
 * slowly (GLIDE_SECONDS), so it never pumps on a single loud moment.
 *
 * Desktop only, as the header's volume control is: iOS doesn't let a page set
 * an element's volume, and a Web Audio stage on the remote stream there froze
 * the video decode (iosAudioUnlock). When anything is missing — no Web Audio,
 * a context the browser keeps suspended, a tap that hears nothing — the gain
 * stays 1 and the sound is exactly as it was.
 */

const KEY = 'mw_stream_level';
export const TARGET_DB = -20;
export const SILENT_DB = -55;
export const LEVEL_SECONDS = 3;
export const GLIDE_SECONDS = 1.2;
export const MAX_DOWN_DB = 15;
export const TICK_MS = 100;

/** @param {number} db */
export const dbToGain = (db) => Math.pow(10, db / 20);
/** @param {number} p mean square @returns {number} dBFS */
export const powerDb = (p) => 10 * Math.log10(Math.max(p, 1e-12));

/** Whether evening out is on (on until said otherwise, kept in this browser). */
export function isOn() {
    try {
        return localStorage.getItem(KEY) !== 'off';
    } catch {
        return true;
    }
}

/** @param {boolean} on */
export function setOn(on) {
    try {
        localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
        /* this page only */
    }
}

/**
 * One tick of the leveler, pure: the averaged power after this block, and the
 * gain the volume heads for.
 * @param {{power: number, gain: number}} state
 * @param {number} blockPower mean square of the last block heard
 * @param {boolean} on
 * @returns {{power: number, gain: number}}
 */
export function step(state, blockPower, on) {
    let power = state.power;
    if (powerDb(blockPower) >= SILENT_DB) {
        const a = TICK_MS / 1000 / LEVEL_SECONDS;
        power = power > 0 ? power + (blockPower - power) * a : blockPower;
    }
    const want =
        !on || !(power > 0)
            ? 1
            : Math.max(dbToGain(-MAX_DOWN_DB), Math.min(1, dbToGain(TARGET_DB - powerDb(power))));
    const k = 1 - Math.exp(-(TICK_MS / 1000) / GLIDE_SECONDS);
    const gain = state.gain + (want - state.gain) * k;
    return { power, gain: Math.abs(gain - want) < 1e-4 ? want : gain };
}

// The volume carried from one view to the next (a quality or transport switch
// replaces the StreamView mid-session; the game is as loud as it was).
let carried = { power: 0, gain: 1 };

export class StreamLeveler {
    /**
     * @param {object} opts
     * @param {() => void} opts.onGain called when gain() moved enough to matter
     * @param {() => AudioContext} [opts.makeContext] for tests
     */
    constructor({ onGain, makeContext } = /** @type {any} */ ({})) {
        this._onGain = typeof onGain === 'function' ? onGain : () => {};
        this._make =
            makeContext || (() => new (window.AudioContext || window.webkitAudioContext)());
        /** @type {AudioContext|null} our own context (RTP path) */
        this._own = null;
        /** @type {AnalyserNode|null} */
        this._meter = null;
        /** @type {AudioNode|null} what feeds the meter */
        this._src = null;
        /** @type {Float32Array<ArrayBuffer>|null} */
        this._buf = null;
        this._state = { ...carried };
        this._applied = this._state.gain;
        this._timer = null;
        this._wake = null;
    }

    /** The factor to put on the volume, 1 when off or not listening. */
    gain() {
        return isOn() ? this._state.gain : 1;
    }

    /**
     * Listen to an RTP track's stream (it keeps playing on its element).
     * @param {MediaStream} stream
     */
    attachStream(stream) {
        this._detach();
        try {
            const ctx = this._make();
            this._own = ctx;
            this._src = ctx.createMediaStreamSource(stream);
            this._listen(ctx);
            if (ctx.state !== 'running') this._resumeOnGesture(ctx);
        } catch {
            this._detach();
        }
    }

    /**
     * Listen to the WSS pipeline's node, in its own context.
     * @param {AudioNode} node
     */
    attachNode(node) {
        this._detach();
        try {
            this._src = node;
            this._listen(node.context);
        } catch {
            this._detach();
        }
    }

    /** @param {BaseAudioContext} ctx */
    _listen(ctx) {
        const meter = ctx.createAnalyser();
        meter.fftSize = 2048;
        this._src.connect(meter);
        this._meter = meter;
        this._buf = new Float32Array(meter.fftSize);
        this._timer = setInterval(() => this._tick(), TICK_MS);
    }

    _tick() {
        const m = this._meter;
        if (!m || !this._buf || m.context.state !== 'running') return;
        m.getFloatTimeDomainData(this._buf);
        let sum = 0;
        for (let i = 0; i < this._buf.length; i++) sum += this._buf[i] * this._buf[i];
        this._state = step(this._state, sum / this._buf.length, isOn());
        carried = { ...this._state };
        if (Math.abs(this.gain() - this._applied) > 0.003) {
            this._applied = this.gain();
            this._onGain();
        }
    }

    /** The switch: on or off, now. */
    changed() {
        if (!isOn()) this._state = { ...this._state, gain: 1 };
        carried = { ...this._state };
        this._applied = this.gain();
        this._onGain();
    }

    /** A context the browser started suspended: resumed at the next gesture. @param {AudioContext} ctx */
    _resumeOnGesture(ctx) {
        const wake = () => {
            if (ctx.state === 'closed') return;
            ctx.resume().catch(() => {});
        };
        this._wake = wake;
        for (const ev of ['pointerdown', 'keydown'])
            window.addEventListener(ev, wake, { capture: true, passive: true });
    }

    _detach() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        if (this._wake) {
            for (const ev of ['pointerdown', 'keydown'])
                window.removeEventListener(ev, this._wake, { capture: true });
            this._wake = null;
        }
        try {
            if (this._src && this._meter) this._src.disconnect(this._meter);
        } catch {
            /* gone already */
        }
        this._src = null;
        this._meter = null;
        if (this._own) {
            this._own.close().catch(() => {});
            this._own = null;
        }
    }

    close() {
        this._detach();
    }
}
