/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

import {
    GAME_FILTERS,
    HID_MAX_SLOTS,
    HidReportPump,
    WIIMOTE_FILTERS,
    WIIMOTE_REPLY_IDS,
    attachMessage,
    detachMessage,
    isGameDevice,
    isWiimote,
    isWiimoteOutput,
    modelFilters,
} from './hidWire.js';
import { padKind, padName, parsePadId } from '../stream/gamepadMapping.js';
import { HidppFfbPlayer, HidppTransport, findFfbFeature, hasHidpp } from './hidppFfb.js';
import { PidFfbPlayer, hasNativePid } from './pidFfb.js';
import { HidppRelay, hidppInputIds, isHidppReport } from './hidppRelay.js';

/**
 * The HID passthrough in the stream (plan « Passthrough HID », P2): the game
 * devices the viewer chose are sent to the host as themselves — the real
 * wheel or radio, not an Xbox pad — when the host says it can (`hidcaps`).
 *
 * Which devices: the ones Chrome already lets this page open (a click in its
 * chooser, kept by Chrome for a device with a serial number) whose key the
 * viewer switched on, kept in localStorage (`mw_hid_forward`). Settings holds
 * the switches, on each wheel's, radio's or stick's own row: the first click
 * opens Chrome's chooser narrowed to that model (linkModel). The stream applies
 * them, and offers the link for such a device plugged in but never linked
 * (offers(), once a stream per model).
 *
 * A device switched on is held back from the mapped pads (excludedKeys) from
 * the stream's start until the host has said whether it takes it: the game
 * never sees an Xbox pad come and go before the real wheel. Without an answer
 * within HOLD_MS (a server too old to send `hidcaps`) the hold lets go.
 *
 * What the host asks back (`hidrequest`: output reports, features) is counted
 * and never written to the real device: a host writing to a wheel's vendor
 * interface could reprogram it.
 *
 * One exception, the Wii Remote (isWiimote), which only a GameStream host on
 * its own machine takes (Wolf on LOLA, behind its operator's setting): the game
 * drives the real remote itself — lights, rumble, the camera's and the
 * extensions' set-up, the speaker — so the host's output reports (0x10–0x1a,
 * its whole set) are written to it, in the order they came, one at a time.
 * Its answers (status, memory reads, acknowledgements) go back as `hidreply`
 * on this reliable channel; its data reports on 'hid' as any device's.
 * linkWiimote() opens Chrome's chooser for it.
 *
 * Force feedback (P4) takes its own road, and only when the host says it can
 * (`hidcaps.ffb`): the host decodes what the game asks of the recreated wheel
 * into neutral operations (`hidffb`), and this page plays them through a
 * driver of its own for the real wheel's protocol: Logitech's HID++ 0x8123
 * (hidppFfb.js), or the wheel's own USB PID reports for the wheels that
 * speak PID (pidFfb.js: Moza, Simucube, Fanatec…). The host never writes raw
 * bytes to the wheel. When the device stops being sent, the wheel is reset
 * and left free.
 *
 * A Linux host (`hidcaps.hidpp`) instead lets its kernel's Logitech driver
 * talk HID++ to the recreated wheel (its probe waits on the answers): this page
 * relays those requests to the real wheel through a filter (hidppRelay.js)
 * and sends the answers back as `hidreply`. A HID++ device's own HID++ input
 * reports never go on the 'hid' channel: they are answers and notifications
 * for whoever asked on this side, and the channel's repeats would replay them.
 */

export const FORWARD_KEY = 'mw_hid_forward';
const TICK_MS = 100;
export const HOLD_MS = 3000;
// A DolphinBar grants four identical 057e:0306 entries at once; only the slot with the synced remote
// answers. Keep whichever delivers a report first (a live one streams) within this window, closing the
// rest; a status request nudges a quiet-but-live entry. A real Bluetooth remote is a single entry and
// skips the probe. Long enough for a streaming entry to speak, short enough not to stall the click.
const WIIMOTE_PROBE_MS = 500;
const WIIMOTE_STATUS = 0x15;

