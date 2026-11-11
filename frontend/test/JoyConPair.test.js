/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * Joy-Con halves as Firefox on Linux shows them (gamepadMapping.firefoxLinuxJoyCon)
 * and the pair joined into one pad (GamepadManager._joinJoyCons). The pads here are
 * the ones a real pair gave in LOLA's trace (Firefox 158 on Linux, 2026-11-11):
 * "057e-2007-Joy-Con (R)", standard, 17 buttons, 4 axes resting at [0, 0, 0.1, 0];
 * "057e-2006-Joy-Con (L)", "standard", 17 buttons, 2 axes. The left's raw numbers are
 * the kernel's code order (hid-nintendo.c, LinuxGamepad.cpp): b0 Capture, b1 L, b2 SL,
 * b3 ZL, b4 SR, b5 −, b6 stick, b7 up, b8 down, b9 left, b10 right.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GamepadManager, JOINED_JOYCON_ID } from '../js/stream/GamepadManager.js';
import {
    firefoxLinuxJoyCon,
    resolveMapping,
    readVirtualPad,
    FIREFOX_LINUX_JOYCON_L,
} from '../js/stream/gamepadMapping.js';

// Limelight's flags (GamepadManager's BTN).
const A = 0x1000;
const B = 0x2000;
const X = 0x4000;
const Y = 0x8000;
const UP = 0x0001;
const DOWN = 0x0002;
const LEFT = 0x0004;
const RIGHT = 0x0008;
const LB = 0x0100;
const RB = 0x0200;
const PLAY = 0x0010;
const BACK = 0x0020;
const LS_CLK = 0x0040;
const RS_CLK = 0x0080;
const SPECIAL = 0x0400;

const L_ID = '057e-2006-Joy-Con (L)';
const R_ID = '057e-2007-Joy-Con (R)';

function pad(index, id, { axes, pressed = [] } = {}) {
    return {
        index,
        id,
        mapping: 'standard',
        connected: true,
        timestamp: 1,
        vibrationActuator: null,
        buttons: Array.from({ length: 17 }, (_, i) => ({
            pressed: pressed.includes(i),
            value: pressed.includes(i) ? 1 : 0,
        })),
        axes,
    };
}
const left = (index = 1, pressed = [], axes = [0, 0]) => pad(index, L_ID, { axes, pressed });
const right = (index = 0, pressed = [], axes = [0, 0, 0.1, 0]) =>
    pad(index, R_ID, { axes, pressed });

let pads = [];
let rafCb = null;
function setPads(list) {
    pads = list;
}
function frame() {
    if (rafCb) rafCb(0);
}

function manager(extra = {}) {
    const send = vi.fn();
    const onNote = vi.fn();
    const onMapped = vi.fn();
    const gm = new GamepadManager(send, {
        platform: 'linux',
        db: null,
        user: () => null,
        onNote,
        onMapped,
        ...extra,
    });
    return { gm, send, onNote, onMapped };
}
const sent = (send, type) => send.mock.calls.map((c) => c[0]).filter((m) => m.type === type);
const lastState = (send, index) => {
    const s = sent(send, 'gamepad').filter((m) => m.index === index);
    return s[s.length - 1];
};

describe('firefoxLinuxJoyCon', () => {
    it('knows each half by its ids and Firefox’s counts, on Linux only', () => {
        expect(firefoxLinuxJoyCon(left(), 'linux')).toBe('L');
        expect(firefoxLinuxJoyCon(right(), 'linux')).toBe('R');
        expect(firefoxLinuxJoyCon(left(), 'win')).toBe(null);
        expect(firefoxLinuxJoyCon(right(), 'mac')).toBe(null);
    });

    it('leaves alone what isn’t that layout', () => {
        // Chrome's ids, Safari's unpadded ones, another product, other counts, no mapping.
        const chrome = pad(0, 'Joy-Con (L) (STANDARD GAMEPAD Vendor: 057e Product: 2006)', {
            axes: [0, 0],
        });
        expect(firefoxLinuxJoyCon(chrome, 'linux')).toBe(null);
        expect(firefoxLinuxJoyCon(pad(0, '57e-2006-Joy-Con (L)', { axes: [0, 0] }), 'linux')).toBe(
            null,
        );
        expect(
            firefoxLinuxJoyCon(pad(0, '057e-2009-Pro Controller', { axes: [0, 0, 0, 0] }), 'linux'),
        ).toBe(null);
        expect(firefoxLinuxJoyCon(pad(0, L_ID, { axes: [0, 0, 0, 0] }), 'linux')).toBe(null);
        expect(firefoxLinuxJoyCon({ ...left(), mapping: '' }, 'linux')).toBe(null);
    });
});

