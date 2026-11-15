/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * The speaker's registers and its decoder follow Dolphin's emulated Wii Remote
 * (Source/Core/Core/HW/WiimoteEmu/Speaker.cpp and Speaker.h, Copyright 2010 and
 * 2019 Dolphin Emulator Project, GPL-2.0-or-later), whose Yamaha ADPCM decoder
 * is based on The ffmpeg Project's (Copyright (c) 2001-2003).
 */

/**
 * The Wii Remote's speaker, played by this page instead of by the remote.
 *
 * A game sends the remote its sound as speaker data reports (0x18), twenty
 * bytes about every 6.7 ms. A remote on a computer's Bluetooth plays them
 * badly — Dolphin's own notes say why (Speaker.h, WiimoteReal.cpp: the remote
 * buffers little and drops what comes unevenly) — and through a stream the
 * reports come more unevenly still. So the page keeps them: it follows what
 * the game wrote to the speaker (WiimoteSpeaker, the same registers and the
 * same decoder as Dolphin's emulated remote), turns the data into samples and
 * plays them on this computer (WiimoteSpeakerOutput), behind a short buffer
 * that evens the arrivals out. The real remote is sent everything but the
 * data, so it answers the game as before and stays silent.
 */

export const SPEAKER_ENABLE = 0x14;
export const WRITE_DATA = 0x16;
export const SPEAKER_DATA = 0x18;
export const SPEAKER_MUTE = 0x19;

const I2C_ADDR = 0x51;
const SAMPLE_RATE_DIVIDEND = 12000000;
// Games never set the volume above this (Speaker.cpp).
const VOLUME_FULL = 0x7f;

// Register addresses (Speaker.h, struct Register).
const REG_FLAGS = 0x01;
const REG_FORMAT = 0x02;
const REG_RATE = 0x03; // u16 LE
const REG_VOLUME = 0x05;
const REG_DECODER = 0x07;
const REG_PLAYBACK = 0x08;
const REG_INPUT = 0x09;

const SPEAKER_STOP_BIT = 0x01;
const SPEAKER_DISABLE_PLAYBACK_BIT = 0x80;
const DECODER_READY_FOR_DATA_BIT = 0x01;
const DECODER_RESET_BIT = 0x02;
const DECODER_DROPPED_DATA_BIT = 0x04;
const DECODER_PROCESSED_DATA_BIT = 0x08;

