/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * The launcher passes "a Wii Remote at this computer" as ?wiimote=here in the
 * stream URL. During startup the app canonicalizes its address to '/' (several
 * history.replaceState calls in app.js), clearing location.search long before
 * the stream's `hidcaps` message arrives and _offerWiimote() looks for the
 * choice. StreamView must capture the launch query at module load — while the
 * query is still there — so the choice survives the cleanup.
 */
describe('StreamView wiimote launch pick', () => {
    const setUrl = (u) => window.history.replaceState(null, '', u);

    afterEach(() => {
        setUrl('/');
        vi.resetModules();
    });

    it('still reports the choice after the app has cleared the query string', async () => {
        setUrl('/?play=Game&title=Game&sys=wii&wiimote=here'); // the launcher's URL
        vi.resetModules();
        const { StreamView } = await import('../js/ui/StreamView.js'); // captures at import
        setUrl('/'); // the app canonicalizes to '/', wiping location.search
        expect(new URLSearchParams(location.search).get('wiimote')).toBe(null); // gone live
        expect(StreamView.prototype._wiimoteLocalPick.call({})).toBe(true); // captured survives
    });

    it('reports no pick when the launch URL had no wiimote=here', async () => {
        setUrl('/?play=Game&sys=wii');
        vi.resetModules();
        const { StreamView } = await import('../js/ui/StreamView.js');
        expect(StreamView.prototype._wiimoteLocalPick.call({})).toBe(false);
    });
});
