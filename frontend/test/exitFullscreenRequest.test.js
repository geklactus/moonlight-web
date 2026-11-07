/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StreamView } from '../js/ui/StreamView.js';
import { EXIT_FULLSCREEN_EVENT } from '../js/ui/StreamViewFullscreen.js';

/**
 * A page around the stream (an embedding page's own "Exit fullscreen" button,
 * where the header is hidden) sends EXIT_FULLSCREEN_EVENT on window. A stream in
 * fullscreen leaves it the way the exit combo does — the CSS fallback an iPhone
 * gets included, which no Fullscreen API call can leave — and says so with
 * preventDefault(); out of fullscreen the event is left alone.
 */
const P = StreamView.prototype;

/** The fullscreen path of a view: its own methods, a stream root, no API fullscreen. */
function view(over = {}) {
    const root = document.createElement('div');
    root.id = 'stream-view';
    document.body.appendChild(root);
    const v = {
        _rootEl: root,
        _cssFullscreen: false,
        _keyboardLocked: false,
        _mobileFsBtn: null,
        inputEl: document.createElement('div'),
        _exitFullscreenOnRequest: P._exitFullscreenOnRequest,
        _exitGamingMode: P._exitGamingMode,
        _exitCssFallbackFullscreen: P._exitCssFallbackFullscreen,
        _updateMobileFsButtonVisibility: vi.fn(),
        ...over,
    };
    v._onExitFullscreenRequest = (e) => v._exitFullscreenOnRequest(e);
    window.addEventListener(EXIT_FULLSCREEN_EVENT, v._onExitFullscreenRequest);
    return v;
}

const ask = () => {
    const e = new Event(EXIT_FULLSCREEN_EVENT, { cancelable: true });
    window.dispatchEvent(e);
    return e;
};

let live = [];
afterEach(() => {
    for (const v of live) {
        window.removeEventListener(EXIT_FULLSCREEN_EVENT, v._onExitFullscreenRequest);
        v._rootEl.remove();
    }
    live = [];
    delete document.fullscreenElement;
    delete document.exitFullscreen;
});

describe('EXIT_FULLSCREEN_EVENT', () => {
    it('takes an iPhone out of the CSS fallback, and says so', () => {
        const v = view({ _cssFullscreen: true });
        live.push(v);
        v._rootEl.classList.add('stream-css-fs');
        const e = ask();
        expect(e.defaultPrevented).toBe(true);
        expect(v._cssFullscreen).toBe(false);
        expect(v._rootEl.classList.contains('stream-css-fs')).toBe(false);
        expect(v._updateMobileFsButtonVisibility).toHaveBeenCalled();
    });

    it('leaves API fullscreen through the exit combo’s path', () => {
        const v = view();
        live.push(v);
        const exit = vi.fn(() => Promise.resolve());
        Object.defineProperty(document, 'fullscreenElement', {
            value: v._rootEl,
            configurable: true,
        });
        Object.defineProperty(document, 'exitFullscreen', { value: exit, configurable: true });
        const e = ask();
        expect(e.defaultPrevented).toBe(true);
        expect(exit).toHaveBeenCalledTimes(1);
    });

    it('releases the keyboard lock on the way out', () => {
        const unlock = vi.fn();
        Object.defineProperty(navigator, 'keyboard', { value: { unlock }, configurable: true });
        try {
            const v = view({ _cssFullscreen: true, _keyboardLocked: true });
            live.push(v);
            ask();
            expect(unlock).toHaveBeenCalledTimes(1);
            expect(v._keyboardLocked).toBe(false);
        } finally {
            delete navigator.keyboard;
        }
    });

    it('out of fullscreen does nothing and leaves the event as it came', () => {
        const gaming = vi.fn();
        const v = view({ _exitGamingMode: gaming });
        live.push(v);
        const e = ask();
        expect(e.defaultPrevented).toBe(false);
        expect(gaming).not.toHaveBeenCalled();
    });

    it('keeps the name pages around the stream send', () => {
        // The name is the contract with pages around the stream (lola's play.js).
        expect(EXIT_FULLSCREEN_EVENT).toBe('moonlightweb:exit-fullscreen');
    });
});
