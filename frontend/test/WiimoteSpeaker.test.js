import { describe, expect, it, vi } from 'vitest';
import {
    SPEAKER_LEAD_S,
    SPEAKER_MAX_AHEAD_S,
    WiimoteSpeaker,
    WiimoteSpeakerOutput,
} from '../js/hid/wiimoteSpeaker.js';

// Forty random bytes and what Dolphin's own decoder makes of them from rest
// (adpcm_yamaha_expand_nibble as it stands in Speaker.cpp, compiled apart).
const BYTES = [
    117, 205, 37, 75, 132, 226, 234, 242, 166, 129, 32, 103, 67, 52, 178, 110, 75, 226, 153, 84,
    115, 118, 127, 241, 204, 117, 153, 141, 30, 171, 206, 219, 151, 57, 101, 110, 202, 152, 195,
    113,
];
const SAMPLES = [
    238, 656, 111, -687, -107, 1038, 2534, 1140, 961, 2407, -98, 1829, -2672, -6134, -15465, -8005,
    -14707, 948, -1460, 5031, 14751, 16497, 32767, 32767, 32767, 32767, 32767, 32767, 11953, 25310,
    32767, -7169, 20479, -1025, -32768, -17408, -25688, -32768, -8263, 19385, 32767, 32767, 32767,
    32767, 32767, -13313, -32768, -23552, -32768, -32768, 13312, 32767, 23551, 15271, 12792, -11713,
    -2497, -32768, -32768, -32768, -32768, -32768, -32768, -32768, -32768, 4426, 25930, 17650,
    32767, 32767, 32767, -7169, -32768, -32768, -32768, -32768, -32768, -14068, 21933, 31149,
];

const u8 = (...b) => Uint8Array.from(b);
/** A write to the speaker's registers (report 0x16), as the game sends it. */
const write = (addr, ...data) => [
    0x16,
    u8(0x04, 0xa2, 0x00, addr, data.length, ...data, ...new Array(16 - data.length).fill(0)),
];
/** A speaker data report (0x18): its length, then twenty bytes. */
const data = (bytes, rumble = 0) => [
    0x18,
    u8((bytes.length << 3) | rumble, ...bytes, ...new Array(20 - bytes.length).fill(0)),
];

/** What a game sends to turn the speaker on (the values Dolphin's Speaker.h notes). */
function turnOn(s, { format = 0x00, rate = [0xd0, 0x07], volume = 0x40 } = {}) {
    s.output(0x14, u8(0x04)); // speaker on
    s.output(0x19, u8(0x04)); // muted while it is set up
    s.output(...write(0x09, 0x01)); // takes data
    s.output(...write(0x01, 0x80));
    s.output(...write(0x01, 0x00, format, ...rate, volume, 0x0c, 0x0e));
    s.output(...write(0x08, 0x01)); // plays
    s.output(0x19, u8(0x00)); // unmuted
}

