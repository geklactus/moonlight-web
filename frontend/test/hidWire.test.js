/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

import { describe, expect, it, vi } from 'vitest';
import {
    HidReportPump,
    REPEAT_MS,
    attachMessage,
    decodeReportFrame,
    detachMessage,
    encodeReportFrame,
    isGameDevice,
    isJoycon,
    isJoyconOutput,
    isWiimote,
    isWiimoteOutput,
    plainCollection,
    JOYCON_FILTERS,
    JOYCON_REPLY_IDS,
    WIIMOTE_FILTERS,
    WIIMOTE_REPLY_IDS,
} from '../js/hid/hidWire.js';

// A WebHID collection keeps its fields on the prototype, as Chrome's do.
function protoObject(fields) {
    return Object.create(fields);
}

function g923Joystick() {
    const hat = protoObject({
        usages: [0x10039],
        reportSize: 4,
        reportCount: 1,
        logicalMinimum: 0,
        logicalMaximum: 7,
        hasNull: true,
        unitSystem: 'english-rotation',
        unitFactorLengthExponent: 1,
    });
    const wheel = protoObject({
        usages: [0x10030],
        reportSize: 16,
        reportCount: 1,
        logicalMinimum: 0,
        logicalMaximum: 65535,
    });
    const report = protoObject({ reportId: 1, items: [hat, wheel] });
    return protoObject({
        usagePage: 1,
        usage: 4,
        type: 1,
        children: [],
        inputReports: [report],
        outputReports: [],
        featureReports: [],
    });
}

