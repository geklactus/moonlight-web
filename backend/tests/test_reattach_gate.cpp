/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * Reattaching the browser to a running stream (ReattachGate.h).
 *
 * What a pass relies on: only the page that holds the stream's token gets a
 * new PeerConnection, once per socket and once per token; a socket that says
 * anything else first is refused; and the window gives a lost browser one
 * deadline however many attempts it makes, never fires once it came back,
 * and never fires after the relay is gone.
 */

#include "../src/streaming/ReattachGate.h"

#include "test_framework.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QObject>
#include <QSet>
#include <QThread>

#include <memory>

namespace {

/// Pump this thread's events for @p ms.
void pump(int ms)
{
    QElapsedTimer t;
    t.start();
    while (t.elapsed() < ms) {
        QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
        QThread::msleep(1);
    }
}

} // namespace

void run_reattach_gate_tests()
{
    using mw::reattach::Gate;
    using mw::reattach::Window;
    using Verdict = Gate::Verdict;

    SECTION("reattach — Chris's 20 s window");
    {
        CHECK_EQ(mw::reattach::kWindowMs, 20000);
    }

    SECTION("reattach — tokens: 128 bits of hex, never the same twice");
    {
        QSet<QString> seen;
        for (int i = 0; i < 64; ++i) {
            const QString t = mw::reattach::newToken();
            CHECK_EQ(t.size(), 32);
            CHECK(!seen.contains(t));
            seen.insert(t);
        }
    }

    SECTION("reattach — token comparison");
    {
        CHECK(mw::reattach::tokenMatches("abcd", "abcd"));
        CHECK(!mw::reattach::tokenMatches("abcd", "abce"));
        CHECK(!mw::reattach::tokenMatches("abcd", "abc"));
        CHECK(!mw::reattach::tokenMatches("", "")); // no token, no way in
        CHECK(!mw::reattach::tokenMatches("abcd", ""));
    }

    SECTION("reattach — the right token gets in, once per socket");
    {
        Gate gate(QStringLiteral("t0"));
        CHECK(!gate.expecting());
        CHECK(gate.offer("reattach", "t0") == Verdict::NotExpected); // no socket waiting
        gate.expect();
        CHECK(gate.expecting());
        CHECK(gate.offer("reattach", "t0") == Verdict::Accepted);
        CHECK(!gate.expecting());
        CHECK(gate.offer("reattach", "t0") == Verdict::NotExpected); // spent on this socket
    }

    SECTION("reattach — refusals");
    {
        Gate gate(QStringLiteral("t0"));
        gate.expect();
        CHECK(gate.offer("reattach", "t1") == Verdict::WrongToken);
        CHECK(!gate.expecting()); // one try per socket
        gate.expect();
        CHECK(gate.offer("hello", "t0") == Verdict::NotReattach); // must come first
        gate.expect();
        CHECK(gate.offer("reattach", "") == Verdict::WrongToken);
        gate.expect();
        gate.cancel(); // the socket went without a word
        CHECK(!gate.expecting());
    }

    SECTION("reattach — a used token is spent");
    {
        Gate gate(QStringLiteral("t0"));
        const QString next = gate.rotate();
        CHECK(next != QStringLiteral("t0"));
        CHECK_EQ(gate.token(), next);
        gate.expect();
        CHECK(gate.offer("reattach", "t0") == Verdict::WrongToken);
        gate.expect();
        CHECK(gate.offer("reattach", next) == Verdict::Accepted);
    }

    SECTION("reattach — window: nobody came back, it ends once");
    {
        QObject relay;
        int expired = 0;
        Window window(&relay, 30, [&] { ++expired; });
        CHECK(window.open());
        CHECK(window.isOpen());
        pump(10);
        CHECK_EQ(expired, 0); // not before its time
        pump(100);
        CHECK_EQ(expired, 1);
        CHECK(!window.isOpen());
        pump(60);
        CHECK_EQ(expired, 1); // single shot
    }

    SECTION("reattach — window: a second attempt keeps the first deadline");
    {
        QObject relay;
        int expired = 0;
        Window window(&relay, 60, [&] { ++expired; });
        CHECK(window.open());
        pump(40);
        CHECK(!window.open()); // already open: no new deadline
        pump(40);
        CHECK_EQ(expired, 1); // 60 ms after the first open, not the second
    }

    SECTION("reattach — window: the browser came back, nothing ends");
    {
        QObject relay;
        int expired = 0;
        Window window(&relay, 30, [&] { ++expired; });
        CHECK_EQ(window.close(), qint64(-1)); // was not open
        window.open();
        pump(5);
        const qint64 ms = window.close();
        CHECK(ms >= 0);
        CHECK(ms < 30);
        pump(80);
        CHECK_EQ(expired, 0);
        CHECK(window.open()); // a later loss opens a new one
        pump(80);
        CHECK_EQ(expired, 1);
    }

    SECTION("reattach — window: the relay went first, nothing runs");
    {
        int expired = 0;
        {
            auto relay = std::make_unique<QObject>();
            Window window(relay.get(), 20, [&] { ++expired; });
            window.open();
            relay.reset(); // the timer goes with its context
        }
        pump(80);
        CHECK_EQ(expired, 0);
    }
}
