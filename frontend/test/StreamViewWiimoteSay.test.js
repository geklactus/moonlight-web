/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * "A Wii Remote at this computer" (?wiimote=here) says what is happening instead of failing quietly.
 * On 2026-11-13 the host couldn't open /dev/uhid: its hidcaps said it couldn't take a device, the page
 * offered Connect anyway, the chooser worked, and nothing was sent or said. Now the page offers
 * Connect only once the host can, gives the host's reason when it can't, says when a pick didn't
 * connect (and offers Connect again), and says "no remote has answered yet" until one does.
 */
vi.mock('../js/ui/Toast.js', () => {
    const toast = () => vi.fn(() => ({ dismiss: vi.fn() }));
    return { Toast: { info: toast(), warning: toast(), error: toast(), success: toast() } };
});
vi.mock('../js/i18n/i18n.js', async (importOriginal) => ({
    ...(await importOriginal()),
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
}));

import { StreamView } from '../js/ui/StreamView.js';
import { Toast } from '../js/ui/Toast.js';

const P = StreamView.prototype;
const CANT = "This host can't take a Wii Remote right now.";

function view(caps) {
    const hp = {
        caps,
        linkWiimoteRemembered: vi.fn(async () => null),
        linkWiimote: vi.fn(async () => []),
    };
    return {
        _quitting: false,
        _hidPassthrough: hp,
        _wiimoteLocalPick: () => true,
        _offerWiimote: P._offerWiimote,
        _sayWiimote: P._sayWiimote,
        _onWiimoteEvent: P._onWiimoteEvent,
        _showWiimoteStatus: P._showWiimoteStatus,
    };
}

const said = (spy, key) => spy.mock.calls.filter(([text]) => String(text).startsWith(key));
const connectOffers = () => said(Toast.info, 'stream.wiimoteConnect').filter(([, o]) => o?.action);

describe('StreamView — the Wii Remote says why it does not connect', () => {
    let hid;
    beforeEach(() => {
        hid = Object.getOwnPropertyDescriptor(globalThis.navigator, 'hid');
        Object.defineProperty(globalThis.navigator, 'hid', { value: {}, configurable: true });
        vi.clearAllMocks();
    });
    afterEach(() => {
        if (hid) Object.defineProperty(globalThis.navigator, 'hid', hid);
        else delete globalThis.navigator.hid;
    });

    it("the host can't take one: its reason, and no Connect", async () => {
        const v = view({ available: false, why: CANT });
        await v._offerWiimote();
        expect(said(Toast.warning, 'stream.wiimoteUnavailable')).toHaveLength(1);
        expect(said(Toast.warning, 'stream.wiimoteUnavailable')[0][0]).toContain(CANT);
        expect(connectOffers()).toHaveLength(0);
        expect(v._hidPassthrough.linkWiimoteRemembered).not.toHaveBeenCalled();
    });

    it('the same reason twice is said once', async () => {
        const v = view({ available: false, why: CANT });
        await v._offerWiimote();
        await v._offerWiimote();
        expect(said(Toast.warning, 'stream.wiimoteUnavailable')).toHaveLength(1);
    });

    it('nothing before the host has said', async () => {
        const v = view(null);
        await v._offerWiimote();
        expect(Toast.warning).not.toHaveBeenCalled();
        expect(Toast.info).not.toHaveBeenCalled();
    });

    it('once the host can: the reason goes and Connect is offered', async () => {
        const v = view({ available: false, why: CANT });
        await v._offerWiimote();
        const line = Toast.warning.mock.results[0].value;
        v._hidPassthrough.caps = { available: true, wiimote: true };
        await v._offerWiimote();
        expect(line.dismiss).toHaveBeenCalled();
        expect(connectOffers()).toHaveLength(1);
    });

    it('a pick that did not connect: said, in the host words, and Connect again', async () => {
        const v = view({ available: true, wiimote: true });
        await v._offerWiimote();
        v._onWiimoteEvent({
            type: 'refused',
            slot: 0,
            why: 'Only Wii Remotes can be connected to this game.',
        });
        const refused = said(Toast.warning, 'stream.wiimoteRefused');
        expect(refused).toHaveLength(1);
        expect(refused[0][0]).toContain('Only Wii Remotes');
        await vi.waitFor(() => expect(connectOffers()).toHaveLength(2));
        expect(Toast.warning.mock.results[0].value.dismiss).not.toHaveBeenCalled(); // the reason stays
    });

    it("the browser couldn't open it: said as the browser's doing", () => {
        const v = view({ available: true, wiimote: true });
        v._onWiimoteEvent({ type: 'refused', slot: -1, why: '', local: 'unopened' });
        expect(said(Toast.warning, 'stream.wiimoteRefused')[0][0]).toContain(
            'stream.wiimoteNotOpened',
        );
    });

    it('the chooser closed with nothing picked: Connect is offered again', async () => {
        const v = view({ available: true, wiimote: true });
        await v._offerWiimote();
        v._onWiimoteEvent({ type: 'cancelled' });
        await vi.waitFor(() => expect(connectOffers()).toHaveLength(2));
        expect(Toast.warning).not.toHaveBeenCalled();
    });

    it('attached but no remote has answered: waiting, not connected; then connected once it speaks', () => {
        const v = view({ available: true, wiimote: true });
        v._onWiimoteEvent({ type: 'attached', slot: 0, name: 'Mayflash Wiimote PC Adapter' });
        expect(said(Toast.info, 'stream.wiimoteWaiting')).toHaveLength(1);
        expect(said(Toast.info, 'stream.wiimoteConnected')).toHaveLength(0);
        v._onWiimoteEvent({ type: 'heard', slot: 0 });
        expect(said(Toast.info, 'stream.wiimoteConnected')).toHaveLength(1);
    });

    it('a browser without WebHID: says so', async () => {
        delete globalThis.navigator.hid;
        const v = view(null);
        v._hidPassthrough = null;
        await v._offerWiimote();
        expect(said(Toast.warning, 'stream.wiimoteNoWebHid')).toHaveLength(1);
    });
});
