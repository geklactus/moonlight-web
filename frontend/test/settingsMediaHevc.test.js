/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/stream/ultra/UltraPlayer.js', () => ({
    ultraPlayerSupported: () => false,
    presentMode: () => null,
    UltraPlayer: class {},
}));
vi.mock('../js/api/BackendClient.js', () => ({
    BackendClient: {
        getAuthStatus: vi.fn(async () => ({ has_session: false })),
        getStreamingSettings: vi.fn(async () => ({})),
        saveStreamingSettings: vi.fn(async () => ({})),
        getHosts: vi.fn(async () => ({ hosts: [] })),
        getMetricsReporting: vi.fn(),
        setMetricsReporting: vi.fn(async () => ({ enabled: true })),
    },
}));
vi.mock('../js/ui/Toast.js', () => ({
    Toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('../js/i18n/i18n.js', () => ({
    t: (key) => 'text:' + key,
    getLanguage: () => 'en',
    setLanguage: vi.fn(),
    AVAILABLE_LANGUAGES: [{ code: 'en', label: 'English' }],
}));

import { SettingsView } from '../js/ui/SettingsView.js';

/**
 * The codec menu under an admin-forced media transport (media_track_only_h264):
 * H.264 alone, as before — or HEVC and Auto too, where this browser's own RTP
 * decoder lists H.265 (util/RtpH265.js). AV1 and PyroWave never ride that track.
 */
const $ = (sel) => document.querySelector(sel);
const option = (value) => $(`#settings-video-codec option[value="${value}"]`);

describe('Settings — the codec menu on a forced media transport', () => {
    let view;
    beforeEach(() => {
        document.body.innerHTML = '<div id="settings"></div>';
        localStorage.clear();
        view = new SettingsView(document.getElementById('settings'), () => {});
        view._codecSupport = { h264: true, hevc: true, av1: true };
        view._mediaTrackOnlyH264 = true;
    });

    it('offers H.264 alone where the browser lists no H.265', () => {
        view._rtpH265 = false;
        view._videoCodec = 'hevc';
        view.render();
        expect(option('h264').disabled).toBe(false);
        expect(option('hevc').disabled).toBe(true);
        expect(option('auto').disabled).toBe(true);
        expect(option('av1').disabled).toBe(true);
        expect($('#settings-video-codec').value).toBe('h264');
        expect(view._getEffectiveCodec()).toBe('h264');
    });

    it('offers HEVC and Auto too where the browser lists H.265, never AV1', () => {
        view._rtpH265 = true;
        view._videoCodec = 'hevc';
        view.render();
        expect(option('h264').disabled).toBe(false);
        expect(option('hevc').disabled).toBe(false);
        expect(option('auto').disabled).toBe(false);
        expect(option('av1').disabled).toBe(true);
        expect(option('pyrowave').disabled).toBe(true);
        expect($('#settings-video-codec').value).toBe('hevc');
        expect(view._getEffectiveCodec()).toBe('hevc');
        view._videoCodec = 'auto';
        expect(view._getEffectiveCodec()).toBe('auto');
        view._videoCodec = 'av1';
        expect(view._getEffectiveCodec()).toBe('h264');
    });

    it('changes nothing without the forced transport', () => {
        view._mediaTrackOnlyH264 = false;
        view._rtpH265 = false;
        view._videoCodec = 'av1';
        view.render();
        expect(option('av1').disabled).toBe(false);
        expect(view._getEffectiveCodec()).toBe('av1');
    });
});
