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
 * QualityLadder — the decisions behind the automatic quality ladder, apart
 * from the relaunch machinery in app.js so they can be tested.
 *
 * Review of 23/11/2026 (a month of LOLA sessions, LAN and outside): one
 * detection cost four relaunches, one down and up to three back up, 75 s
 * apart, each with a toast. What changed:
 *
 * - Coming back up is one relaunch to the session's own settings, not one
 *   knob per step (app.js _maybeUpgradeQuality).
 * - A stream that falls again within FLAP_WINDOW_MS of coming back up has
 *   flapped. The first flap doubles the quiet time asked before the next try;
 *   at FLAPS_TO_HOLD the session stays where it is.
 * - A Wolf seat never changes transport: on the LAN the media transport ran
 *   at 51 fps or less in 6 of 22 sessions that switched to it, and an outside
 *   Wolf stream starts on it already. It steps bitrate instead.
 * - The page can cap how far the ladder goes (pagePolicy): LOLA's play page,
 *   which picks an outside player's plan for their network, allows one step.
 * - A decoder that can't keep up gets a lower frame rate or size, never a
 *   lower bitrate or another transport (deviceRelief).
 */

/** Falling again this soon after coming back up is a flap. */
export const FLAP_WINDOW_MS = 300000;
/** Flaps in one session after which the ladder stops trying to come back up. */
export const FLAPS_TO_HOLD = 2;

/**
 * Which knob the next step down turns.
 * @param {{curHeight: number, keepsSize: boolean, onMedia: boolean, transportForced: boolean,
 *          curFps: number, fpsCapped: boolean, bitrateCanDrop: boolean}} s
 * @returns {'resolution'|'transport'|'fps'|'bitrate'|'restart'}
 */
export function degradeRung(s) {
    if (s.curHeight > 720 && !s.keepsSize) return 'resolution';
    // A Wolf seat (keepsSize) keeps its transport: see the module note.
    if (!s.onMedia && !s.transportForced && !s.keepsSize) return 'transport';
    if (!s.fpsCapped && s.curFps > 60) return 'fps';
    if (s.bitrateCanDrop) return 'bitrate';
    return 'restart';
}

/**
 * What the page hosting the client allows the ladder to do. A page sets
 * `globalThis.mwQualityPolicy = { maxDegradeSteps: n }` before or during the
 * stream; read at every step, so a later change applies. Anything else, or
 * nothing, leaves the ladder as it is (no cap).
 * @param {any} [g] the global object
 * @returns {{maxDegradeSteps: number}} Infinity when uncapped
 */
export function pagePolicy(g = globalThis) {
    const p = g && g.mwQualityPolicy;
    const n = p && typeof p === 'object' ? p.maxDegradeSteps : undefined;
    return { maxDegradeSteps: Number.isInteger(n) && n >= 0 ? n : Infinity };
}

/**
 * Whether a detection now is a flap of the last upgrade, and what follows.
 * @param {{now: number, lastUpgradeAt: number, flaps: number, stableMs: number}} s
 * @returns {{flap: boolean, flaps: number, stableMs: number, hold: boolean}}
 */
export function flapVerdict(s) {
    const flap = s.lastUpgradeAt > 0 && s.now - s.lastUpgradeAt < FLAP_WINDOW_MS;
    if (!flap) return { flap: false, flaps: s.flaps, stableMs: s.stableMs, hold: false };
    const flaps = s.flaps + 1;
    return {
        flap: true,
        flaps,
        stableMs: Math.min(600000, s.stableMs * 2),
        hold: flaps >= FLAPS_TO_HOLD,
    };
}

/**
 * The relief for a decoder that can't keep up: a lower frame rate first, then
 * one size down (not on a seat that keeps its size), then 30 fps. Null when
 * there is nothing left to lower.
 * @param {{curFps: number, curHeight: number, keepsSize: boolean}} s
 * @returns {{stream_fps: number} | {stream_height: number} | null}
 */
export function deviceRelief(s) {
    if (s.curFps > 60) return { stream_fps: 60 };
    if (s.curHeight > 720 && !s.keepsSize) {
        const next = [2160, 1440, 1080, 720].find((r) => r < s.curHeight);
        if (next) return { stream_height: next };
    }
    if (s.curFps > 30) return { stream_fps: 30 };
    return null;
}
