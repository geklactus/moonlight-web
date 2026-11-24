/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

/**
 * The HID passthrough's wire (plan « Passthrough HID », P2): what the page
 * sends the host about a device it reads through WebHID.
 *
 * - Once per device, on the reliable `input` channel, `hidattach` with the
 *   device's identity and its `collections` as plain objects — the host
 *   rebuilds the report descriptor from them (HidDescriptor.cpp) and checks it
 *   before creating anything.
 * - Then each input report on the `hid` channel (id 4, unordered, no
 *   retransmission), binary: [slot u8][report id u8][seq u16 LE][bytes]. The
 *   host keeps only the newest per slot and report id.
 * - A report that has not changed is sent again every REPEAT_MS, so a lost
 *   datagram never leaves an axis where it was: an absolute report carries the
 *   whole state, the next one repairs any loss.
 */

export const HID_CHANNEL_LABEL = 'hid';
export const HID_CHANNEL_ID = 4;
export const HID_FRAME_HEADER = 4;
export const HID_MAX_SLOTS = 8;
export const REPEAT_MS = 500;

// Usages a game device declares at the top of its report descriptor: the
// chooser's filters, and what the host accepts as a game collection.
export const GAME_FILTERS = [
    { usagePage: 0x01, usage: 0x04 }, // Joystick
    { usagePage: 0x01, usage: 0x05 }, // Game Pad
    { usagePage: 0x01, usage: 0x08 }, // Multi-axis Controller
    { usagePage: 0x02 }, // Simulation Controls (wheels, pedals)
];

// The Wii Remote and the Wii Remote Plus, by their ids alone: what a DolphinBar
// declares above them is not known, and the ids are what Dolphin takes as a
// real remote. Only a GameStream host on the host's own machine (Wolf on LOLA)
// recreates them, behind its operator's setting.
export const WIIMOTE_FILTERS = [
    { vendorId: 0x057e, productId: 0x0306 }, // Nintendo RVL-CNT-01
    { vendorId: 0x057e, productId: 0x0330 }, // Nintendo RVL-CNT-01-TR
];

/** True for a Wii Remote (either model), from its ids. */
export function isWiimote(device) {
    return WIIMOTE_FILTERS.some(
        (f) => f.vendorId === device?.vendorId && f.productId === device?.productId,
    );
}

// A Wii Remote's answers, each the one reply to one request: status (0x20),
// a memory read (0x21), an acknowledged write (0x22). They go on the reliable
// channel as hidreply, never on 'hid', whose losses and repeats would drop or
// replay them; its data reports (0x30–0x3f) carry whole states and go on 'hid'.
export const WIIMOTE_REPLY_IDS = new Set([0x20, 0x21, 0x22]);

/** A Wii Remote output report (0x10 rumble … 0x1a speaker mute): its whole set. */
export function isWiimoteOutput(reportId) {
    return reportId >= 0x10 && reportId <= 0x1a;
}

// The Joy-Cons, by their ids: sent as themselves so the game's own Joy-Con
// driver (Eden's, on Wolf on LOLA) runs them, with motion, rumble and lights.
export const JOYCON_FILTERS = [
    { vendorId: 0x057e, productId: 0x2006 }, // Joy-Con (L)
    { vendorId: 0x057e, productId: 0x2007 }, // Joy-Con (R)
];

// The Pro Controller: the Joy-Con's protocol (the same reports, the same
// writes), both halves in one device, sent as the Joy-Cons are. Its copy goes
// on a bus the host's own kernel driver doesn't match (the host's
// GameStreamHid; geklactus/lola docs/joycon/plan.md).
export const PRO_FILTERS = [{ vendorId: 0x057e, productId: 0x2009 }];

/** True for a Joy-Con (either half), from its ids. */
export function isJoycon(device) {
    return JOYCON_FILTERS.some(
        (f) => f.vendorId === device?.vendorId && f.productId === device?.productId,
    );
}

/** True for a Switch Pro Controller, from its ids. */
export function isProController(device) {
    return device?.vendorId === 0x057e && device?.productId === 0x2009;
}

/** A Joy-Con or a Pro Controller: a Switch controller the game's own driver runs. */
export function isSwitchHid(device) {
    return isJoycon(device) || isProController(device);
}

// A Joy-Con's (or a Pro Controller's) answer to a subcommand (0x21), the one reply to one request: on
// the reliable channel as hidreply. Its full reports (0x30, and 0x31 with the
// MCU's data) and simple ones (0x3f) carry whole states and go on 'hid'.
export const JOYCON_REPLY_IDS = new Set([0x21]);

