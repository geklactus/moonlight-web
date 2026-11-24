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
 * print; the rest are counted, and the count rides on the next line of that
 * key to print, in the next window.
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
        bool print = true; // write this line
        int heldBack = 0;  // lines of this key held back in the window that just closed
    };

    Verdict admit(const void* key, int64_t nowMs)
    {
        State& s = m_State[key];
        Verdict v;
        if (!s.started || nowMs - s.windowStart >= kWindowMs) {
            v.heldBack = s.heldBack;
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
};