/** `vid:pid` in lowercase hex: how a device is remembered. */
export function deviceKey(device) {
    const h = (n) => (n >>> 0).toString(16).padStart(4, '0');
    return `${h(device.vendorId)}:${h(device.productId)}`;
}

const toBase64 = (bytes) => globalThis.btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => {
    try {
        return Uint8Array.from(globalThis.atob(String(text || '')), (c) => c.charCodeAt(0));
    } catch {
        return new Uint8Array(0);
    }
};

/** A device this page may send: a game device, or a Wii Remote by its ids. */
function sendable(device) {
    return isGameDevice(device.collections) || isWiimote(device);
}

/** The key GamepadManager knows the same device by. */
export function padKeyOf(device) {
    return `usb:${deviceKey(device)}`;
}

export function loadForwarded(storage = globalThis.localStorage) {
    try {
        const v = JSON.parse(storage?.getItem(FORWARD_KEY) || '[]');
        return new Set(Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []);
    } catch {
        return new Set();
    }
}

export function saveForwarded(keys, storage = globalThis.localStorage) {
    try {
        storage?.setItem(FORWARD_KEY, JSON.stringify(Array.from(keys)));
    } catch {
        /* private window: the switch lasts this page */
    }
}

/** The pads a mapping shortchanges most: their rows offer « as itself ». */
export const HID_KINDS = ['wheel', 'rc', 'flightstick'];

/**
 * The model a pad the Gamepad API sees could be sent as, or null: a wheel,
 * radio or stick the browser gives USB ids for. `kind` overrides the guess
 * (the viewer's choice, from the mappings store).
 * @param {Gamepad|{id: string}} gp
 * @param {string} [kind]
 */
export function hidModelOf(gp, kind = padKind(gp?.id)) {
    const { vid, pid } = parsePadId(gp?.id);
    if (!vid || !pid || !HID_KINDS.includes(kind)) return null;
    return { key: `${vid}:${pid}`, vendorId: parseInt(vid, 16), productId: parseInt(pid, 16) };
}

/**
 * Chrome's chooser for one model, game interfaces only; what the viewer
 * picked is switched on. Needs the click that called it.
 * @returns {Promise<HIDDevice[]>}
 */
export async function linkModel(hid, vendorId, productId, storage = globalThis.localStorage) {
    if (!hid) return [];
    let chosen = [];
    try {
        chosen = await hid.requestDevice({ filters: modelFilters(vendorId, productId) });
    } catch {
        chosen = [];
    }
    chosen = chosen.filter((d) => isGameDevice(d.collections));
    if (chosen.length) {
        const keys = loadForwarded(storage);
        for (const d of chosen) keys.add(deviceKey(d));
        saveForwarded(keys, storage);
    }
    return chosen;
}

/**
 * Whether Settings' « As itself » may link a device, from this page's hosts
 * (GET /api/hosts): null when a native host here takes it — Linux, or Windows
 * with "MoonlightWeb Virtual HID" (signed, or activated by hand) — or when it
 * cannot be told (no list, a server too old to say); otherwise why not, for
 * the help popin: 'windows' (no driver), 'macos', 'none' (no native host).
 * @param {Array<{backendType?: string, nativeDisplay?: {hid?: string}}>|null} hosts
 * @returns {null|'windows'|'macos'|'none'}
 */
export function hidHelpFor(hosts) {
    if (!Array.isArray(hosts) || !hosts.length) return null;
    const native = hosts.map((h) => (h?.backendType === 'native' ? h.nativeDisplay?.hid : null));
    // Linux without uhid access ('setup') still takes the switch: the package
    // sets it up, and the stream says what is wrong if it is not.
    if (native.some((s) => s === 'ok' || s === 'setup' || s === '' || s === undefined)) return null;
    if (native.includes('driver_missing')) return 'windows';
    if (native.includes('unsupported')) return 'macos';
    return 'none';
}