const YAMAHA_DIFF = [1, 3, 5, 7, 9, 11, 13, 15, -1, -3, -5, -7, -9, -11, -13, -15];
const YAMAHA_SCALE = [
    230, 230, 230, 230, 307, 409, 512, 614, 230, 230, 230, 230, 307, 409, 512, 614,
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * What the game wrote to one remote's speaker, and the samples its data makes.
 * Fed every output report the game sends that remote, as WebHID takes them:
 * the report id, then the bytes after it.
 */
export class WiimoteSpeaker {
    constructor() {
        this.reset();
    }

    /** A remote just connected: off, not muted, the decoder at rest. */
    reset() {
        this._reg = new Uint8Array(0x100);
        this._reg[REG_DECODER] = DECODER_READY_FOR_DATA_BIT;
        this._predictor = 0;
        this._step = 127;
        this._enabled = false;
        this._muted = false;
    }

    /** Samples a second of what the game is sending (12 MHz over its divisor). */
    get sampleRate() {
        // Real hardware seems to read 0 as 0xffff (Speaker.cpp).
        const divisor = this._reg[REG_RATE] | (this._reg[REG_RATE + 1] << 8) || 0xffff;
        return SAMPLE_RATE_DIVIDEND / divisor;
    }

    /** 0..1, full at the most a game sets. */
    get volume() {
        return Math.min(1, this._reg[REG_VOLUME] / VOLUME_FULL);
    }

    /**
     * One output report. Returns the samples to play (Int16Array, at
     * sampleRate and volume) for speaker data the remote would have played,
     * null for anything else.
     * @param {number} reportId
     * @param {Uint8Array} p the report without its id
     */
    output(reportId, p) {
        if (!p || p.length < 1) return null;
        switch (reportId) {
            case SPEAKER_ENABLE:
                this._enabled = (p[0] & 0x04) !== 0;
                return null;
            case SPEAKER_MUTE:
                this._muted = (p[0] & 0x04) !== 0;
                return null;
            case WRITE_DATA: {
                // [rumble, space][slave << 1][address, big endian][size][16 bytes]
                const space = (p[0] >> 2) & 0x03;
                const size = p[4];
                if (p.length < 5 || (space !== 1 && space !== 2) || p[1] >> 1 !== I2C_ADDR)
                    return null;
                // A real remote ignores such a size (EmuSubroutines.cpp).
                if (size === 0 || size > 16) return null;
                // The address's top byte is ignored on the bus.
                return this._busWrite(p[3], p.subarray(5, 5 + size));
            }
            case SPEAKER_DATA: {
                // [rumble, length << 3][20 bytes]: a write at the speaker's offset 0.
                const length = p[0] >> 3;
                if (length > 20) return null;
                return this._busWrite(0x00, p.subarray(1, 1 + length));
            }
            default:
                return null;
        }
    }

    _busWrite(addr, data) {
        // Writes while the speaker is off succeed and change nothing.
        if (!this._enabled) return null;
        if (addr === 0x00) return this._data(data);

        const reg = this._reg;
        // A write clears some of the decoder's flags rather than setting them.
        const prev = reg[REG_DECODER];
        reg[REG_DECODER] = 0;
        reg.set(data.subarray(0, Math.min(data.length, 0x100 - addr)), addr);
        const written = reg[REG_DECODER];
        reg[REG_DECODER] =
            prev & ~(written & (DECODER_DROPPED_DATA_BIT | DECODER_PROCESSED_DATA_BIT));
        if (written & DECODER_RESET_BIT) {
            this._predictor = 0;
            this._step = 127;
        }
        if (reg[REG_FLAGS] & SPEAKER_DISABLE_PLAYBACK_BIT) reg[REG_PLAYBACK] &= ~0x01;
        return null;
    }

    _data(data) {
        const reg = this._reg;
        if (reg[REG_FLAGS] & SPEAKER_STOP_BIT) return null;
        if (!(reg[REG_INPUT] & 0x01)) return null;

        let samples;
        switch (reg[REG_FORMAT] & 0xe0) {
            case 0x00: // 4-bit Yamaha ADPCM, the high half first: all that games use
                samples = new Int16Array(data.length * 2);
                for (let i = 0; i < data.length; i++) {
                    samples[2 * i] = this._expand(data[i] >> 4);
                    samples[2 * i + 1] = this._expand(data[i] & 0x0f);
                }
                break;
            case 0x40: // signed 8-bit PCM
                samples = new Int16Array(data.length);
                for (let i = 0; i < data.length; i++) samples[i] = ((data[i] << 24) >> 24) * 0x100;
                break;
            case 0x60: // signed 16-bit PCM, little endian
            case 0xe0:
                samples = new Int16Array(data.length >> 1);
                for (let i = 0; i < samples.length; i++)
                    samples[i] = data[2 * i] | (data[2 * i + 1] << 8);
                break;
            default:
                return null;
        }
        if (!samples.length) return null;
        reg[REG_DECODER] |= DECODER_PROCESSED_DATA_BIT;

        // Decoded all the same, so the decoder stays in step, but not heard.
        if (!(reg[REG_PLAYBACK] & 0x01)) return null;
        if (this._muted) return null;
        if (reg[REG_FORMAT] & 0x01) return null;
        return samples;
    }

    _expand(nibble) {
        this._predictor = clamp(
            this._predictor + Math.trunc((this._step * YAMAHA_DIFF[nibble]) / 8),
            -32768,
            32767,
        );
        this._step = clamp((this._step * YAMAHA_SCALE[nibble]) >> 8, 127, 24576);
        return this._predictor;
    }
}

// How far ahead of the clock a sound starts: what evens out reports that come
// in bursts. A report late by more than this leaves a gap, and the sound
// starts over this far ahead.
export const SPEAKER_LEAD_S = 0.1;
// More than this waiting to be played (reports arriving faster than they
// play) and the newest are dropped: the sound never trails the game by more.
export const SPEAKER_MAX_AHEAD_S = 0.4;
// A report this little late is a gap in a sound; later than that, a new sound.
const SPEAKER_GAP_S = 0.5;

/**
 * Plays the samples of the remotes' speakers on this computer: one voice a
 * remote, all on one AudioContext made at the first sound (the page has been
 * clicked by then, which the browser asks for before it lets sound out).
 */
export class WiimoteSpeakerOutput {
    /**
     * @param {object} [o]
     * @param {() => AudioContext} [o.makeContext]
     * @param {() => number} [o.level] the page's own volume, 0..1, read at each sound
     */
    constructor({
        makeContext = () => new globalThis.AudioContext({ latencyHint: 'interactive' }),
        level = () => 1,
    } = {}) {
        this._makeContext = makeContext;
        this._level = level;
        this._ctx = null;
        this._failed = false;
        /** Counts for diagnostics: reports played, sounds begun, gaps inside one, reports dropped. */
        this.stats = { played: 0, sounds: 0, gaps: 0, dropped: 0 };
    }

    /** A remote's own line of sound. */
    voice() {
        return new SpeakerVoice(this);
    }

    _context() {
        if (this._ctx || this._failed) return this._ctx;
        try {
            this._ctx = this._makeContext();
        } catch (err) {
            this._failed = true;
            console.warn('[HID] Wii Remote speaker: no audio:', err?.message || err);
        }
        return this._ctx;
    }

    /** The stream ended. */
    close() {
        const ctx = this._ctx;
        this._ctx = null;
        if (ctx && typeof ctx.close === 'function') Promise.resolve(ctx.close()).catch(() => {});
    }
}

class SpeakerVoice {
    constructor(out) {
        this._out = out;
        // When this voice's next sample plays, on the context's clock.
        this._next = -Infinity;
        this._phase = 0; // where the next output sample falls, in input samples
        this._prev = 0; // the last input sample of the report before
    }

    /**
     * @param {Int16Array} samples
     * @param {number} rate samples a second
     * @param {number} volume 0..1, the game's
     */
    push(samples, rate, volume) {
        const out = this._out;
        const ctx = out._context();
        if (!ctx || !samples.length || !(rate > 0)) return;
        if (ctx.state === 'suspended') Promise.resolve(ctx.resume()).catch(() => {});

        const now = ctx.currentTime;
        if (this._next < now) {
            // The first report of a sound, or one that came too late.
            if (now - this._next < SPEAKER_GAP_S) out.stats.gaps++;
            else out.stats.sounds++;
            this._next = now + SPEAKER_LEAD_S;
            this._phase = 0;
        } else if (this._next - now > SPEAKER_MAX_AHEAD_S) {
            out.stats.dropped++;
            return;
        }

        const data = this._resample(
            samples,
            rate / ctx.sampleRate,
            (volume * out._level()) / 32768,
        );
        if (!data.length) return;
        const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
        buffer.getChannelData(0).set(data);
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        node.start(this._next);
        this._next += data.length / ctx.sampleRate;
        out.stats.played++;
    }

    // To the context's rate, straight lines between samples, carried from one
    // report to the next so their joins make no click. `step` is input samples
    // an output sample.
    _resample(samples, step, scale) {
        const n = samples.length;
        const data = new Float32Array(Math.max(0, Math.ceil((n - 1 - this._phase) / step) + 1));
        let count = 0;
        let pos = this._phase;
        for (; pos <= n - 1; pos += step) {
            const i = Math.floor(pos);
            const a = i < 0 ? this._prev : samples[i];
            const b = i + 1 < n ? samples[i + 1] : samples[n - 1];
            data[count++] = (a + (b - a) * (pos - i)) * scale;
        }
        this._phase = pos - n;
        this._prev = samples[n - 1];
        return data.subarray(0, count);
    }
}
