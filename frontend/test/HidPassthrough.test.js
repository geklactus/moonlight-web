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
    FORWARD_KEY,
    HID_KINDS,
    HOLD_MS,
    HidPassthrough,
    deviceKey,
    hidHelpFor,
    hidModelOf,
    linkModel,
    loadForwarded,
    padKeyOf,
    saveForwarded,
} from '../js/hid/HidPassthrough.js';
import { decodeReportFrame, modelFilters } from '../js/hid/hidWire.js';

function fakeDevice({
    vendorId = 0x046d,
    productId = 0xc26e,
    usagePage = 1,
    usage = 4,
    openFails = false,
} = {}) {
    const listeners = new Set();
    return {
        vendorId,
        productId,
        productName: 'G923',
        opened: false,
        collections: [
            {
                usagePage,
                usage,
                type: 1,
                children: [],
                inputReports: [],
                outputReports: [],
                featureReports: [],
            },
        ],
        async open() {
            if (openFails) throw new Error('busy');
            this.opened = true;
        },
        addEventListener: (t, fn) => t === 'inputreport' && listeners.add(fn),
        removeEventListener: (t, fn) => t === 'inputreport' && listeners.delete(fn),
        report(reportId, bytes) {
            const data = new DataView(Uint8Array.from(bytes).buffer);
            for (const fn of listeners) fn({ reportId, data });
        },
        listening: () => listeners.size,
    };
}

/** A Wii Remote as WebHID shows it: its ids, a Game Pad collection, and what it was sent. */
function fakeWiimote({ productId = 0x0306, sendFails = false, openFails = false } = {}) {
    const d = fakeDevice({ vendorId: 0x057e, productId, usage: 5, openFails });
    d.productName = 'Nintendo RVL-CNT-01';
    d.sent = [];
    d.sendReport = vi.fn(async (id, data) => {
        if (sendFails) throw new Error('NotAllowedError');
        d.sent.push([id, Array.from(data)]);
    });
    d.close = vi.fn(async () => {
        d.opened = false;
    });
    return d;
}

function fakeHid(devices) {
    const listeners = new Set();
    return {
        getDevices: async () => devices,
        requestDevice: vi.fn(async () => devices.slice(0, 1)),
        addEventListener: (t, fn) => t === 'disconnect' && listeners.add(fn),
        removeEventListener: (t, fn) => t === 'disconnect' && listeners.delete(fn),
        unplug: (device) => listeners.forEach((fn) => fn({ device })),
    };
}

function memoryStorage(initial = {}) {
    const m = new Map(Object.entries(initial));
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
}

function setup(devices, wanted = []) {
    const hid = fakeHid(devices);
    const sent = [];
    const frames = [];
    let tick = null;
    let hold = null;
    let now = 0;
    const storage = memoryStorage({ [FORWARD_KEY]: JSON.stringify(wanted) });
    const onChange = vi.fn();
    const onResult = vi.fn();
    const wiimote = [];
    const hp = new HidPassthrough({
        hid,
        send: (m) => sent.push(m),
        sendFrame: (f) => frames.push(f) && true,
        storage,
        now: () => now,
        setTimer: (fn) => (tick = fn),
        clearTimer: () => (tick = null),
        later: (fn, ms) => (hold = { fn, ms }),
        cancelLater: () => (hold = null),
        onChange,
        onResult,
        onWiimote: (e) => wiimote.push(e),
    });
    return {
        hp,
        onResult,
        hid,
        sent,
        frames,
        storage,
        onChange,
        wiimote,
        advance: (ms) => {
            now += ms;
            if (tick) tick();
        },
        ticking: () => !!tick,
        hold: () => hold,
    };
}

