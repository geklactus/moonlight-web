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

    SECTION("LogRepeatLimiter: a line written in two pieces stays whole");

    // LiStartConnection and LiStopConnection each write about eleven stages
    // as "<stage>..." then "done\n": every "done" prints with its stage.
    static const char* const stages[] = {
        "Stopping input stream...",      "Stopping audio stream...",
        "Stopping video stream...",      "Stopping control stream...",
        "Cleaning up input stream...",   "Cleaning up video stream...",
        "Cleaning up control stream...", "Cleaning up audio stream...",
    };
    static const char* const done = "done\n";
    LogRepeatLimiter t;
    int stagesPrinted = 0, donesPrinted = 0;
    for (int round = 0; round < 2; ++round) // a start and a stop, close together
        for (const char* stage : stages) {
            if (t.admit(stage, 500, false).print) ++stagesPrinted;
            const LogRepeatLimiter::Verdict d = t.admit(done, 500, true);
            if (d.print) ++donesPrinted;
            CHECK_EQ(d.heldBack, 0);
        }
    CHECK_EQ(donesPrinted, stagesPrinted);
    CHECK_EQ(stagesPrinted, 16);

    SECTION("LogRepeatLimiter: a count note waits for the end of its line");

    static const char* const stopping = "Stopping input stream...";
    LogRepeatLimiter n;
    for (int i = 0; i < 12; ++i) {
        n.admit(stopping, i, false);
        n.admit(done, i, true);
    }
    // The next window: the stage prints, but its line is not over yet.
    const LogRepeatLimiter::Verdict head = n.admit(stopping, LogRepeatLimiter::kWindowMs, false);
    CHECK(head.print);
    CHECK_EQ(head.heldBack, 0);
    const LogRepeatLimiter::Verdict tail = n.admit(done, LogRepeatLimiter::kWindowMs, true);
    CHECK(tail.print);
    CHECK_EQ(tail.heldBack, 12 - LogRepeatLimiter::kBurst);

    SECTION("LogRepeatLimiter: the rest of a held-back line is held back too");

    LogRepeatLimiter h;
    for (int i = 0; i < LogRepeatLimiter::kBurst; ++i) {
        h.admit(stopping, 100, false);
        h.admit(done, 100, true);
    }
    CHECK(!h.admit(stopping, 100, false).print);
    CHECK(!h.admit(done, 100, true).print); // no lone "done"
    // ...and a line after it is judged on its own again.
    CHECK(h.admit(waiting, 100, true).print);
}
