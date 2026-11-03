/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Reattach — a new PeerConnection for a stream that keeps running.
 *
 * When this browser's path changes (Wi-Fi to cellular, a new IP) its
 * PeerConnection cannot follow, and the stream used to start over: a new
 * /start, a new worker, and on Wolf a pause and a resume of the session. The
 * host side never saw this browser's network, so it now stays up: the worker
 * keeps its Moonlight session and waits REATTACH_WINDOW_MS for this page to
 * build a new PeerConnection, proving it is the page that started the stream
 * with the token /start gave it (backend ReattachGate.h). The view, its
 * decoder (or the <video> element), the pads and the HID devices all stay;
 * only the transport object is new. Anything that goes wrong falls back to how a lost link has
 * always ended.
 */

/** The worker's window (backend mw::reattach::kWindowMs), less a margin for
 *  the round trip, so the page never knocks on a door that just closed. */
export const REATTACH_WINDOW_MS = 18000;

/**
 * After a network change, how long the page lets ICE show whether the path
 * survived before it reattaches without waiting for the link to be called
 * dead.
 */
export const NETWORK_SETTLE_MS = 1000;

/** The view's transports that may reattach: both WebRTC ones ('webrtc' is the
 *  DataChannel transport). Never 'wss', whose worker ends with its socket. */
export const REATTACH_TRANSPORTS = ['webrtc-media', 'webrtc'];

/**
 * Whether a link that went may be reattached rather than relaunched.
 * @param {{transport: string, token: string|null, everConnected: boolean,
 *          reattaching: boolean, standby: boolean, takenOver: boolean,
 *          quitting: boolean}} s
 * @returns {boolean}
 */
export function canReattach(s) {
    return (
        REATTACH_TRANSPORTS.includes(s.transport) &&
        typeof s.token === 'string' &&
        s.token.length > 0 &&
        s.everConnected &&
        !s.reattaching &&
        !s.standby &&
        !s.takenOver &&
        !s.quitting
    );
}

/**
 * Whether ICE says the path is not there right now — the states in which a
 * network change means the old pair is gone rather than merely shaken.
 * @param {string|undefined} iceState
 * @returns {boolean}
 */
export function pathDown(iceState) {
    return iceState === 'disconnected' || iceState === 'failed' || iceState === 'checking';
}
