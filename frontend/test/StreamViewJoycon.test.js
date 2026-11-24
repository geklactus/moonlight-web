/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/*
 * "Joy-Cons at this computer" (?joycon=here): the stream page sends the ones already allowed with no
 * click, offers Connect for each half still missing and says which, and says why when they can't
 * connect — as the Wii Remote's lines do (StreamViewWiimoteSay.test.js).
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

function view(caps, { picked = true } = {}) {
    const sides = new Set();
    const hp = {
        caps,
        sides,
        joyconSides: () => new Set(sides),
        linkJoyconsRemembered: vi.fn(async () => []),
        linkJoycon: vi.fn(async () => []),
    };
    return {
        _quitting: false,
        _hidPassthrough: hp,
        _joyconLocalPick: () => (picked === true ? 'joycon' : picked || null),
        _offerJoycon: P._offerJoycon,
        _sayJoycon: P._sayJoycon,
        _onJoyconEvent: P._onJoyconEvent,
    };
}

const said = (spy, key) => spy.mock.calls.filter(([text]) => String(text).startsWith(key));
const offers = (key) => said(Toast.info, key).filter(([, o]) => o?.action);
const TAKES = { available: true, joycon: true, why: '' };

describe('StreamView — Joy-Cons at this computer', () => {
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

    it('does nothing unless the launcher asked for Joy-Cons here', async () => {
        const v = view(TAKES, { picked: false });
        await v._offerJoycon();
        expect(v._hidPassthrough.linkJoyconsRemembered).not.toHaveBeenCalled();
        expect(Toast.info).not.toHaveBeenCalled();
        expect(Toast.warning).not.toHaveBeenCalled();
    });

    it('tries the Joy-Cons already allowed first, then offers Connect for a pair', async () => {
        const v = view(TAKES);
        await v._offerJoycon();
        expect(v._hidPassthrough.linkJoyconsRemembered).toHaveBeenCalledTimes(1);
        const [[text, options]] = offers('stream.joyconConnect');
        expect(text).toBe('stream.joyconConnect');
        expect(options.sticky).toBe(true);
        // Asked again while the banner is up: no second banner.
        await v._offerJoycon();
        expect(offers('stream.joyconConnect')).toHaveLength(1);
        options.action.onClick();
        expect(v._hidPassthrough.linkJoycon).toHaveBeenCalledTimes(1);
    });

    it('says which half is still to come, then that both are connected', async () => {
        const v = view(TAKES);
        await v._offerJoycon();
        v._hidPassthrough.sides.add('left');
        v._onJoyconEvent({ type: 'attached', slot: 0, side: 'left', name: 'Joy-Con (L)' });
        await vi.waitFor(() => expect(offers('stream.joyconConnectRight')).toHaveLength(1));
        expect(said(Toast.info, 'stream.joyconBoth')).toHaveLength(0);

        v._hidPassthrough.sides.add('right');
        v._onJoyconEvent({ type: 'attached', slot: 1, side: 'right', name: 'Joy-Con (R)' });
        await Promise.resolve();
        expect(said(Toast.info, 'stream.joyconBoth')).toHaveLength(1);
        // Nothing more to connect: the banner isn't drawn again.
        expect(offers('stream.joyconConnect')).toHaveLength(2); // the pair's, then the right one's
        expect(v._joyconConnectToast).toBeNull();
    });

    it('asks for the left one when the right came first', async () => {
        const v = view(TAKES);
        v._hidPassthrough.sides.add('right');
        await v._offerJoycon();
        expect(offers('stream.joyconConnectLeft')).toHaveLength(1);
    });

    it('offers nothing when both are sent already', async () => {
        const v = view(TAKES);
        v._hidPassthrough.sides.add('left').add('right');
        await v._offerJoycon();
        expect(v._hidPassthrough.linkJoyconsRemembered).not.toHaveBeenCalled();
        expect(Toast.info).not.toHaveBeenCalled();
    });

    it('says why when the host cannot take Joy-Cons, and offers no Connect', async () => {
        const v = view({ available: false, joycon: false, why: "This host can't take a device." });
        await v._offerJoycon();
        expect(said(Toast.warning, 'stream.joyconUnavailable')[0][0]).toContain(
            "This host can't take a device.",
        );
        expect(offers('stream.joyconConnect')).toHaveLength(0);

        // A host that takes Wii Remotes but not Joy-Cons (an older one): its own line.
        vi.clearAllMocks();
        const w = view({ available: true, joycon: false, wiimote: true, why: '' });
        await w._offerJoycon();
        expect(said(Toast.warning, 'stream.joyconUnavailable')[0][0]).toContain(
            'stream.joyconNotTaken',
        );
        expect(w._hidPassthrough.linkJoyconsRemembered).not.toHaveBeenCalled();

        // It can now: the line goes and Connect is offered.
        w._hidPassthrough.caps = TAKES;
        await w._offerJoycon();
        expect(w._joyconWhyText).toBeNull();
        expect(offers('stream.joyconConnect')).toHaveLength(1);
    });

    it('says a pick that did not connect, and offers Connect again', async () => {
        const v = view(TAKES);
        await v._offerJoycon();
        v._onJoyconEvent({ type: 'refused', slot: -1, why: 'busy', local: 'unopened' });
        expect(said(Toast.warning, 'stream.joyconRefused')[0][0]).toContain(
            'stream.wiimoteNotOpened',
        );
        await vi.waitFor(() => expect(offers('stream.joyconConnect')).toHaveLength(2));

        v._onJoyconEvent({ type: 'refused', slot: 0, why: 'Only Wii Remotes can be connected.' });
        expect(said(Toast.warning, 'stream.joyconRefused')[1][0]).toContain(
            'Only Wii Remotes can be connected.',
        );
        v._onJoyconEvent({ type: 'cancelled' });
        await vi.waitFor(() => expect(offers('stream.joyconConnect')).toHaveLength(4));
    });

    it('offers the missing half again when one drops', async () => {
        const v = view(TAKES);
        v._hidPassthrough.sides.add('left').add('right');
        v._hidPassthrough.sides.delete('right');
        v._onJoyconEvent({ type: 'detached', slot: 1, side: 'right' });
        await vi.waitFor(() => expect(offers('stream.joyconConnectRight')).toHaveLength(1));
    });

    it('says so in a browser without WebHID', async () => {
        delete globalThis.navigator.hid;
        Object.defineProperty(globalThis.navigator, 'hid', {
            value: undefined,
            configurable: true,
        });
        const v = view(TAKES);
        await v._offerJoycon();
        expect(said(Toast.warning, 'stream.joyconNoWebHid')).toHaveLength(1);
        expect(v._hidPassthrough.linkJoyconsRemembered).not.toHaveBeenCalled();
    });
});

describe('StreamView — a Pro Controller at this computer', () => {
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

    it('reads which controller the launcher asked for from the address', () => {
        const before = globalThis.location.href;
        globalThis.history.replaceState(null, '', '?play=x&joycon=pro');
        expect(P._joyconLocalPick.call({})).toBe('pro');
        globalThis.history.replaceState(null, '', '?play=x&joycon=here');
        expect(P._joyconLocalPick.call({})).toBe('joycon');
        globalThis.history.replaceState(null, '', '?play=x&joycon=yes');
        expect(P._joyconLocalPick.call({})).toBeNull();
        globalThis.history.replaceState(null, '', before);
    });

    it('tries the one already allowed, then offers Connect for it, and connects only a Pro', async () => {
        const v = view(TAKES, { picked: 'pro' });
        await v._offerJoycon();
        expect(v._hidPassthrough.linkJoyconsRemembered).toHaveBeenCalledWith('pro');
        const [[text, options]] = offers('stream.proConnect');
        expect(text).toBe('stream.proConnect');
        expect(offers('stream.joyconConnect')).toHaveLength(0);
        options.action.onClick();
        expect(v._hidPassthrough.linkJoycon).toHaveBeenCalledWith('pro');
    });

    it('says it is connected, and offers nothing more', async () => {
        const v = view(TAKES, { picked: 'pro' });
        await v._offerJoycon();
        v._hidPassthrough.sides.add('left').add('right');
        v._onJoyconEvent({ type: 'attached', slot: 0, side: 'both', name: 'Pro Controller' });
        await Promise.resolve();
        expect(said(Toast.info, 'stream.proConnected')).toHaveLength(1);
        expect(said(Toast.info, 'stream.joyconBoth')).toHaveLength(0);
        expect(v._joyconConnectToast).toBeNull();
    });

    it("says why in a Pro Controller's own words", async () => {
        const v = view(TAKES, { picked: 'pro' });
        await v._offerJoycon();
        v._onJoyconEvent({ type: 'refused', slot: 0, why: 'busy' });
        expect(said(Toast.warning, 'stream.proRefused')[0][0]).toContain('busy');

        vi.clearAllMocks();
        const w = view({ available: true, joycon: false, why: '' }, { picked: 'pro' });
        await w._offerJoycon();
        expect(said(Toast.warning, 'stream.proUnavailable')[0][0]).toContain('stream.proNotTaken');

        vi.clearAllMocks();
        Object.defineProperty(globalThis.navigator, 'hid', {
            value: undefined,
            configurable: true,
        });
        const x = view(TAKES, { picked: 'pro' });
        await x._offerJoycon();
        expect(said(Toast.warning, 'stream.proNoWebHid')).toHaveLength(1);
    });
});