// What the game may write to a real Joy-Con: what Eden's driver sends and no
// more (src/input_common/helpers/joycon_driver.cpp and joycon_protocol/,
// aoede/eden a62f75a; the table is in geklactus/lola docs/joycon/plan.md).
// Never the flash write or erase (0x11, 0x12), the pairing and power commands
// (0x01, 0x06, 0x07), or anything else: a host that could write the flash
// could rewrite a Joy-Con's calibration.
const JOYCON_RUMBLE_AND_SUBCOMMAND = 0x01;
const JOYCON_RUMBLE = 0x10;
const JOYCON_MCU_DATA = 0x11;
const JOYCON_SUBCOMMAND_AT = 9; // after the counter (1) and the rumble data (8)
const JOYCON_LOW_POWER = 0x08;
const JOYCON_FLASH_READ = 0x10;
const JOYCON_SUBCOMMANDS = new Set([
    0x02, // device info
    0x03, // report mode
    0x04, // how long the trigger buttons were held
    JOYCON_LOW_POWER, // with the argument 00 only (below)
    JOYCON_FLASH_READ, // in the factory and user ranges only (below)
    0x21, // the MCU's configuration (NFC, the IR camera, the Ring-Con)
    0x22, // the MCU's state
    0x30, // the player lights
    0x38, // the Home light
    0x40, // motion on or off
    0x41, // motion's sensitivity
    0x48, // vibration on or off
    0x59, // the Ring-Con: what is on the rail
    0x5a, // the Ring-Con: polling
    0x5c, // the Ring-Con: format
]);
// The flash a read may reach: the factory block (serial, device type, colours,
// calibration) and the user's calibration. The pairing information (0x2000)
// and everything else stay out of reach.
const JOYCON_FLASH_RANGES = [
    [0x6000, 0x60ff],
    [0x8000, 0x80ff],
];
const JOYCON_FLASH_READ_MAX = 0x1d; // the most one read returns

/**
 * True when the game may write this output report to a real Joy-Con.
 * @param {number} reportId
 * @param {ArrayLike<number>} bytes the report after its id
 */
export function isJoyconOutput(reportId, bytes) {
    if (reportId === JOYCON_RUMBLE || reportId === JOYCON_MCU_DATA) return true;
    if (reportId !== JOYCON_RUMBLE_AND_SUBCOMMAND) return false;
    if (!bytes || bytes.length <= JOYCON_SUBCOMMAND_AT) return false;
    const sub = bytes[JOYCON_SUBCOMMAND_AT];
    if (!JOYCON_SUBCOMMANDS.has(sub)) return false;
    const arg = JOYCON_SUBCOMMAND_AT + 1;
    if (sub === JOYCON_LOW_POWER) return bytes.length > arg && bytes[arg] === 0x00;
    if (sub === JOYCON_FLASH_READ) {
        if (bytes.length < arg + 5) return false;
        // The address, 32 bits little-endian, then how many bytes.
        const address =
            bytes[arg] +
            bytes[arg + 1] * 0x100 +
            bytes[arg + 2] * 0x10000 +
            bytes[arg + 3] * 0x1000000;
        const size = bytes[arg + 4];
        if (size < 1 || size > JOYCON_FLASH_READ_MAX) return false;
        return JOYCON_FLASH_RANGES.some(
            ([from, to]) => address >= from && address + size - 1 <= to,
        );
    }
    return true;
}

const ITEM_FIELDS = [
    'isAbsolute',
    'isArray',
    'isBufferedBytes',
    'isConstant',
    'isLinear',
    'isRange',
    'isVolatile',
    'hasNull',
    'hasPreferredState',
    'wrap',
    'usages',
    'usageMinimum',
    'usageMaximum',
    'reportSize',
    'reportCount',
    'unitExponent',
    'unitSystem',
    'unitFactorLengthExponent',
    'unitFactorMassExponent',
    'unitFactorTimeExponent',
    'unitFactorTemperatureExponent',
    'unitFactorCurrentExponent',
    'unitFactorLuminousIntensityExponent',
    'logicalMinimum',
    'logicalMaximum',
    'physicalMinimum',
    'physicalMaximum',
];

// WebHID's objects keep their fields on the prototype: JSON.stringify sees none.
function plainItem(item) {
    const o = {};
    for (const k of ITEM_FIELDS) {
        const v = item[k];
        if (v === undefined) continue;
        o[k] = Array.isArray(v) ? [...v] : v;
    }
    return o;
}

function plainReport(r) {
    return { reportId: r.reportId, items: (r.items || []).map(plainItem) };
}

/** A HIDCollectionInfo as a plain object, children included. */
export function plainCollection(c) {
    return {
        usagePage: c.usagePage,
        usage: c.usage,
        type: c.type,
        children: (c.children || []).map(plainCollection),
        inputReports: (c.inputReports || []).map(plainReport),
        outputReports: (c.outputReports || []).map(plainReport),
        featureReports: (c.featureReports || []).map(plainReport),
    };
}