export class HidPassthrough {
    /**
     * @param {object} o
     * @param {HID} [o.hid] navigator.hid
     * @param {(msg: object) => void} o.send JSON on the input channel
     * @param {(frame: Uint8Array) => boolean} o.sendFrame the 'hid' channel
     * @param {() => void} [o.onChange] the device list or a state changed
     * @param {(device: HIDDevice, ok: boolean, why: string) => void} [o.onResult]
     *     the host's answer to an attach, to tell the viewer
     */
    constructor({
        hid = globalThis.navigator?.hid,
        send,
        sendFrame,
        storage = globalThis.localStorage,
        now = () => performance.now(),
        setTimer = (fn, ms) => setInterval(fn, ms),
        clearTimer = (t) => clearInterval(t),
        later = (fn, ms) => setTimeout(fn, ms),
        cancelLater = (t) => clearTimeout(t),
        delay = (ms) => new Promise((r) => setTimeout(r, ms)),
        onChange = null,
        onResult = null,
        onWiimote = null,
    }) {
        this._hid = hid || null;
        this._onWiimote = onWiimote;
        this._send = send;
        this._sendFrame = sendFrame;
        this._storage = storage;
        this._now = now;
        this._setTimer = setTimer;
        this._clearTimer = clearTimer;
        this._cancelLater = cancelLater;
        this._delay = delay;
        this._onChange = onChange;
        this._onResult = onResult;
        this._caps = null; // { available, why } once the host said
        this._pump = new HidReportPump();
        this._entries = new Map(); // HIDDevice -> { slot, state, why, listener }
        this._timer = null;
        this._requests = 0;
        this._offered = new Set(); // models offered in this stream
        // Devices switched on wait for the host's word (see the file comment).
        this._holding = !!this._hid;
        this._holdTimer = this._holding ? later(() => this._letGo(), HOLD_MS) : null;
        this._onDisconnect = (e) => this._drop(e.device, 'unplugged');
        if (this._hid) this._hid.addEventListener('disconnect', this._onDisconnect);
    }

    /** WebHID in this browser at all (Chrome and Edge on a computer). */
    get supported() {
        return !!this._hid;
    }

    /** What the host said: null before, then { available, why }. */
    get caps() {
        return this._caps;
    }

    /** Host requests seen (output reports, features), for diagnostics. */
    get requests() {
        return this._requests;
    }

    /** Devices this page may open that are game devices, with their state. */
    async devices() {
        if (!this._hid) return [];
        const forwarded = loadForwarded(this._storage);
        const list = await this._hid.getDevices();
        return list.filter(sendable).map((d) => {
            const e = this._entries.get(d);
            return {
                device: d,
                key: deviceKey(d),
                name: d.productName || deviceKey(d),
                wanted: forwarded.has(deviceKey(d)),
                state: e ? e.state : 'off',
                why: e ? e.why : '',
            };
        });
    }

    /**
     * Keys GamepadManager must not forward: devices sent, or being sent, as
     * HID — and, until the host has said, every device switched on.
     */
    excludedKeys() {
        const out = new Set();
        if (this._holding) for (const k of loadForwarded(this._storage)) out.add(`usb:${k}`);
        for (const [d, e] of this._entries)
            if (e.state === 'on' || e.state === 'pending') out.add(padKeyOf(d));
        return Array.from(out);
    }

