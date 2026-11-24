/*
 * MoonlightWeb — why a WebRTC transport ended.
 * Copyright (C) 2026 Bruno Martin. GPLv3 — see repository LICENSE.
 */

/**
 * Why a WebRTC transport ended, as it tells the view (onError's message).
 *
 * These are reasons for the console, the worker log and the trace, never
 * shown as they are: what the player reads is the view's or the app's toast,
 * from the locale files. So they are in English, like every other line there,
 * whatever the page's language. They were written in French, and an English
 * page logged "Connexion au serveur de streaming impossible" when its
 * signalling socket failed (LOLA, 24/11/2026).
 */

/** The signalling socket never opened, or closed before it did (1006). */
export const SIGNALING_UNREACHABLE =
    'Could not reach the streaming server. Check for a firewall, an antivirus ' +
    'scanning HTTPS, or a proxy in the way.';

/** The signalling socket failed after it had opened. */
export const SIGNALING_ERROR = 'Streaming server connection error';

/** The signalling socket closed after the stream had connected. */
export const SIGNALING_LOST = 'Connection to the streaming server lost';

/** The signalling socket closed with 1015: the TLS handshake failed. */
export const SIGNALING_TLS_FAILED = 'TLS handshake failed. Check the system date and time.';

/** ICE never connected and no fallback over the signalling socket was possible. */
export const WEBRTC_UNREACHABLE =
    'The WebRTC connection could not be set up. Check that the network allows outgoing UDP.';