describe('WiimoteSpeaker — what the game set the speaker to, and its samples', () => {
    it('decodes speaker data as Dolphin does', () => {
        const s = new WiimoteSpeaker();
        turnOn(s);
        expect(Array.from(s.output(...data(BYTES.slice(0, 20))))).toEqual(SAMPLES.slice(0, 40));
        // The decoder carries on from one report to the next.
        expect(Array.from(s.output(...data(BYTES.slice(20))))).toEqual(SAMPLES.slice(40));
        expect(s.sampleRate).toBe(6000); // 12 MHz over 0x07d0
        expect(s.volume).toBeCloseTo(0x40 / 0x7f);
    });

    it('stays with Dolphin over fifty thousand bytes', () => {
        const s = new WiimoteSpeaker();
        turnOn(s);
        let x = 0x12345678;
        let sum = 0;
        for (let i = 0; i < 2500; i++) {
            const bytes = [];
            for (let j = 0; j < 20; j++) {
                x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
                bytes.push(x >>> 24);
            }
            for (const v of s.output(...data(bytes))) {
                sum = (sum * 31 + v) % 1000000007;
                if (sum < 0) sum += 1000000007;
            }
        }
        expect(sum).toBe(184232609); // the same run through Dolphin's decoder
    });

    it('plays nothing before the game turned the speaker on', () => {
        const s = new WiimoteSpeaker();
        expect(s.output(...data(BYTES.slice(0, 20)))).toBeNull();
        // Writes to a speaker that is off change nothing.
        s.output(...write(0x09, 0x01));
        s.output(...write(0x01, 0x00, 0x00, 0xd0, 0x07, 0x40, 0x0c, 0x0e));
        s.output(...write(0x08, 0x01));
        s.output(0x14, u8(0x04));
        expect(s.output(...data(BYTES.slice(0, 20)))).toBeNull();
    });

    it('decodes muted data without playing it, so the decoder stays in step', () => {
        const s = new WiimoteSpeaker();
        turnOn(s);
        s.output(0x19, u8(0x04));
        expect(s.output(...data(BYTES.slice(0, 20)))).toBeNull();
        s.output(0x19, u8(0x00));
        expect(Array.from(s.output(...data(BYTES.slice(20))))).toEqual(SAMPLES.slice(40));
    });

    it('starts the decoder over when the game resets it', () => {
        const s = new WiimoteSpeaker();
        turnOn(s);
        s.output(...data(BYTES.slice(20)));
        s.output(...write(0x07, 0x0e));
        expect(Array.from(s.output(...data(BYTES.slice(0, 20))))).toEqual(SAMPLES.slice(0, 40));
    });

    it('takes only as many bytes as the report says it holds', () => {
        const s = new WiimoteSpeaker();
        turnOn(s);
        expect(Array.from(s.output(...data(BYTES.slice(0, 7))))).toEqual(SAMPLES.slice(0, 14));
    });

    it('stops at the stop bit, at the speaker turned off, and with playback off', () => {
        const stopped = new WiimoteSpeaker();
        turnOn(stopped);
        stopped.output(...write(0x01, 0x01));
        expect(stopped.output(...data(BYTES.slice(0, 20)))).toBeNull();

        const off = new WiimoteSpeaker();
        turnOn(off);
        off.output(0x14, u8(0x00));
        expect(off.output(...data(BYTES.slice(0, 20)))).toBeNull();

        const paused = new WiimoteSpeaker();
        turnOn(paused);
        paused.output(...write(0x01, 0x80)); // clears "plays"
        paused.output(...write(0x01, 0x00));
        expect(paused.output(...data(BYTES.slice(0, 20)))).toBeNull();
        paused.output(...write(0x08, 0x01));
        expect(paused.output(...data(BYTES.slice(0, 20)))).not.toBeNull();
    });

    it('reads signed 8-bit sound and another rate', () => {
        const s = new WiimoteSpeaker();
        turnOn(s, { format: 0x40, rate: [0xe8, 0x03], volume: 0xff });
        expect(Array.from(s.output(...data([0x00, 0x7f, 0x80, 0xff])))).toEqual([
            0, 0x7f00, -0x8000, -0x100,
        ]);
        expect(s.sampleRate).toBe(12000);
        expect(s.volume).toBe(1); // never above full
    });

    it('leaves writes to the remote’s other parts alone', () => {
        const s = new WiimoteSpeaker();
        turnOn(s);
        // The extension (0xa4) and the remote's own memory, at the speaker's addresses.
        s.output(0x16, u8(0x04, 0xa4, 0x00, 0x01, 1, 0x01, ...new Array(15).fill(0)));
        s.output(0x16, u8(0x00, 0xa2, 0x00, 0x01, 1, 0x01, ...new Array(15).fill(0)));
        s.output(0x16, u8(0x04, 0xa2, 0x00, 0x01, 17, 0x01, ...new Array(15).fill(0)));
        s.output(0x11, u8(0x10));
        expect(s.output(...data(BYTES.slice(0, 20)))).not.toBeNull();
    });
});

/** An AudioContext that only records what it was asked to play. */
function fakeContext({ sampleRate = 48000, state = 'running' } = {}) {
    const ctx = {
        sampleRate,
        state,
        currentTime: 0,
        destination: {},
        played: [],
        resume: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        createBuffer: (channels, length, rate) => {
            const samples = new Float32Array(length);
            return { channels, length, rate, getChannelData: () => samples };
        },
        createBufferSource: () => {
            const node = {
                buffer: null,
                connect: vi.fn(),
                start: (when) =>
                    ctx.played.push({ when, samples: node.buffer.getChannelData(0), node }),
            };
            return node;
        },
    };
    return ctx;
}