describe('the left Joy-Con alone, in Firefox on Linux', () => {
    it('is laid out by the built-in table, with a note instead of “guessed”', () => {
        const res = resolveMapping(left(), { platform: 'linux', user: () => null });
        expect(res.source).toBe('builtin');
        expect(res.note).toBe('joyconFirefoxStick');
        expect(res.key).toBe('usb:057e:2006');
        expect(res.bindings).toEqual(FIREFOX_LINUX_JOYCON_L);
        expect(res.bindings).not.toBe(FIREFOX_LINUX_JOYCON_L); // a copy
    });

    it('reads each raw button as the control it is, and no stick', () => {
        const res = resolveMapping(left(), { platform: 'linux', user: () => null });
        const read = (raw, axes = [0, 0]) => readVirtualPad(left(1, raw, axes), res.bindings);
        const down = (v) => v.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0);
        expect(down(read([1]))).toEqual([4]); // L → left shoulder (read as standard: B)
        expect(down(read([3]))).toEqual([6]); // ZL → left trigger
        expect(down(read([5]))).toEqual([8]); // − → back (read as standard: R)
        expect(down(read([6]))).toEqual([10]); // stick click
        expect(down(read([7, 8, 9, 10]))).toEqual([12, 13, 14, 15]); // the four directions
        expect(down(read([0, 2, 4]))).toEqual([]); // Capture, SL, SR: nowhere to go
        expect(read([], [1, 0]).axes).toEqual([0, 0, 0, 0]); // X and Y share axis 0: not read
    });

    it('keeps the player’s own mapping over the table', () => {
        const mine = { bindings: { a: { t: 'b', i: 7 } } };
        const res = resolveMapping(left(), { platform: 'linux', user: () => mine });
        expect(res.source).toBe('user');
        expect(res.note).toBeUndefined();
    });

    it('is still read as the browser says elsewhere', () => {
        expect(resolveMapping(left(), { platform: 'win', user: () => null }).source).toBe(
            'standard',
        );
        expect(resolveMapping(right(), { platform: 'linux', user: () => null }).source).toBe(
            'standard',
        );
    });
});

