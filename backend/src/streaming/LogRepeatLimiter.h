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

#pragma once

#include <cstdint>
#include <unordered_map>

/**
 * Holds back a log line that repeats too fast, and says how many were held.
 *
 * moonlight-common-c logs some lines once per packet or frame while a stream
 * is in trouble: "Waiting for IDR frame" made about 30,000 lines in a month of
 * LOLA worker logs and "Failed to decrypt control packet" about 5,600, burying
 * the lines that explain a session (review, 23/11/2026). Each line is keyed by
 * its format string — moonlight-common-c passes literals, so the pointer is
 * stable and free to compare. The first kBurst lines of a key in a window
 * print; the rest are counted, and the count is noted after the next line of
 * that key to print, in the next window.
 *
 * moonlight-common-c also writes one line in two pieces: a stage, with no
 * newline ("Stopping input stream..."), then "done\n" once it is over. About
 * eleven stages run at each start and each stop, so "done\n", counted on its
 * own, used up its allowance at the start and was held back for the rest of
 * it and most of the stop, and the count note landed inside the next stage's
 * line (Switch session, 24/11/2026). The rest of a line now goes with its
 * start: it prints when the start printed, is not counted, and a count note
 * waits for the line to end.
 *
 * Not thread-safe: the caller holds a lock.
 */
class LogRepeatLimiter
{
public:
    static constexpr int kBurst = 5;
    static constexpr int64_t kWindowMs = 10000;

    struct Verdict
    {
        bool print = true; // write this piece
        int heldBack = 0;  // after writing it, note this many lines held back
    };

    /**
     * @param endsLine whether this piece ends its line (its format ends in a
     *        newline); a piece that does not leaves the next one to finish it.
     */
    Verdict admit(const void* key, int64_t nowMs, bool endsLine = true)
    {
        Verdict v;
        if (m_MidLine) {
            // The rest of a line already started: it goes with its start.
            v.print = m_LinePrinted;
        } else {
            State& s = m_State[key];
            if (!s.started || nowMs - s.windowStart >= kWindowMs) {
                // The first line of a window always prints (count is reset
                // below), so the note is never lost with a held line.
                m_Note = s.heldBack;
                s.started = true;
                s.windowStart = nowMs;
                s.count = 0;
                s.heldBack = 0;
            }
            if (s.count < kBurst) {
                ++s.count;
                v.print = true;
            } else {
                ++s.heldBack;
                v.print = false;
            }
            m_LinePrinted = v.print;
        }
        m_MidLine = !endsLine;
        if (endsLine && m_LinePrinted) {
            v.heldBack = m_Note;
            m_Note = 0;
        }
        return v;
    }

private:
    struct State
    {
        bool started = false;
        int64_t windowStart = 0;
        int count = 0;
        int heldBack = 0;
    };
    std::unordered_map<const void*, State> m_State;
    bool m_MidLine = false;     // the last piece did not end its line
    bool m_LinePrinted = false; // that line's start was written
    int m_Note = 0;             // held-back count to note once the line ends
};