describe('hidWire (HID passthrough, P2)', () => {
    it('turns WebHID collections into plain objects JSON can carry', () => {
        const plain = plainCollection(g923Joystick());
        const back = JSON.parse(JSON.stringify(plain));
        expect(back.usagePage).toBe(1);
        expect(back.inputReports[0].reportId).toBe(1);
        expect(back.inputReports[0].items[0]).toMatchObject({
            usages: [0x10039],
            hasNull: true,
            unitSystem: 'english-rotation',
        });
        expect(back.inputReports[0].items[1].logicalMaximum).toBe(65535);
        expect(back.outputReports).toEqual([]);
    });

    it('tells a game device from a keyboard or a vendor interface alone', () => {
        expect(isGameDevice([{ usagePage: 1, usage: 4 }])).toBe(true);
        expect(isGameDevice([{ usagePage: 2, usage: 0xc4 }])).toBe(true);
        expect(
            isGameDevice([
                { usagePage: 0xff43, usage: 0x602 },
                { usagePage: 1, usage: 5 },
            ]),
        ).toBe(true);
        expect(isGameDevice([{ usagePage: 1, usage: 6 }])).toBe(false);
        expect(isGameDevice([{ usagePage: 0xfffd, usage: 0xfd01 }])).toBe(false);
        expect(isGameDevice(undefined)).toBe(false);
    });

    it('knows a Wii Remote by its ids alone, and its answers and outputs by report id', () => {
        expect(WIIMOTE_FILTERS).toEqual([
            { vendorId: 0x057e, productId: 0x0306 },
            { vendorId: 0x057e, productId: 0x0330 },
        ]);
        expect(isWiimote({ vendorId: 0x057e, productId: 0x0306 })).toBe(true);
        expect(isWiimote({ vendorId: 0x057e, productId: 0x0330 })).toBe(true);
        expect(isWiimote({ vendorId: 0x057e, productId: 0x2009 })).toBe(false); // Switch Pro
        expect(isWiimote({ vendorId: 0x046d, productId: 0x0306 })).toBe(false);
        expect(isWiimote(undefined)).toBe(false);
        expect(Array.from(WIIMOTE_REPLY_IDS)).toEqual([0x20, 0x21, 0x22]);
        expect(isWiimoteOutput(0x10) && isWiimoteOutput(0x1a)).toBe(true);
        expect(isWiimoteOutput(0x0f) || isWiimoteOutput(0x1b) || isWiimoteOutput(0x30)).toBe(false);
    });

    it('knows a Joy-Con by its ids, and its answers by report id', () => {
        expect(JOYCON_FILTERS).toEqual([
            { vendorId: 0x057e, productId: 0x2006 },
            { vendorId: 0x057e, productId: 0x2007 },
        ]);
        expect(isJoycon({ vendorId: 0x057e, productId: 0x2006 })).toBe(true);
        expect(isJoycon({ vendorId: 0x057e, productId: 0x2007 })).toBe(true);
        expect(isJoycon({ vendorId: 0x057e, productId: 0x2009 })).toBe(false); // Switch Pro: not yet
        expect(isJoycon({ vendorId: 0x057e, productId: 0x200e })).toBe(false); // Chrome's joined pad
        expect(isJoycon({ vendorId: 0x057e, productId: 0x0306 })).toBe(false); // a Wii Remote
        expect(isJoycon({ vendorId: 0x046d, productId: 0x2006 })).toBe(false);
        expect(isJoycon(undefined)).toBe(false);
        // Only the subcommand's answer is a reply; the states (0x30, 0x31, 0x3f) are not.
        expect(Array.from(JOYCON_REPLY_IDS)).toEqual([0x21]);
    });

    // An output report 0x01 after its id: counter, eight bytes of rumble, the subcommand, its arguments.
    const subcommand = (sub, ...args) =>
        new Uint8Array([0x05, 0, 1, 0x40, 0x40, 0, 1, 0x40, 0x40, sub, ...args]);
    const flashRead = (address, size) =>
        subcommand(
            0x10,
            address & 0xff,
            (address >> 8) & 0xff,
            (address >> 16) & 0xff,
            (address >>> 24) & 0xff,
            size,
        );

    it('lets the game write to a Joy-Con what Eden sends, and no more', () => {
        // Rumble alone, and data for the MCU (NFC, the IR camera).
        expect(isJoyconOutput(0x10, new Uint8Array(9))).toBe(true);
        expect(isJoyconOutput(0x11, new Uint8Array(47))).toBe(true);
        // Every subcommand Eden's driver uses.
        for (const sub of [
            0x02, 0x03, 0x04, 0x21, 0x22, 0x30, 0x38, 0x40, 0x41, 0x48, 0x59, 0x5a, 0x5c,
        ])
            expect(isJoyconOutput(0x01, subcommand(sub, 0x01)), sub.toString(16)).toBe(true);
        // The flash write and erase, pairing, power, the MCU's reset, and what Eden never sends.
        for (const sub of [
            0x00, 0x01, 0x05, 0x06, 0x07, 0x11, 0x12, 0x20, 0x31, 0x42, 0x43, 0x50, 0x58, 0x5b,
            0xff,
        ])
            expect(isJoyconOutput(0x01, subcommand(sub, 0x00)), sub.toString(16)).toBe(false);
        // Other reports: the firmware update's, the USB commands', anything else.
        for (const id of [0x00, 0x02, 0x03, 0x12, 0x21, 0x30, 0x80])
            expect(isJoyconOutput(id, subcommand(0x02)), id.toString(16)).toBe(false);
        // A report too short to hold a subcommand, or none at all.
        expect(isJoyconOutput(0x01, new Uint8Array(9))).toBe(false);
        expect(isJoyconOutput(0x01, undefined)).toBe(false);
        // A plain array reads the same as a Uint8Array.
        expect(isJoyconOutput(0x01, Array.from(subcommand(0x30, 0x01)))).toBe(true);
    });

    it('lets "low power mode" through only as off', () => {
        expect(isJoyconOutput(0x01, subcommand(0x08, 0x00))).toBe(true); // what Eden sends at set-up
        expect(isJoyconOutput(0x01, subcommand(0x08, 0x01))).toBe(false);
        expect(isJoyconOutput(0x01, subcommand(0x08))).toBe(false); // no argument: not known to be off
    });

    it('keeps flash reads to the factory block and the user calibration', () => {
        // What Eden reads: serial, device type, motion and stick calibration, colours; the user's.
        for (const [address, size] of [
            [0x6000, 16],
            [0x6012, 1],
            [0x6020, 24],
            [0x603d, 9],
            [0x6046, 9],
            [0x6050, 12],
            [0x8010, 2],
            [0x8012, 9],
            [0x801b, 2],
            [0x801d, 9],
            [0x8026, 2],
            [0x8028, 24],
            [0x60e3, 0x1d], // the last 29 bytes of the factory block
        ])
            expect(isJoyconOutput(0x01, flashRead(address, size)), address.toString(16)).toBe(true);
        for (const [address, size] of [
            [0x2000, 0x1d], // the pairing information
            [0x0000, 1],
            [0x0015, 6],
            [0x5000, 1],
            [0x5fff, 2], // starts before the block
            [0x60e4, 0x1d], // runs past its end
            [0x6100, 1],
            [0x7fff, 1],
            [0x8100, 1],
            [0x00016000, 16], // the same low half, another address
            [0x80006000, 16],
            [0x6000, 0], // nothing asked for
            [0x6000, 0x1e], // more than one read returns
        ])
            expect(isJoyconOutput(0x01, flashRead(address, size)), address.toString(16)).toBe(
                false,
            );
        // A read cut short of its size.
        expect(isJoyconOutput(0x01, subcommand(0x10, 0x00, 0x60, 0x00, 0x00))).toBe(false);
    });

    it('writes the attach and detach messages', () => {
        const device = {
            vendorId: 0x046d,
            productId: 0xc26e,
            productName: 'G923',
            collections: [g923Joystick()],
        };
        const m = attachMessage(2, device);
        expect(m).toMatchObject({
            type: 'hidattach',
            slot: 2,
            vendorId: 0x046d,
            productId: 0xc26e,
            productName: 'G923',
        });
        expect(m.collections[0].inputReports[0].items).toHaveLength(2);
        expect(attachMessage(0, { vendorId: 1, productId: 2 })).toMatchObject({
            productName: '',
            collections: [],
        });
        expect(detachMessage(2)).toEqual({ type: 'hiddetach', slot: 2 });
    });

    it('frames a report as [slot][id][seq LE][bytes] and reads it back', () => {
        const f = encodeReportFrame(3, 17, 0x1234, new Uint8Array([8, 0, 0x80]));
        expect(Array.from(f)).toEqual([3, 17, 0x34, 0x12, 8, 0, 0x80]);
        const d = decodeReportFrame(f.buffer);
        expect(d).toMatchObject({ slot: 3, reportId: 17, seq: 0x1234 });
        expect(Array.from(d.bytes)).toEqual([8, 0, 0x80]);
        expect(decodeReportFrame(new Uint8Array([1, 2, 3]))).toBe(null);
    });

    it('numbers reports per slot and wraps at 16 bits', () => {
        const pump = new HidReportPump();
        expect(decodeReportFrame(pump.report(0, 1, [1], 0)).seq).toBe(0);
        expect(decodeReportFrame(pump.report(0, 1, [2], 1)).seq).toBe(1);
        expect(decodeReportFrame(pump.report(1, 0, [9], 1)).seq).toBe(0);
        let last;
        for (let i = 2; i <= 0xffff; i++) last = pump.report(0, 1, [3], 2);
        expect(decodeReportFrame(last).seq).toBe(0xffff);
        expect(decodeReportFrame(pump.report(0, 1, [3], 3)).seq).toBe(0);
    });

    it('repeats an unchanged report every REPEAT_MS, the last one only, until forgotten', () => {
        const pump = new HidReportPump();
        const bytes = new Uint8Array([5, 6]);
        pump.report(0, 1, bytes, 1000);
        bytes[0] = 99; // the caller's buffer is reused by WebHID: the pump kept its own copy
        expect(pump.due(1000 + REPEAT_MS - 1)).toHaveLength(0);
        const again = pump.due(1000 + REPEAT_MS);
        expect(again).toHaveLength(1);
        expect(Array.from(decodeReportFrame(again[0]).bytes)).toEqual([5, 6]);
        expect(pump.due(1000 + REPEAT_MS + 10)).toHaveLength(0); // not before another REPEAT_MS
        pump.report(0, 1, [7, 7], 1700); // a new report resets its clock
        expect(pump.due(1700 + REPEAT_MS - 1)).toHaveLength(0);
        pump.report(0, 2, [1], 1700);
        expect(pump.due(1700 + REPEAT_MS)).toHaveLength(2);
        pump.forget(0);
        expect(pump.due(9999)).toHaveLength(0);
    });
});