    /** A message from the host; true when it was one of ours. */
    handleMessage(msg) {
        if (!msg || typeof msg.type !== 'string') return false;
        if (msg.type === 'hidcaps') {
            this._caps = {
                available: !!msg.available,
                ffb: !!msg.ffb,
                hidpp: !!msg.hidpp,
                // The host said the game drives the real Wii Remote (a
                // GameStream host on its own machine, opted in): only then are
                // its output reports written to it.
                wiimote: !!msg.wiimote,
                why: String(msg.why || ''),
            };
            if (this._caps.available) {
                // The hold lasts until the devices are asked for: from then on
                // the attaches themselves keep them off the mapped pads.
                this.applyWanted()
                    .catch(() => {})
                    .finally(() => this._letGo());
            } else {
                this._dropAll(this._caps.why);
                this._letGo();
            }
            this._changed();
            return true;
        }
        if (msg.type === 'hidattached') {
            const entry = this._entryBySlot(msg.slot);
            if (entry) {
                const [device, e] = entry;
                if (msg.ok) {
                    e.state = 'on';
                    e.why = '';
                    if (isWiimote(device))
                        this._onWiimote?.({
                            type: 'attached',
                            slot: e.slot,
                            name: device.productName || '',
                        });
                    if (e.ffb) this._startFfb(e);
                    else if (this._caps?.hidpp && hasHidpp(device)) this._startRelay(device, e);
                } else {
                    this._release(device, e);
                    e.state = 'refused';
                    e.why = String(msg.why || '');
                }
                if (this._onResult) this._onResult(device, !!msg.ok, e.why);
                this._changed();
            }
            return true;
        }
        if (msg.type === 'hidrequest') {
            this._requests++;
            const entry = this._entryBySlot(msg.slot);
            if (entry && isWiimote(entry[0])) {
                // Written only for a host that said the game drives the remote
                // (hidcaps.wiimote), and only once it took the device.
                if (
                    this._caps?.wiimote &&
                    entry[1].state === 'on' &&
                    msg.kind === 'output' &&
                    isWiimoteOutput(msg.reportId)
                )
                    this._writeWiimote(entry[0], entry[1], msg.reportId, fromBase64(msg.data));
                return true;
            }
            const relay = entry?.[1].relay;
            if (relay && msg.kind === 'output' && isHidppReport(msg.reportId)) {
                let bytes = fromBase64(msg.data);
                // Linux hands the report with its id first.
                if (bytes[0] === msg.reportId && (bytes.length === 20 || bytes.length === 64))
                    bytes = bytes.subarray(1);
                relay.handle(msg.reportId, bytes);
            }
            return true;
        }
        if (msg.type === 'hidffb') {
            const entry = this._entryBySlot(msg.slot);
            entry?.[1].ffb?.player?.apply(msg);
            return true;
        }
        return false;
    }

    /** Switch a device on or off for this viewer, and apply it now. */
    async setWanted(device, on) {
        const keys = loadForwarded(this._storage);
        if (on) keys.add(deviceKey(device));
        else keys.delete(deviceKey(device));
        saveForwarded(keys, this._storage);
        if (on) await this._attach(device);
        else this._drop(device, '');
        this._changed();
    }

    /**
     * Attach every wanted device this page may open; called when the host can.
     * A Wii Remote is never attached here: a DolphinBar grants four identical 057e:0306 entries that
     * all share one deviceKey (vid:pid), so a wanted key would attach all four — the host takes the
     * first (often an empty slot) and rejects the rest ("one Wii Remote per player"), leaving the game
     * bound to a slot with no remote. Only _pickLiveWiimote may choose among them: it probes and keeps
     * the one that streams. Reconnect runs through linkWiimoteRemembered / the Connect banner.
     */
    async applyWanted() {
        if (!this._hid || !this._caps?.available) return;
        const keys = loadForwarded(this._storage);
        for (const d of await this._hid.getDevices()) {
            if (keys.has(deviceKey(d)) && sendable(d) && !isWiimote(d)) await this._attach(d);
        }
        this._changed();
    }

    /** Chrome's chooser, game devices only; needs the click that called it. */
    async choose() {
        if (!this._hid) return [];
        try {
            return await this._hid.requestDevice({ filters: GAME_FILTERS });
        } catch {
            return [];
        }
    }