describe('HidPassthrough (HID passthrough in the stream, P2)', () => {
    it('remembers switched-on devices by vid:pid, and maps them to pad keys', () => {
        const d = fakeDevice();
        expect(deviceKey(d)).toBe('046d:c26e');
        expect(padKeyOf(d)).toBe('usb:046d:c26e');
        const storage = memoryStorage();
        saveForwarded(new Set(['046d:c26e']), storage);
        expect(Array.from(loadForwarded(storage))).toEqual(['046d:c26e']);
        expect(loadForwarded(memoryStorage({ [FORWARD_KEY]: 'not json' })).size).toBe(0);
        expect(
            loadForwarded({
                getItem: () => {
                    throw new Error('blocked');
                },
            }).size,
        ).toBe(0);
        saveForwarded(new Set(), {
            setItem: () => {
                throw new Error('blocked');
            },
        }); // no throw
    });

    it('attaches the wanted devices once the host can, then streams their reports', async () => {
        const wheel = fakeDevice();
        const t = setup([wheel], ['046d:c26e']);
        expect(t.hp.supported).toBe(true);
        t.hp.handleMessage({ type: 'hidcaps', available: true, why: '' });
        await vi.waitFor(() => expect(t.sent).toHaveLength(1));
        expect(t.sent[0]).toMatchObject({
            type: 'hidattach',
            slot: 0,
            vendorId: 0x046d,
            productId: 0xc26e,
        });
        expect(wheel.opened).toBe(true);
        expect(t.hp.excludedKeys()).toEqual(['usb:046d:c26e']);

        t.hp.handleMessage({ type: 'hidattached', slot: 0, ok: true });
        expect((await t.hp.devices())[0]).toMatchObject({
            key: '046d:c26e',
            wanted: true,
            state: 'on',
        });

        wheel.report(1, [8, 0, 0x80]);
        expect(t.frames).toHaveLength(1);
        expect(decodeReportFrame(t.frames[0])).toMatchObject({ slot: 0, reportId: 1, seq: 0 });
        // An unchanged report goes again after 500 ms.
        t.advance(400);
        expect(t.frames).toHaveLength(1);
        t.advance(100);
        expect(t.frames).toHaveLength(2);
    });

    it('does nothing for a host that cannot, and lets go when it says it no longer can', async () => {
        const wheel = fakeDevice();
        const t = setup([wheel], ['046d:c26e']);
        t.hp.handleMessage({ type: 'hidcaps', available: false, why: 'needs the native host' });
        await Promise.resolve();
        expect(t.sent).toHaveLength(0);
        expect(t.hp.caps).toEqual({
            available: false,
            ffb: false,
            hidpp: false,
            wiimote: false,
            why: 'needs the native host',
        });

        t.hp.handleMessage({ type: 'hidcaps', available: true });
        await vi.waitFor(() => expect(t.sent).toHaveLength(1));
        t.hp.handleMessage({ type: 'hidcaps', available: false, why: 'gone' });
        expect(t.sent[1]).toEqual({ type: 'hiddetach', slot: 0 });
        expect(wheel.listening()).toBe(0);
        expect(t.ticking()).toBe(false);
    });

    it('shows a refusal by the device, and frees its slot', async () => {
        const wheel = fakeDevice();
        const t = setup([wheel], ['046d:c26e']);
        t.hp.handleMessage({ type: 'hidcaps', available: true });
        await vi.waitFor(() => expect(t.sent).toHaveLength(1));
        t.hp.handleMessage({ type: 'hidattached', slot: 0, ok: false, why: 'not a game device' });
        expect(t.onResult).toHaveBeenCalledWith(wheel, false, 'not a game device');
        const [d] = await t.hp.devices();
        expect(d).toMatchObject({ state: 'refused', why: 'not a game device' });
        expect(t.hp.excludedKeys()).toEqual([]);
        expect(wheel.listening()).toBe(0);
        expect(t.hp.handleMessage({ type: 'hidattached', slot: 5, ok: true })).toBe(true); // unknown slot
    });

    it('switches a device on and off for this viewer', async () => {
        const wheel = fakeDevice();
        const radio = fakeDevice({ vendorId: 0x1209, productId: 0x4f54, usage: 5 });
        const t = setup([wheel, radio]);
        t.hp.handleMessage({ type: 'hidcaps', available: true });
        await Promise.resolve();
        expect(t.sent).toHaveLength(0);
        await t.hp.setWanted(radio, true);
        expect(t.sent[0]).toMatchObject({ type: 'hidattach', slot: 0, vendorId: 0x1209 });
        await t.hp.setWanted(wheel, true);
        expect(t.sent[1]).toMatchObject({ type: 'hidattach', slot: 1 });
        expect(Array.from(loadForwarded(t.storage))).toEqual(['1209:4f54', '046d:c26e']);
        await t.hp.setWanted(radio, false);
        expect(t.sent[2]).toEqual({ type: 'hiddetach', slot: 0 });
        expect(Array.from(loadForwarded(t.storage))).toEqual(['046d:c26e']);
        expect(t.onChange).toHaveBeenCalled();
    });

    it('drops an unplugged device, keeps keyboards out, and survives a device it cannot open', async () => {
        const wheel = fakeDevice();
        const keyboard = fakeDevice({ vendorId: 1, productId: 2, usage: 6 });
        const busy = fakeDevice({ vendorId: 3, productId: 4, openFails: true });
        const t = setup([wheel, keyboard, busy], ['046d:c26e', '0003:0004', '0001:0002']);
        expect((await t.hp.devices()).map((d) => d.key)).toEqual(['046d:c26e', '0003:0004']);
        t.hp.handleMessage({ type: 'hidcaps', available: true });
        await vi.waitFor(() => expect(t.sent).toHaveLength(1));
        const states = await t.hp.devices();
        expect(states[1]).toMatchObject({ state: 'refused', why: 'busy' });
        t.hid.unplug(wheel);
        expect(t.sent[1]).toEqual({ type: 'hiddetach', slot: 0 });
        expect((await t.hp.devices())[0]).toMatchObject({ state: 'off', why: 'unplugged' });
    });

    it('counts host requests, ignores other messages, opens the chooser and stops cleanly', async () => {
        const wheel = fakeDevice();
        const t = setup([wheel], ['046d:c26e']);
        expect(t.hp.handleMessage({ type: 'hidrequest', slot: 0, kind: 'output' })).toBe(true);
        expect(t.hp.requests).toBe(1);
        expect(t.hp.handleMessage({ type: 'rumble' })).toBe(false);
        expect(t.hp.handleMessage(null)).toBe(false);
        expect(await t.hp.choose()).toEqual([wheel]);
        t.hp.handleMessage({ type: 'hidcaps', available: true });
        await vi.waitFor(() => expect(t.sent).toHaveLength(1));
        t.hp.stop();
        // The stream ends, the device stays on the host for the next one (a
        // game left running keeps its wheel): nothing is detached.
        expect(t.sent).toHaveLength(1);
    });

    it('knows which pads a row offers « as itself », by kind and USB ids', () => {
        const id = (name, vid, pid) => `${name} (STANDARD GAMEPAD Vendor: ${vid} Product: ${pid})`;
        expect(hidModelOf({ id: id('G923 Racing Wheel', '046d', 'c26e') })).toEqual({
            key: '046d:c26e',
            vendorId: 0x046d,
            productId: 0xc26e,
        });
        expect(hidModelOf({ id: id('Radiomaster TX12 Joystick', '1209', '4f54') })?.key).toBe(
            '1209:4f54',
        );
        // A plain pad, unless the viewer said what it is; no ids, no offer.
        expect(hidModelOf({ id: id('Xbox Wireless Controller', '045e', '0b13') })).toBeNull();
        expect(
            hidModelOf({ id: id('Xbox Wireless Controller', '045e', '0b13') }, 'wheel'),
        ).not.toBeNull();
        expect(hidModelOf({ id: 'Racing Wheel' })).toBeNull();
        expect(HID_KINDS).toEqual(['wheel', 'rc', 'flightstick']);
    });

    it('narrows the chooser to one model, game interfaces only, and switches it on', async () => {
        expect(modelFilters(0x046d, 0xc26e)).toContainEqual({
            vendorId: 0x046d,
            productId: 0xc26e,
            usagePage: 0x01,
            usage: 0x04,
        });
        const wheel = fakeDevice();
        const vendorOnly = fakeDevice({ usagePage: 0xfffd, usage: 0xfd01 });
        const hid = fakeHid([wheel]);
        hid.requestDevice.mockResolvedValueOnce([wheel, vendorOnly]);
        const storage = memoryStorage();
        expect(await linkModel(hid, 0x046d, 0xc26e, storage)).toEqual([wheel]);
        expect(hid.requestDevice).toHaveBeenCalledWith({ filters: modelFilters(0x046d, 0xc26e) });
        expect(Array.from(loadForwarded(storage))).toEqual(['046d:c26e']);
        // Closed without a choice, or no WebHID: nothing switched on.
        hid.requestDevice.mockRejectedValueOnce(new Error('no gesture'));
        expect(await linkModel(hid, 1, 2, memoryStorage())).toEqual([]);
        expect(await linkModel(null, 1, 2)).toEqual([]);
    });

    it('links a model from the stream and sends it at once', async () => {
        const wheel = fakeDevice();
        const t = setup([wheel]);
        t.hp.handleMessage({ type: 'hidcaps', available: true });
        await Promise.resolve();
        expect(t.sent).toHaveLength(0);
        expect(await t.hp.link(0x046d, 0xc26e)).toBe(true);
        expect(t.sent[0]).toMatchObject({ type: 'hidattach', vendorId: 0x046d });
        expect(Array.from(loadForwarded(t.storage))).toEqual(['046d:c26e']);
        t.hid.requestDevice.mockResolvedValueOnce([]);
        expect(await t.hp.link(0x046d, 0xc26e)).toBe(false);
    });

    it('holds the devices switched on off the mapped pads until the host has said', async () => {
        const wheel = fakeDevice();
        // Switched on, but no longer allowed by Chrome: held all the same.
        const t = setup([wheel], ['046d:c26e', '1209:4f54']);
        expect(t.hold().ms).toBe(HOLD_MS);
        expect(t.hp.excludedKeys().sort()).toEqual(['usb:046d:c26e', 'usb:1209:4f54']);
        t.hp.handleMessage({ type: 'hidcaps', available: true });
        // Asked for: the wheel stays off as a device being sent, the radio
        // the browser cannot open goes back to the mapped pads.
        await vi.waitFor(() => expect(t.hold()).toBeNull());
        expect(t.hp.excludedKeys()).toEqual(['usb:046d:c26e']);
        expect(t.onChange).toHaveBeenCalled();
        // Refused by the host: back to the mapped pads too.
        t.hp.handleMessage({ type: 'hidattached', slot: 0, ok: false, why: 'no driver' });
        expect(t.hp.excludedKeys()).toEqual([]);
    });

    it('lets the held devices go when the host cannot, or never says', () => {
        const cannot = setup([fakeDevice()], ['046d:c26e']);
        cannot.hp.handleMessage({ type: 'hidcaps', available: false, why: 'Sunshine' });
        expect(cannot.hp.excludedKeys()).toEqual([]);
        expect(cannot.hold()).toBeNull();

        const silent = setup([fakeDevice()], ['046d:c26e']);
        silent.onChange.mockClear();
        silent.hold().fn(); // a server too old to send hidcaps
        expect(silent.hp.excludedKeys()).toEqual([]);
        expect(silent.onChange).toHaveBeenCalledTimes(1);
    });

    it('offers a wheel never linked, once a stream, every stream', async () => {
        const wheelPad = { id: 'G923 (STANDARD GAMEPAD Vendor: 046d Product: c26e)' };
        const pad = { id: 'Xbox (STANDARD GAMEPAD Vendor: 045e Product: 0b13)' };
        const radioPad = { id: 'TX12 (STANDARD GAMEPAD Vendor: 1209 Product: 4f54)' };
        const radio = fakeDevice({ vendorId: 0x1209, productId: 0x4f54, usage: 5 });
        // The radio is allowed already (switched off by the viewer): never offered.
        const t = setup([radio]);
        expect(await t.hp.offers([wheelPad])).toEqual([]); // host has not said yet
        t.hp.handleMessage({ type: 'hidcaps', available: true });
        const first = await t.hp.offers([wheelPad, pad, radioPad, null]);
        expect(first).toEqual([
            { key: '046d:c26e', vendorId: 0x046d, productId: 0xc26e, name: 'G923' },
        ]);
        expect(await t.hp.offers([wheelPad])).toEqual([]); // once a stream

        const streamAgain = () => {
            const hp = new HidPassthrough({
                hid: t.hid,
                send: () => {},
                sendFrame: () => true,
                storage: t.storage,
                later: () => null,
            });
            hp.handleMessage({ type: 'hidcaps', available: true });
            return hp.offers([wheelPad]);
        };
        // No cap: an offer missed is made again, stream after stream.
        for (let i = 0; i < 5; i++) expect(await streamAgain()).toHaveLength(1);
    });

    it('says WebHID is missing rather than failing', async () => {
        const hp = new HidPassthrough({
            hid: null,
            send: () => {},
            sendFrame: () => true,
            storage: memoryStorage(),
        });
        expect(hp.supported).toBe(false);
        expect(await hp.devices()).toEqual([]);
        expect(await hp.choose()).toEqual([]);
        expect(await hp.offers([{ id: 'G923 (Vendor: 046d Product: c26e)' }])).toEqual([]);
        expect(await hp.link(0x046d, 0xc26e)).toBe(false);
        await hp.applyWanted();
        hp.stop();
    });
});

