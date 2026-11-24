/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin. GPLv3.
 */
#include "test_framework.h"
#include "streaming/LogRepeatLimiter.h"

// moonlight-common-c logs some lines once per packet while a stream struggles;
// the limiter lets a few through per window and counts the rest.
void run_log_repeat_limiter_tests()
{
    SECTION("LogRepeatLimiter: a repeating line is held back, and counted");

    static const char* const waiting = "Waiting for IDR frame\n";
    static const char* const decrypt = "Failed to decrypt control packet\n";
    LogRepeatLimiter l;

    int printed = 0;
    for (int i = 0; i < 100; ++i)
        if (l.admit(waiting, 1000 + i).print) ++printed;
    CHECK_EQ(printed, LogRepeatLimiter::kBurst);

    // Another line has its own allowance.
    CHECK(l.admit(decrypt, 1100).print);

    // The next window: the first line prints and carries the count.
    const LogRepeatLimiter::Verdict next = l.admit(waiting, 1000 + LogRepeatLimiter::kWindowMs);
    CHECK(next.print);
    CHECK_EQ(next.heldBack, 100 - LogRepeatLimiter::kBurst);

    // A quiet line is never held back and never reports a count.
    LogRepeatLimiter q;
    for (int i = 0; i < 3; ++i) {
        const LogRepeatLimiter::Verdict v = q.admit(decrypt, i * 20000);
        CHECK(v.print);
        CHECK_EQ(v.heldBack, 0);
    }
}