describe('a pair joined into one pad', () => {
    beforeEach(() => {
        pads = [];
        rafCb = null;
        Object.defineProperty(navigator, 'getGamepads', {
            value: () => pads,
            configurable: true,
            writable: true,
        });
        vi.stubGlobal('requestAnimationFrame', (cb) => {
            rafCb = cb;
            return 1;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('announces ONE Nintendo controller, at the lower index, and nothing for the other half', () => {
        setPads([right(0), left(1)]);
        const { gm, send, onNote } = manager();
        gm.start();
        const connects = sent(send, 'gamepadconnect');
        expect(connects.map((m) => m.index)).toEqual([0]);
        expect(connects[0].ctype).toBe(3); // LI_CTYPE_NINTENDO
        expect(sent(send, 'gamepaddisconnect')).toEqual([]);
        expect(onNote.mock.calls.map((c) => c[0]).sort()).toEqual([
            'joyconFirefoxStick',
            'joyconJoined',
        ]);
        expect(onNote.mock.calls.find((c) => c[0] === 'joyconJoined')[1].id).toBe(JOINED_JOYCON_ID);
        gm.stop();
    });

    it('takes every control from the half that has it', () => {
        setPads([right(0), left(1)]);
        const { gm, send } = manager();
        gm.start();
        const press = (r, l) => {
            setPads([right(0, r), left(1, l)]);
            frame();
            return lastState(send, 0).buttons;
        };
        expect(press([0], [])).toBe(A); // B, the bottom button, as positions go
        expect(press([1], [])).toBe(B); // A, on the right
        expect(press([2], [])).toBe(X); // Y, on the left
        expect(press([3], [])).toBe(Y); // X, on top
        expect(press([5], [])).toBe(RB); // R
        expect(press([9], [])).toBe(PLAY); // +
        expect(press([11], [])).toBe(RS_CLK);
        expect(press([16], [])).toBe(SPECIAL); // Home
        expect(press([], [1])).toBe(LB); // L, which alone read as B
        expect(press([], [5])).toBe(BACK); // −, which alone read as R
        expect(press([], [6])).toBe(LS_CLK);
        expect(press([], [7])).toBe(UP);
        expect(press([], [8])).toBe(DOWN);
        expect(press([], [9])).toBe(LEFT);
        expect(press([], [10])).toBe(RIGHT);
        expect(press([5], [1])).toBe(LB | RB); // L + R together, as the trace's player pressed
        expect(sent(send, 'gamepad').every((m) => m.index === 0)).toBe(true);
        gm.stop();
    });

    it('sends the triggers and the right stick, and no left stick', () => {
        setPads([right(0), left(1)]);
        const { gm, send } = manager();
        gm.start();
        setPads([right(0, [7], [0, 0, 1, -1]), left(1, [3], [1, 0])]);
        frame();
        const s = lastState(send, 0);
        expect(s.lt).toBe(255); // ZL
        expect(s.rt).toBe(255); // ZR
        expect(s.rx).toBe(32767);
        expect(s.ry).toBe(32767); // up is positive for Limelight
        // The left stick Firefox can't read. (ly is -0, the Y axes being negated
        // for Limelight; it goes over the wire as 0.)
        expect(Math.abs(s.lx)).toBe(0);
        expect(Math.abs(s.ly)).toBe(0);
        gm.stop();
    });

    it('keeps the right half’s SL and SR out of the left half’s shoulder and trigger', () => {
        setPads([right(0), left(1)]);
        const { gm, send } = manager();
        gm.start();
        setPads([right(0, [4, 6]), left(1)]);
        frame();
        const s = lastState(send, 0);
        expect(s === undefined || (s.buttons === 0 && s.lt === 0)).toBe(true);
        gm.stop();
    });

    it('joins a pair whose left half came first, and parts it when a half goes', () => {
        setPads([null, left(1)]);
        const { gm, send, onNote } = manager();
        gm.start();
        expect(sent(send, 'gamepadconnect').map((m) => m.index)).toEqual([1]); // the left alone
        expect(onNote.mock.calls.map((c) => c[0])).toEqual(['joyconFirefoxStick']);

        send.mockClear();
        setPads([right(0), left(1)]);
        frame();
        expect(sent(send, 'gamepaddisconnect').map((m) => m.index)).toEqual([1]);
        expect(sent(send, 'gamepadconnect').map((m) => m.index)).toEqual([0]);

        send.mockClear();
        setPads([null, left(1)]); // the right one switched off
        frame();
        expect(sent(send, 'gamepaddisconnect').map((m) => m.index)).toEqual([0]);
        expect(sent(send, 'gamepadconnect').map((m) => m.index)).toEqual([1]);
        setPads([null, left(1, [1])]);
        frame();
        expect(lastState(send, 1).buttons).toBe(LB); // and alone it's read right too
        expect(onNote.mock.calls.filter((c) => c[0] === 'joyconJoined')).toHaveLength(1);
        gm.stop();
    });

    it('says each note once a stream, however many polls see it', () => {
        setPads([right(0), left(1)]);
        const { gm, onNote, onMapped } = manager();
        gm.start();
        for (let i = 0; i < 5; i++) frame();
        expect(onNote).toHaveBeenCalledTimes(2);
        expect(onMapped).not.toHaveBeenCalled(); // the note says it, not "recognised automatically"
        gm.stop();
    });

    it('leaves a half the player mapped themselves as its own pad', () => {
        setPads([right(0), left(1)]);
        const mine = { bindings: { leftshoulder: { t: 'b', i: 1 } } };
        const { gm, send } = manager({ user: (key) => (key === 'usb:057e:2006' ? mine : null) });
        gm.start();
        expect(
            sent(send, 'gamepadconnect')
                .map((m) => m.index)
                .sort(),
        ).toEqual([0, 1]);
        gm.stop();
    });

    it('doesn’t join elsewhere than Linux', () => {
        setPads([right(0), left(1)]);
        const { gm, send, onNote } = manager({ platform: 'win' });
        gm.start();
        expect(
            sent(send, 'gamepadconnect')
                .map((m) => m.index)
                .sort(),
        ).toEqual([0, 1]);
        expect(onNote).not.toHaveBeenCalled();
        gm.stop();
    });
});