/** True when one of the device's top-level collections is a game one. */
export function isGameDevice(collections) {
    return (collections || []).some((c) =>
        GAME_FILTERS.some(
            (f) => f.usagePage === c.usagePage && (f.usage === undefined || f.usage === c.usage),
        ),
    );
}

/**
 * Chrome's chooser narrowed to one model's game interfaces: the row of a
 * wheel in Settings, or the stream's offer, lists that wheel and nothing else
 * (not its vendor-only interface either).
 */
export function modelFilters(vendorId, productId) {
    return GAME_FILTERS.map((f) => ({ vendorId, productId, ...f }));
}

/** The `hidattach` message for a device opened in this page. */
export function attachMessage(slot, device, { forceFeedback = false } = {}) {
    const m = {
        type: 'hidattach',
        slot,
        vendorId: device.vendorId,
        productId: device.productId,
        productName: device.productName || '',
        collections: (device.collections || []).map(plainCollection),
    };
    // The page can play force feedback on this device: the host gives the
    // recreated one a PID block and sends what games ask as hidffb.
    if (forceFeedback) m.forceFeedback = true;
    return m;
}

export function detachMessage(slot) {
    return { type: 'hiddetach', slot };
}

/** One input report as the `hid` channel carries it. */
export function encodeReportFrame(slot, reportId, seq, bytes) {
    const frame = new Uint8Array(HID_FRAME_HEADER + bytes.length);
    frame[0] = slot & 0xff;
    frame[1] = reportId & 0xff;
    frame[2] = seq & 0xff;
    frame[3] = (seq >> 8) & 0xff;
    frame.set(bytes, HID_FRAME_HEADER);
    return frame;
}

/** The reverse, or null for a frame too short to hold the header. */
export function decodeReportFrame(frame) {
    const b = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    if (b.length < HID_FRAME_HEADER) return null;
    return {
        slot: b[0],
        reportId: b[1],
        seq: b[2] | (b[3] << 8),
        bytes: b.subarray(HID_FRAME_HEADER),
    };
}

/**
 * Numbers each report and repeats the last one of every (slot, report id)
 * that stayed unchanged for REPEAT_MS. The caller sends what it returns;
 * `now` is injected so the policy is testable.
 */
export class HidReportPump {
    constructor(repeatMs = REPEAT_MS) {
        this._repeatMs = repeatMs;
        this._seq = new Map(); // slot -> next seq
        this._last = new Map(); // `${slot}:${id}` -> { slot, reportId, bytes, at }
    }

    /** A report just read from the device: its frame. */
    report(slot, reportId, bytes, now) {
        this._last.set(`${slot}:${reportId}`, {
            slot,
            reportId,
            bytes: Uint8Array.from(bytes),
            at: now,
        });
        return this._frame(slot, reportId, bytes);
    }

    /** Frames to send again: reports unchanged for at least REPEAT_MS. */
    due(now) {
        const out = [];
        for (const r of this._last.values()) {
            if (now - r.at < this._repeatMs) continue;
            r.at = now;
            out.push(this._frame(r.slot, r.reportId, r.bytes));
        }
        return out;
    }

    /** The device left: nothing of it is repeated any more. */
    forget(slot) {
        for (const [k, r] of this._last) if (r.slot === slot) this._last.delete(k);
        this._seq.delete(slot);
    }

    _frame(slot, reportId, bytes) {
        const seq = this._seq.get(slot) || 0;
        this._seq.set(slot, (seq + 1) & 0xffff);
        return encodeReportFrame(slot, reportId, seq, bytes);
    }
}

/**
 * The 'hid' channel on a transport's peer connection: negotiated (no SDP of
 * its own), unordered, never retransmitted. Not one of the channels the
 * connection waits for — a host without it simply drops what lands on id 4.
 */
export function createHidChannel(pc) {
    try {
        const dc = pc.createDataChannel(HID_CHANNEL_LABEL, {
            negotiated: true,
            id: HID_CHANNEL_ID,
            ordered: false,
            maxRetransmits: 0,
        });
        dc.binaryType = 'arraybuffer';
        return dc;
    } catch {
        return null;
    }
}

/** Sends one frame when the channel is open; false otherwise. */
export function sendHidFrame(dc, frame) {
    if (!dc || dc.readyState !== 'open') return false;
    try {
        dc.send(frame);
        return true;
    } catch {
        return false;
    }
}

export function closeHidChannel(dc) {
    try {
        if (dc && dc.readyState !== 'closed') dc.close();
    } catch {
        /* closing anyway */
    }
}
