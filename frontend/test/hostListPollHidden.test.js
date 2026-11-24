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
 * The host list asks the machine for its hosts every 3 s — but not from a
 * hidden tab: one left open on LOLA's own desktop sent three in four of the
 * /api/hosts requests stream-front saw in ten days (13–23/11/2026). Coming back
 * to the tab asks at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: {
        getHosts: vi.fn(async () => ({ hosts: [] })),
        getAppList: vi.fn(() => new Promise(() => {})),
        scanHosts: vi.fn(async () => ({})),
        checkForUpdate: vi.fn(async () => ({})),
    },
}));

import { HostListView } from '../js/ui/HostListView.js';
import { BackendClient } from '../js/api/BackendClient.js';

let hidden = false;
let view;

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.body.innerHTML = '<div id="root"></div>';
    view = new HostListView(document.getElementById('root'));
    view.renderShell();
});

afterEach(() => {
    if (view) view.destroy();
    view = null;
    vi.useRealTimers();
    delete document.hidden;
    localStorage.clear();
});

async function tick(ms) {
    await vi.advanceTimersByTimeAsync(ms);
}

describe('HostListView polling', () => {
    it('asks every 3 s while the tab is visible', async () => {
        view.start();
        await tick(0);
        const first = BackendClient.getHosts.mock.calls.length;
        await tick(9000);
        expect(BackendClient.getHosts.mock.calls.length - first).toBe(3);
    });

    it('asks nothing while the tab is hidden, and at once when it comes back', async () => {
        view.start();
        await tick(0);
        hidden = true;
        await tick(3000); // the poll due now finds the tab hidden and stops
        const whileHidden = BackendClient.getHosts.mock.calls.length;
        await tick(60000);
        expect(BackendClient.getHosts.mock.calls.length).toBe(whileHidden);

        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        await tick(0);
        expect(BackendClient.getHosts.mock.calls.length).toBe(whileHidden + 1);
        await tick(3000);
        expect(BackendClient.getHosts.mock.calls.length).toBe(whileHidden + 2);
    });

    it('does not start a second poll when the tab comes back while one is due', async () => {
        view.start();
        await tick(0);
        const before = BackendClient.getHosts.mock.calls.length;
        document.dispatchEvent(new Event('visibilitychange')); // visible already
        await tick(3000);
        expect(BackendClient.getHosts.mock.calls.length - before).toBe(1);
    });
});