    /**
     * The chooser for one model, from a click (the stream's offer); what the
     * viewer picked is switched on and sent at once when the host can.
     * @returns {Promise<boolean>} something was linked
     */
    async link(vendorId, productId) {
        const chosen = await linkModel(this._hid, vendorId, productId, this._storage);
        for (const d of chosen) await this._attach(d);
        this._changed();
        return chosen.length > 0;
    }

    /**
     * Chrome's chooser for a Wii Remote, from a click, tap or key press (a
     * gamepad press does not count). What the viewer picked is switched on —
     * remembered as the other devices are — and sent at once when the host can.
     * @returns {Promise<HIDDevice[]>} the remotes picked
     */
    async linkWiimote() {
        if (!this._hid) return [];
        let chosen = [];
        try {
            chosen = await this._hid.requestDevice({ filters: WIIMOTE_FILTERS });
        } catch {
            chosen = [];
        }
        chosen = chosen.filter(isWiimote);
        const live = await this._pickLiveWiimote(chosen);
        if (!live) {
            this._changed();
            return [];
        }
        const keys = loadForwarded(this._storage);
        keys.add(deviceKey(live));
        saveForwarded(keys, this._storage);
        await this._attach(live);
        this._changed();
        return [live];
    }

    /**
     * The one live entry among what the chooser granted. A DolphinBar hands over four identical
     * 057e:0306 entries and only the slot with the synced remote streams; a real Bluetooth remote is a
     * single entry. Open each, nudge it with a status request, and keep whichever reports first within
     * WIIMOTE_PROBE_MS; close the rest so the host never clones an empty slot. If none speak in time,
     * fall back to the first that opened, which the quiet-watchdog can re-pick once it is attached.
     * @param {HIDDevice[]} candidates
     * @returns {Promise<HIDDevice|null>}
     */
    async _pickLiveWiimote(candidates, { requireLive = false } = {}) {
        const open = [];
        for (const d of candidates) {
            try {
                if (!d.opened) await d.open();
                open.push(d);
            } catch {
                /* an entry that will not open is not a candidate */
            }
        }
        if (open.length <= 1) return open[0] ?? null;
        const listeners = new Map();
        const winner = await new Promise((resolve) => {
            let done = false;
            const finish = (d) => {
                if (!done) {
                    done = true;
                    resolve(d);
                }
            };
            for (const d of open) {
                const listener = () => finish(d);
                d.addEventListener('inputreport', listener);
                listeners.set(d, listener);
                // A live entry already streams; the status request only wakes a quiet-but-connected one.
                Promise.resolve()
                    .then(() => d.sendReport(WIIMOTE_STATUS, new Uint8Array([0x00])))
                    .catch(() => {});
            }
            this._delay(WIIMOTE_PROBE_MS).then(() => finish(requireLive ? null : open[0]));
        });
        for (const [d, listener] of listeners) d.removeEventListener('inputreport', listener);
        for (const d of open) {
            if (d !== winner) {
                try {
                    await d.close?.();
                } catch {
                    /* closing an unused entry is best effort */
                }
            }
        }
        return winner;
    }

    /**
     * Reconnect a Wii Remote the viewer already allowed, with no click — Chrome keeps the permission
     * for a device whose serial it can read. getDevices() needs no gesture; a live entry is attached
     * (a DolphinBar's four are narrowed to the streaming one), a dead or absent one left alone.
     * @returns {Promise<HIDDevice|null>} the remote reconnected, or null
     */
    async linkWiimoteRemembered() {
        if (!this._hid) return null;
        let remembered = [];
        try {
            remembered = (await this._hid.getDevices()).filter(isWiimote);
        } catch {
            return null;
        }
        if (!remembered.length) return null;
        const live = await this._pickLiveWiimote(remembered, { requireLive: true });
        if (!live) return null;
        const keys = loadForwarded(this._storage);
        keys.add(deviceKey(live));
        saveForwarded(keys, this._storage);
        await this._attach(live);
        this._changed();
        return live;
    }