describe('HidPassthrough — a Wii Remote, for a GameStream host on its own machine', () => {
    const b64 = (bytes) => globalThis.btoa(String.fromCharCode(...bytes));
    const output = (slot, reportId, bytes) => ({
        type: 'hidrequest',
        slot,
        kind: 'output',
        reportId,
        data: b64(bytes),
    });

    async function attached(remote, caps = { available: true, wiimote: true }) {
        const t = setup([remote], [deviceKey(remote)]);
        t.hp.handleMessage({ type: 'hidcaps', ...caps });
        // A Wii Remote attaches through the live-pick, never applyWanted (a DolphinBar's four identical
        // entries share one key): StreamView calls this on the same hidcaps.
        await t.hp.linkWiimoteRemembered();
        await vi.waitFor(() => expect(t.sent).toHaveLength(1));
        t.hp.handleMessage({ type: 'hidattached', slot: 0, ok: true });
        return t;
    }

    it('links through a chooser narrowed to the two Wii Remotes, and sends it', async () => {
        const remote = fakeWiimote();
        const t = setup([remote]);
        t.hp.handleMessage({ type: 'hidcaps', available: true });
        const chosen = await t.hp.linkWiimote();
        expect(chosen).toEqual([remote]);
        expect(t.hid.requestDevice).toHaveBeenCalledWith({
            filters: [
                { vendorId: 0x057e, productId: 0x0306 },
                { vendorId: 0x057e, productId: 0x0330 },
            ],
        });
        expect(loadForwarded(t.storage).has('057e:0306')).toBe(true);
        expect(t.sent[0]).toMatchObject({ type: 'hidattach', vendorId: 0x057e, productId: 0x0306 });
    });

    it('picks the live DolphinBar entry among four, attaches only it, closes the rest', async () => {
        const dead1 = fakeWiimote();
        const live = fakeWiimote();
        const dead2 = fakeWiimote();
        const dead3 = fakeWiimote();
        const all = [dead1, live, dead2, dead3];
        const t = setup(all);
        t.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        t.hid.requestDevice.mockResolvedValueOnce(all);

        const p = t.hp.linkWiimote();
        // Every entry is opened and nudged with a status request (0x15).
        await vi.waitFor(() =>
            all.forEach((d) => expect(d.sendReport).toHaveBeenCalledWith(0x15, expect.anything())),
        );
        // The entry with the synced remote streams; it wins.
        live.report(0x30, [0x00, 0x00]);
        const chosen = await p;

        expect(chosen).toEqual([live]);
        expect(t.sent.filter((m) => m.type === 'hidattach')).toHaveLength(1);
        expect(t.sent[0]).toMatchObject({ type: 'hidattach', slot: 0 });
        for (const d of [dead1, dead2, dead3]) expect(d.close).toHaveBeenCalled();
        expect(live.close).not.toHaveBeenCalled();
    });

    it('falls back to the first entry if none answer in time', async () => {
        const a = fakeWiimote();
        const b = fakeWiimote();
        // A delay that fires at once makes the probe time out with no report.
        const t = setup([a, b]);
        t.hp = new (Object.getPrototypeOf(t.hp).constructor)({
            hid: t.hid,
            send: (m) => t.sent.push(m),
            sendFrame: () => true,
            storage: t.storage,
            now: () => 0,
            delay: () => Promise.resolve(),
        });
        t.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        t.hid.requestDevice.mockResolvedValueOnce([a, b]);
        const chosen = await t.hp.linkWiimote();
        expect(chosen).toEqual([a]);
        expect(b.close).toHaveBeenCalled();
    });

    it('a single entry (a real Bluetooth remote) attaches without a status probe', async () => {
        const remote = fakeWiimote();
        const t = setup([remote]);
        t.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        const chosen = await t.hp.linkWiimote();
        expect(chosen).toEqual([remote]);
        // No selection ping: the only output a lone remote gets is the game's, later.
        expect(remote.sendReport).not.toHaveBeenCalledWith(0x15, expect.anything());
    });

    it('sends its answers once on the reliable channel, its data reports on hid', async () => {
        const remote = fakeWiimote();
        const t = await attached(remote);
        remote.report(0x20, [0, 0, 0, 0, 0, 0x96]); // status
        remote.report(0x21, Array(21).fill(7)); // a memory read
        remote.report(0x22, [0, 0, 0x16, 0]); // an acknowledged write
        expect(t.sent.slice(1)).toEqual([
            { type: 'hidreply', slot: 0, reportId: 0x20, data: b64([0, 0, 0, 0, 0, 0x96]) },
            { type: 'hidreply', slot: 0, reportId: 0x21, data: b64(Array(21).fill(7)) },
            { type: 'hidreply', slot: 0, reportId: 0x22, data: b64([0, 0, 0x16, 0]) },
        ]);
        expect(t.frames).toHaveLength(0);
        // Never repeated: only data reports are.
        t.advance(2000);
        expect(t.frames).toHaveLength(0);
        expect(t.sent).toHaveLength(4);

        remote.report(0x30, [0x00, 0x08]); // buttons
        expect(t.frames).toHaveLength(1);
        expect(decodeReportFrame(t.frames[0])).toMatchObject({ slot: 0, reportId: 0x30 });
    });

    it('writes what the game sends to the real remote, in order, without the id byte', async () => {
        const remote = fakeWiimote();
        const t = await attached(remote);
        // Linux hands each report with its id first; the rumble bit is the game's.
        t.hp.handleMessage(output(0, 0x11, [0x11, 0x10])); // light 1
        t.hp.handleMessage(output(0, 0x12, [0x12, 0x01, 0x31])); // report mode 0x31, rumble on
        t.hp.handleMessage(output(0, 0x16, [0x16, 0x04, 0xb0, 0x00, 0x30, 0x01, 0x08]));
        await vi.waitFor(() => expect(remote.sent).toHaveLength(3));
        expect(remote.sent).toEqual([
            [0x11, [0x10]],
            [0x12, [0x01, 0x31]],
            [0x16, [0x04, 0xb0, 0x00, 0x30, 0x01, 0x08]],
        ]);
        expect(t.hp.requests).toBe(3);
    });

    it('writes nothing unless the host said the game drives the remote, nor before it took it', async () => {
        // A host that recreates devices but did not opt in (the native host).
        const remote = fakeWiimote();
        const t = await attached(remote, { available: true });
        t.hp.handleMessage(output(0, 0x11, [0x11, 0x10]));
        await Promise.resolve();
        expect(remote.sendReport).not.toHaveBeenCalled();
        expect(t.hp.requests).toBe(1);

        // Opted in, but the device not taken yet (no hidattached).
        const pending = fakeWiimote();
        const u = setup([pending], [deviceKey(pending)]);
        u.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        await u.hp.linkWiimoteRemembered();
        await vi.waitFor(() => expect(u.sent).toHaveLength(1));
        u.hp.handleMessage(output(0, 0x11, [0x11, 0x10]));
        await Promise.resolve();
        expect(pending.sendReport).not.toHaveBeenCalled();
    });

    it('waits for each write before the next', async () => {
        const remote = fakeWiimote();
        let release;
        const order = [];
        remote.sendReport = vi.fn((id) => {
            order.push(`start ${id}`);
            return id === 0x13
                ? new Promise((r) => (release = () => (order.push('end 19'), r())))
                : Promise.resolve(order.push(`end ${id}`));
        });
        const t = await attached(remote);
        t.hp.handleMessage(output(0, 0x13, [0x13, 0x04])); // camera on: slow
        t.hp.handleMessage(output(0, 0x1a, [0x1a, 0x04]));
        await vi.waitFor(() => expect(order).toEqual(['start 19']));
        release();
        await vi.waitFor(() => expect(order).toEqual(['start 19', 'end 19', 'start 26', 'end 26']));
    });

    it('writes nothing outside the Wii Remote output set, nor a feature', async () => {
        const remote = fakeWiimote();
        const t = await attached(remote);
        t.hp.handleMessage(output(0, 0x30, [0x30, 0]));
        t.hp.handleMessage(output(0, 0x0f, [0x0f, 0]));
        t.hp.handleMessage({ ...output(0, 0x11, [0x11, 0x10]), kind: 'setfeature' });
        await Promise.resolve();
        await Promise.resolve();
        expect(remote.sendReport).not.toHaveBeenCalled();
        expect(t.hp.requests).toBe(3); // still counted
    });

    it('stops writing once the remote is let go, and survives a write that fails', async () => {
        const failing = fakeWiimote({ sendFails: true });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const t = await attached(failing);
        t.hp.handleMessage(output(0, 0x11, [0x11, 0x10]));
        t.hp.handleMessage(output(0, 0x11, [0x11, 0x20]));
        await vi.waitFor(() => expect(failing.sendReport).toHaveBeenCalledTimes(2));
        expect(warn).toHaveBeenCalledTimes(1); // once, not per write
        warn.mockRestore();

        const remote = fakeWiimote();
        const u = await attached(remote);
        u.hp.handleMessage({ type: 'hidcaps', available: false, why: 'gone' });
        u.hp.handleMessage(output(0, 0x11, [0x11, 0x10]));
        await Promise.resolve();
        expect(remote.sendReport).not.toHaveBeenCalled();
    });

    it('tells the stream page when a Wii Remote attaches, its status, and when it drops', async () => {
        const remote = fakeWiimote();
        const t = await attached(remote);
        expect(t.wiimote).toContainEqual({
            type: 'attached',
            slot: 0,
            name: 'Nintendo RVL-CNT-01',
        });
        // 0x20 status: buttons(2) flags(1) 00 00 battery(1). flags 0xf2 = lights 1-4 + extension bit.
        remote.report(0x20, [0, 0, 0xf2, 0, 0, 0x55]);
        expect(t.wiimote).toContainEqual({
            type: 'status',
            slot: 0,
            battery: 0x55,
            extension: true,
            leds: 0xf,
        });
        t.hid.unplug(remote);
        expect(t.wiimote).toContainEqual({ type: 'detached', slot: 0 });
    });

    it('reconnects a remembered remote with no chooser, and attaches only a live one', async () => {
        const remote = fakeWiimote();
        const t = setup([remote], [deviceKey(remote)]);
        t.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        const got = await t.hp.linkWiimoteRemembered(); // one entry: a lone Bluetooth remote, no probe
        expect(got).toBe(remote);
        expect(t.hid.requestDevice).not.toHaveBeenCalled();
        expect(t.sent[0]).toMatchObject({ type: 'hidattach', vendorId: 0x057e });
    });

    it('does not reconnect when a DolphinBar has no live entry', async () => {
        const dead1 = fakeWiimote();
        const dead2 = fakeWiimote();
        const t = setup([dead1, dead2], [deviceKey(dead1)]);
        t.hp = new (Object.getPrototypeOf(t.hp).constructor)({
            hid: t.hid,
            send: () => {},
            sendFrame: () => true,
            storage: t.storage,
            now: () => 0,
            delay: () => Promise.resolve(), // the probe times out at once, nothing streams
        });
        t.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        const got = await t.hp.linkWiimoteRemembered();
        expect(got).toBe(null);
    });

    it('never writes to a device that is not a Wii Remote (a wheel keeps today’s rule)', async () => {
        const wheel = fakeDevice();
        wheel.sendReport = vi.fn(async () => {});
        const t = setup([wheel], ['046d:c26e']);
        t.hp.handleMessage({ type: 'hidcaps', available: true });
        await vi.waitFor(() => expect(t.sent).toHaveLength(1));
        t.hp.handleMessage({ type: 'hidattached', slot: 0, ok: true });
        t.hp.handleMessage(output(0, 0x11, [0x11, 0x10]));
        await Promise.resolve();
        expect(wheel.sendReport).not.toHaveBeenCalled();
        expect(t.hp.requests).toBe(1);
    });

    it('lists a Wii Remote by its ids even when its collections say nothing of a game pad', async () => {
        // What a DolphinBar declares above its remotes is not known yet.
        const remote = fakeWiimote();
        remote.collections[0].usagePage = 0xff00;
        remote.collections[0].usage = 1;
        const t = setup([remote], ['057e:0306']);
        expect((await t.hp.devices()).map((d) => d.key)).toEqual(['057e:0306']);
        t.hp.handleMessage({ type: 'hidcaps', available: true });
        // Attaches through the live-pick (never applyWanted, which skips wiimotes).
        await t.hp.linkWiimoteRemembered();
        await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    });

    it('never attaches a Wii Remote through applyWanted — only the live-pick may (a DolphinBar grants four identical entries)', async () => {
        // All four of a DolphinBar's 057e:0306 entries share one deviceKey, so a "wanted" key would
        // attach every one; the host takes the first (often an empty slot) and rejects the rest. The
        // live-pick alone probes and keeps the streaming one — applyWanted must leave wiimotes to it.
        const remote = fakeWiimote();
        const t = setup([remote], [deviceKey(remote)]); // the key is remembered (wanted)
        t.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        await t.hp.applyWanted();
        await Promise.resolve();
        expect(t.sent).toHaveLength(0); // applyWanted skipped the wiimote
        // The live-pick (which StreamView calls on the same hidcaps) still attaches it.
        const live = await t.hp.linkWiimoteRemembered();
        expect(live).toBeTruthy();
        await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    });
});