describe('WiimoteSpeakerOutput — the samples, played on this computer', () => {
    const ramp = (from, n) => Int16Array.from({ length: n }, (_, i) => from + i * 100);

    it('starts a sound a little ahead and plays its reports end to end', () => {
        const ctx = fakeContext();
        const out = new WiimoteSpeakerOutput({ makeContext: () => ctx });
        const voice = out.voice();
        ctx.currentTime = 2;
        voice.push(ramp(0, 40), 6000, 1);
        voice.push(ramp(4000, 40), 6000, 1);
        voice.push(ramp(8000, 40), 6000, 1);
        expect(ctx.played).toHaveLength(3);
        expect(ctx.played[0].when).toBeCloseTo(2 + SPEAKER_LEAD_S);
        // Forty samples at 6 kHz are 6.67 ms: 320 samples of a 48 kHz output.
        const total = ctx.played.reduce((n, p) => n + p.samples.length, 0);
        expect(total).toBeGreaterThanOrEqual(953);
        expect(total).toBeLessThanOrEqual(960);
        let at = ctx.played[0].when;
        for (const p of ctx.played) {
            expect(p.when).toBeCloseTo(at, 9);
            at += p.samples.length / 48000;
            expect(p.node.connect).toHaveBeenCalledWith(ctx.destination);
        }
        expect(out.stats).toEqual({ played: 3, sounds: 1, gaps: 0, dropped: 0 });
    });

    it('joins one report to the next without a step', () => {
        const ctx = fakeContext({ sampleRate: 44100 }); // not a whole multiple of 6 kHz
        const voice = new WiimoteSpeakerOutput({ makeContext: () => ctx }).voice();
        voice.push(ramp(0, 40), 6000, 1);
        voice.push(ramp(4000, 40), 6000, 1);
        const all = ctx.played.flatMap((p) => Array.from(p.samples));
        // A straight ramp in is a straight ramp out, across the join too.
        const slope = (100 * 6000) / 44100 / 32768;
        for (let i = 1; i < all.length; i++) expect(all[i] - all[i - 1]).toBeCloseTo(slope, 6);
        expect(all[0]).toBe(0);
        expect(all.length).toBe(Math.floor((79 * 44100) / 6000) + 1);
    });

    it('applies the game’s volume and the page’s own', () => {
        const ctx = fakeContext();
        let level = 0.5;
        const voice = new WiimoteSpeakerOutput({
            makeContext: () => ctx,
            level: () => level,
        }).voice();
        voice.push(Int16Array.from([16384, 16384]), 48000, 0.5);
        expect(ctx.played[0].samples[0]).toBeCloseTo(0.125);
        level = 0; // muted on the page
        voice.push(Int16Array.from([16384, 16384]), 48000, 0.5);
        expect(ctx.played[1].samples[0]).toBe(0);
    });

    it('starts over after a report that came too late, and counts the gap', () => {
        const ctx = fakeContext();
        const out = new WiimoteSpeakerOutput({ makeContext: () => ctx });
        const voice = out.voice();
        voice.push(ramp(0, 40), 6000, 1);
        ctx.currentTime = SPEAKER_LEAD_S + 0.05; // the first report is over, nothing queued
        voice.push(ramp(0, 40), 6000, 1);
        expect(ctx.played[1].when).toBeCloseTo(ctx.currentTime + SPEAKER_LEAD_S);
        expect(out.stats).toMatchObject({ sounds: 1, gaps: 1 });
        ctx.currentTime += 5; // long after: another sound, not a gap
        voice.push(ramp(0, 40), 6000, 1);
        expect(out.stats).toMatchObject({ played: 3, sounds: 2, gaps: 1 });
    });

    it('drops what would trail the game too far', () => {
        const ctx = fakeContext();
        const out = new WiimoteSpeakerOutput({ makeContext: () => ctx });
        const voice = out.voice();
        // The clock stands still: every report queues behind the last.
        for (let i = 0; i < 100; i++) voice.push(ramp(0, 40), 6000, 1);
        const last = ctx.played[ctx.played.length - 1];
        expect(last.when).toBeLessThanOrEqual(SPEAKER_MAX_AHEAD_S + 1e-9);
        expect(out.stats.dropped).toBe(100 - ctx.played.length);
        expect(out.stats.dropped).toBeGreaterThan(0);
    });

    it('keeps each remote on its own line', () => {
        const ctx = fakeContext();
        const out = new WiimoteSpeakerOutput({ makeContext: () => ctx });
        const a = out.voice();
        const b = out.voice();
        a.push(ramp(0, 40), 6000, 1);
        a.push(ramp(0, 40), 6000, 1);
        b.push(ramp(0, 40), 6000, 1);
        expect(ctx.played[2].when).toBeCloseTo(SPEAKER_LEAD_S); // not behind the other's
    });

    it('wakes a suspended context, and makes the context only when a sound comes', () => {
        const ctx = fakeContext({ state: 'suspended' });
        const makeContext = vi.fn(() => ctx);
        const out = new WiimoteSpeakerOutput({ makeContext });
        const voice = out.voice();
        expect(makeContext).not.toHaveBeenCalled();
        voice.push(ramp(0, 40), 6000, 1);
        voice.push(ramp(0, 40), 6000, 1);
        expect(makeContext).toHaveBeenCalledTimes(1);
        expect(ctx.resume).toHaveBeenCalled();
        out.close();
        expect(ctx.close).toHaveBeenCalledTimes(1);
    });

    it('stays quiet, and says so once, where no sound can be made', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const makeContext = vi.fn(() => {
            throw new Error('NotSupportedError');
        });
        const voice = new WiimoteSpeakerOutput({ makeContext }).voice();
        voice.push(ramp(0, 40), 6000, 1);
        voice.push(ramp(0, 40), 6000, 1);
        expect(makeContext).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});

describe('a tone, from the game’s bytes to this computer’s samples', () => {
    // The encoder a game's sound was made with (ffmpeg's Yamaha ADPCM), to have
    // bytes that mean something.
    function encode(samples) {
        const DIFF = [1, 3, 5, 7, 9, 11, 13, 15, -1, -3, -5, -7, -9, -11, -13, -15];
        const SCALE = [230, 230, 230, 230, 307, 409, 512, 614];
        let predictor = 0;
        let step = 127;
        const nibble = (sample) => {
            const delta = sample - predictor;
            const n = Math.min(7, Math.floor((Math.abs(delta) * 4) / step)) + (delta < 0 ? 8 : 0);
            predictor = Math.max(
                -32768,
                Math.min(32767, predictor + Math.trunc((step * DIFF[n]) / 8)),
            );
            step = Math.max(127, Math.min(24576, (step * SCALE[n & 7]) >> 8));
            return n;
        };
        const bytes = [];
        for (let i = 0; i + 1 < samples.length; i += 2)
            bytes.push((nibble(samples[i]) << 4) | nibble(samples[i + 1]));
        return bytes;
    }

    it.each([48000, 44100])('plays at the right pitch and length on a %i Hz output', (rate) => {
        const HZ = 440;
        const tone = Array.from({ length: 3000 }, (_, i) =>
            Math.round(8000 * Math.sin((2 * Math.PI * HZ * i) / 6000)),
        );
        const bytes = encode(tone);
        const s = new WiimoteSpeaker();
        turnOn(s, { volume: 0x7f });
        const ctx = fakeContext({ sampleRate: rate });
        const voice = new WiimoteSpeakerOutput({ makeContext: () => ctx }).voice();
        for (let i = 0; i < bytes.length; i += 20) {
            // Reports come as the sound plays, a little unevenly.
            ctx.currentTime = (i / 20) * (40 / 6000) + (i % 60 === 0 ? 0.03 : 0);
            voice.push(s.output(...data(bytes.slice(i, i + 20))), s.sampleRate, s.volume);
        }
        expect(ctx.played).toHaveLength(75);
        const all = ctx.played.flatMap((p) => Array.from(p.samples));
        // Half a second of sound, end to end.
        expect(all.length / rate).toBeCloseTo(0.5, 2);
        const last = ctx.played[74];
        expect(last.when + last.samples.length / rate - ctx.played[0].when).toBeCloseTo(0.5, 2);
        // 440 Hz for half a second: 220 turns, counted where the wave rises through zero.
        let turns = 0;
        for (let i = 1; i < all.length; i++) if (all[i - 1] < 0 && all[i] >= 0) turns++;
        expect(Math.abs(turns - 220)).toBeLessThanOrEqual(1);
        // As loud as it was made, and no step between reports that would click.
        expect(Math.max(...all)).toBeGreaterThan(0.2);
        expect(Math.max(...all)).toBeLessThan(0.3);
        let step = 0;
        for (let i = 1; i < all.length; i++) step = Math.max(step, Math.abs(all[i] - all[i - 1]));
        expect(step).toBeLessThan(0.04);
    });
});