    /**
     * The pads worth offering to send as themselves, when the host can: a
     * wheel, radio or stick model this browser may not open yet. A model the
     * viewer allowed then switched off is never offered: that was a choice.
     * Each model once a stream, every stream until it is linked.
     * @param {Array<Gamepad|{id: string}>} pads
     * @returns {Promise<Array<{key: string, vendorId: number, productId: number, name: string}>>}
     */
    async offers(pads) {
        if (!this._hid || !this._caps?.available) return [];
        let permitted;
        try {
            permitted = new Set(
                (await this._hid.getDevices())
                    .filter((d) => isGameDevice(d.collections))
                    .map(deviceKey),
            );
        } catch {
            return [];
        }
        const out = [];
        for (const gp of pads) {
            const m = gp && hidModelOf(gp);
            if (!m || permitted.has(m.key) || this._offered.has(m.key)) continue;
            this._offered.add(m.key);
            out.push({ ...m, name: padName(gp) });
        }
        return out;
    }

    stop() {
        this._letGo(false);
        // The stream ends, not the devices: the host keeps each one at rest for
        // the next stream, so a game left running keeps its wheel and the force
        // feedback it set up. Only an unplug or a switch turned off detaches.
        this._dropAll('', false);
        if (this._hid) this._hid.removeEventListener('disconnect', this._onDisconnect);
        this._changed();
    }

    async _attach(device) {
        if (!this._caps?.available) return;
        const existing = this._entries.get(device);
        if (existing && (existing.state === 'on' || existing.state === 'pending')) return;
        const slot = this._freeSlot();
        if (slot < 0) return;
        try {
            if (!device.opened) await device.open();
        } catch (err) {
            this._entries.set(device, {
                slot: -1,
                state: 'refused',
                why: String(err?.message || err),
                listener: null,
            });
            return;
        }
        const hidppIds = hasHidpp(device) ? hidppInputIds(device) : new Set();
        // A Wii Remote's answers: once each, on the reliable channel.
        const replyIds = isWiimote(device) ? WIIMOTE_REPLY_IDS : new Set();
        const listener = (e) => {
            if (hidppIds.has(e.reportId)) return;
            const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
            if (replyIds.has(e.reportId)) {
                this._send({ type: 'hidreply', slot, reportId: e.reportId, data: toBase64(bytes) });
                // A Wii Remote's status (0x20): buttons(2) flags(1) 00 00 battery(1). The flags byte
                // carries the extension bit (0x02) and the player-light nibble (bits 4-7).
                if (
                    this._onWiimote &&
                    isWiimote(device) &&
                    e.reportId === 0x20 &&
                    bytes.length >= 6
                ) {
                    const flags = bytes[2];
                    this._onWiimote({
                        type: 'status',
                        slot,
                        battery: bytes[5],
                        extension: !!(flags & 0x02),
                        leds: flags >> 4,
                    });
                }
                return;
            }
            this._sendFrame(this._pump.report(slot, e.reportId, bytes, this._now()));
        };
        device.addEventListener('inputreport', listener);
        const ffb = await this._probeFfb(device);
        this._entries.set(device, { slot, state: 'pending', why: '', listener, ffb });
        this._send(attachMessage(slot, device, { forceFeedback: !!ffb }));
        this._armTimer();
    }

    // The host said, or never will: the devices switched on but not sent go
    // back to the mapped pads.
    _letGo(notify = true) {
        if (this._holdTimer !== null) this._cancelLater(this._holdTimer);
        this._holdTimer = null;
        if (!this._holding) return;
        this._holding = false;
        if (notify) this._changed();
    }

    _drop(device, why, tell = true) {
        const e = this._entries.get(device);
        if (!e) return;
        if (isWiimote(device) && (e.state === 'on' || e.state === 'pending'))
            this._onWiimote?.({ type: 'detached', slot: e.slot });
        if (tell && (e.state === 'on' || e.state === 'pending')) this._send(detachMessage(e.slot));
        this._release(device, e);
        this._entries.delete(device);
        if (why) this._entries.set(device, { slot: -1, state: 'off', why, listener: null });
        this._changed();
    }