describe('hidWire channel helpers', () => {
    it('creates the negotiated, unordered, unretransmitted channel 4 and sends only when open', async () => {
        const { createHidChannel, sendHidFrame, closeHidChannel } =
            await import('../js/hid/hidWire.js');
        const made = [];
        const dc = { readyState: 'connecting', send: vi.fn(), close: vi.fn() };
        const pc = { createDataChannel: (label, init) => (made.push({ label, init }), dc) };
        expect(createHidChannel(pc)).toBe(dc);
        expect(made[0]).toEqual({
            label: 'hid',
            init: { negotiated: true, id: 4, ordered: false, maxRetransmits: 0 },
        });
        expect(dc.binaryType).toBe('arraybuffer');
        expect(sendHidFrame(dc, new Uint8Array(4))).toBe(false);
        dc.readyState = 'open';
        expect(sendHidFrame(dc, new Uint8Array(4))).toBe(true);
        dc.send.mockImplementation(() => {
            throw new Error('closing');
        });
        expect(sendHidFrame(dc, new Uint8Array(4))).toBe(false);
        expect(sendHidFrame(null, new Uint8Array(4))).toBe(false);
        closeHidChannel(dc);
        expect(dc.close).toHaveBeenCalled();
        closeHidChannel(null);
        expect(
            createHidChannel({
                createDataChannel: () => {
                    throw new Error('closed');
                },
            }),
        ).toBe(null);
    });
});