describe('HidPassthrough — a Wii Remote that does not connect says why (2026-11-13)', () => {
    const CANT = "This host can't take a Wii Remote right now.";

    it("opens no chooser when the host can't take one, and says the host's words", async () => {
        const t = setup([fakeWiimote()]);
        t.hp.handleMessage({ type: 'hidcaps', available: false, why: CANT });
        expect(await t.hp.linkWiimote()).toEqual([]);
        expect(t.hid.requestDevice).not.toHaveBeenCalled();
        expect(t.sent.filter((m) => m.type === 'hidattach')).toHaveLength(0);
        expect(t.wiimote).toContainEqual({ type: 'refused', slot: -1, why: CANT });
    });

    it('before the host has said anything: refused, no reason of its own, no chooser', async () => {
        const t = setup([fakeWiimote()]);
        expect(await t.hp.linkWiimote()).toEqual([]);
        expect(t.hid.requestDevice).not.toHaveBeenCalled();
        expect(t.wiimote).toContainEqual({ type: 'refused', slot: -1, why: '' });
    });

    it('a chooser closed with nothing picked comes back as cancelled', async () => {
        const t = setup([fakeWiimote()]);
        t.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        t.hid.requestDevice.mockResolvedValueOnce([]);
        expect(await t.hp.linkWiimote()).toEqual([]);
        expect(t.wiimote).toEqual([{ type: 'cancelled' }]);
    });

    it("a remote the browser can't open: refused, the browser's doing, nothing sent", async () => {
        const remote = fakeWiimote({ openFails: true });
        const t = setup([remote]);
        t.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        expect(await t.hp.linkWiimote()).toEqual([]);
        expect(t.sent.filter((m) => m.type === 'hidattach')).toHaveLength(0);
        expect(t.wiimote).toContainEqual(
            expect.objectContaining({ type: 'refused', local: 'unopened' }),
        );
    });

    it("the host's refusal of a Wii Remote is said as one, in its words", async () => {
        const remote = fakeWiimote();
        const t = setup([remote]);
        t.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        expect(await t.hp.linkWiimote()).toEqual([remote]);
        t.hp.handleMessage({ type: 'hidattached', slot: 0, ok: false, why: CANT });
        expect(t.wiimote).toContainEqual({ type: 'refused', slot: 0, why: CANT });
    });

    it('a live-picked DolphinBar entry has been heard; the fallback entry only once it reports', async () => {
        const dead = fakeWiimote();
        const live = fakeWiimote();
        const t = setup([dead, live]);
        t.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        t.hid.requestDevice.mockResolvedValueOnce([dead, live]);
        const p = t.hp.linkWiimote();
        await vi.waitFor(() => expect(live.sendReport).toHaveBeenCalled());
        live.report(0x30, [0x00, 0x00]);
        expect(await p).toEqual([live]);
        expect(t.wiimote).toContainEqual({ type: 'heard', slot: 0 });

        // None answer (a bar with no remote synced, or asleep): the first entry attaches, unheard.
        const a = fakeWiimote();
        const b = fakeWiimote();
        const u = setup([a, b]);
        const events = [];
        u.hp = new (Object.getPrototypeOf(u.hp).constructor)({
            hid: u.hid,
            send: (m) => u.sent.push(m),
            sendFrame: () => true,
            storage: u.storage,
            now: () => 0,
            delay: () => Promise.resolve(),
            onWiimote: (e) => events.push(e),
        });
        u.hp.handleMessage({ type: 'hidcaps', available: true, wiimote: true });
        u.hid.requestDevice.mockResolvedValueOnce([a, b]);
        expect(await u.hp.linkWiimote()).toEqual([a]);
        expect(events.filter((e) => e.type === 'heard')).toHaveLength(0);
        a.report(0x30, [0x00, 0x08]); // the remote wakes and speaks
        a.report(0x30, [0x00, 0x00]);
        expect(events.filter((e) => e.type === 'heard')).toEqual([{ type: 'heard', slot: 0 }]);
    });
});

describe('hidHelpFor (« As itself » on a host that cannot)', () => {
    const native = (hid) => ({ backendType: 'native', nativeDisplay: { hid } });
    const sunshine = { backendType: '' };

    it('lets the switch link when a native host takes the device', () => {
        expect(hidHelpFor([native('ok')])).toBeNull();
        expect(hidHelpFor([sunshine, native('ok')])).toBeNull();
        // Linux without uhid access: the stream says what is wrong.
        expect(hidHelpFor([native('setup')])).toBeNull();
    });

    it('stays out of the way when it cannot tell', () => {
        expect(hidHelpFor(null)).toBeNull();
        expect(hidHelpFor([])).toBeNull();
        // A server too old to say.
        expect(hidHelpFor([{ backendType: 'native', nativeDisplay: {} }])).toBeNull();
    });

    it('says why not otherwise', () => {
        expect(hidHelpFor([native('driver_missing')])).toBe('windows');
        expect(hidHelpFor([native('unsupported')])).toBe('macos');
        expect(hidHelpFor([sunshine])).toBe('none');
        expect(hidHelpFor([sunshine, native('driver_missing')])).toBe('windows');
    });
});