    _dropAll(why, tell = true) {
        for (const d of Array.from(this._entries.keys())) this._drop(d, why, tell);
        this._disarmTimer();
    }

    // A wheel whose motor this page can drive, when the host takes force
    // feedback: how to make its player and what to close after it, or null.
    async _probeFfb(device) {
        if (!this._caps?.ffb) return null;
        if (hasHidpp(device)) {
            const transport = new HidppTransport(device);
            const index = await findFfbFeature(transport);
            if (index)
                return {
                    make: (o) => new HidppFfbPlayer(transport, index, o),
                    close: () => transport.close(),
                    player: null,
                };
            transport.close();
        }
        if (hasNativePid(device))
            return { make: (o) => new PidFfbPlayer(device, o), close: () => {}, player: null };
        return null;
    }

    _startFfb(e) {
        const f = e.ffb;
        f.player = f.make({
            onError: (err) => console.warn('[HID] force feedback:', err?.message || err),
        });
        f.player
            .init()
            .catch((err) => console.warn('[HID] force feedback init:', err?.message || err));
    }

    // The host's HID++ requests to the real wheel, filtered (Linux host).
    _startRelay(device, e) {
        const slot = e.slot;
        e.relay = new HidppRelay(device, {
            reply: (reportId, bytes) =>
                this._send({ type: 'hidreply', slot, reportId, data: toBase64(bytes) }),
            resetMotor: async () => {
                const t = new HidppTransport(device);
                try {
                    const index = await findFfbFeature(t);
                    if (index) await new HidppFfbPlayer(t, index).close();
                } finally {
                    t.close();
                }
            },
        });
    }

    _release(device, e) {
        if (e.listener) device.removeEventListener('inputreport', e.listener);
        e.listener = null;
        if (e.relay) {
            e.relay.close();
            e.relay = null;
        }
        if (e.ffb) {
            const f = e.ffb;
            e.ffb = null;
            // Reset and freed before the transport goes: never a force left on.
            (f.player ? f.player.close() : Promise.resolve()).finally(() => f.close());
        }
        if (e.slot >= 0) this._pump.forget(e.slot);
        e.slot = -1;
    }

    _freeSlot() {
        const used = new Set(Array.from(this._entries.values(), (e) => e.slot));
        for (let s = 0; s < HID_MAX_SLOTS; s++) if (!used.has(s)) return s;
        return -1;
    }

    _entryBySlot(slot) {
        for (const pair of this._entries) if (pair[1].slot === slot) return pair;
        return null;
    }

    // What the game wrote to the recreated Wii Remote, to the real one: in the
    // order it came, each write awaited before the next (the camera's set-up
    // and the memory writes depend on it), the bytes as they are — rumble is
    // bit 0 of every one, and the game sets it. Linux hands the report with its
    // id first; WebHID takes the id apart. A device let go stops the queue.
    _writeWiimote(device, e, reportId, bytes) {
        const payload = bytes[0] === reportId ? bytes.subarray(1) : bytes;
        const write = () =>
            e.slot >= 0 && e.state === 'on' && this._entries.get(device) === e
                ? device.sendReport(reportId, payload)
                : undefined;
        e.writes = (e.writes || Promise.resolve()).then(write).catch((err) => {
            if (!e.writeFailed) console.warn('[HID] Wii Remote write:', err?.message || err);
            e.writeFailed = true;
        });
    }

    _armTimer() {
        if (this._timer) return;
        this._timer = this._setTimer(() => {
            for (const f of this._pump.due(this._now())) this._sendFrame(f);
        }, TICK_MS);
    }

    _disarmTimer() {
        if (!this._timer) return;
        this._clearTimer(this._timer);
        this._timer = null;
    }

    _changed() {
        if (this._onChange) this._onChange();
    }
}
