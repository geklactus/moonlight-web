/*
 * MoonlightWeb — self-hosted web client for Moonlight game streaming.
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

#include <QByteArray>
#include <QElapsedTimer>
#include <QObject>
#include <QRandomGenerator>
#include <QString>
#include <QTimer>

#include <functional>
#include <utility>

/// Reattaching the browser to a running stream (both WebRTC transports).
///
/// When the browser's path changes (Wi-Fi to cellular, a new IP), its
/// PeerConnection cannot follow: libjuice refuses an ICE restart. Until now the
/// page then relaunched — a new worker, a new launch, and on Wolf a pause and a
/// resume of the session. The host side never saw the phone's network, so it
/// has no reason to go: the worker keeps its Moonlight session, drops only the
/// browser's PeerConnection, and lets the same page build a new one within
/// kWindowMs. The page proves it is the one that started the stream with a
/// token handed out in /start's reply (the cookie check of HttpServer's proxy
/// still applies to the socket), and each reattach hands it a fresh one.
namespace mw::reattach {

/// How long the worker keeps a stream whose browser went (Chris, 2026-11-02:
/// 20 s). Past that it ends as it always did.
inline constexpr int kWindowMs = 20000;

/// 128 random bits, hex.
inline QString newToken()
{
    QByteArray bytes(16, Qt::Uninitialized);
    QRandomGenerator::system()->fillRange(reinterpret_cast<quint32*>(bytes.data()),
                                          bytes.size() / int(sizeof(quint32)));
    return QString::fromLatin1(bytes.toHex());
}

/// Compares in time independent of where the two differ. An empty token never
/// matches: a page that has none must not get in by sending none.
inline bool tokenMatches(const QString& expected, const QString& offered)
{
    if (expected.isEmpty() || expected.size() != offered.size()) return false;
    ushort diff = 0;
    for (int i = 0; i < expected.size(); ++i)
        diff |= expected.at(i).unicode() ^ offered.at(i).unicode();
    return diff == 0;
}

/// The signalling side of a reattach: whether the next socket must prove
/// itself, and with what. Lives on the signalling server's thread.
class Gate
{
public:
    explicit Gate(QString token = newToken())
        : m_Token(std::move(token))
    {}

    const QString& token() const { return m_Token; }

    /// A socket arrived while a stream is up or waiting for its browser: its
    /// first message must be the reattach.
    void expect() { m_Expecting = true; }
    bool expecting() const { return m_Expecting; }
    /// The socket went before saying anything.
    void cancel() { m_Expecting = false; }

    enum class Verdict
    {
        Accepted,
        NotExpected, ///< no reattach is waited for on this socket
        NotReattach, ///< the first message was something else
        WrongToken,
    };

    /// The socket's first message. Accepted once per expect().
    Verdict offer(const QString& type, const QString& token)
    {
        if (!m_Expecting) return Verdict::NotExpected;
        m_Expecting = false;
        if (type != QLatin1String("reattach")) return Verdict::NotReattach;
        if (!tokenMatches(m_Token, token)) return Verdict::WrongToken;
        return Verdict::Accepted;
    }

    /// After a reattach went through: the token that was used is spent.
    const QString& rotate()
    {
        m_Token = newToken();
        return m_Token;
    }

    static const char* describe(Verdict v)
    {
        switch (v) {
        case Verdict::Accepted: return "accepted";
        case Verdict::NotExpected: return "no reattach expected";
        case Verdict::NotReattach: return "first message was not a reattach";
        case Verdict::WrongToken: return "wrong token";
        }
        return "?";
    }

private:
    QString m_Token;
    bool m_Expecting = false;
};

/// The relay side: one window per lost browser, however many attempts it
/// takes. `expired` runs once, `ms` after open(), unless close() came first.
/// Nothing runs once `context` is gone. Lives on `context`'s thread.
class Window
{
public:
    Window(QObject* context, int ms, std::function<void()> expired)
        : m_Ms(ms)
        , m_Expired(std::move(expired))
    {
        m_Timer = new QTimer(context);
        m_Timer->setSingleShot(true);
        QObject::connect(m_Timer, &QTimer::timeout, context, [this]() {
            m_Open = false;
            if (m_Expired) m_Expired();
        });
    }

    // The timer's slot holds `this`: a copy would share the timer and leave the
    // slot pointing at the original. The timer itself belongs to `context`.
    Window(const Window&) = delete;
    Window& operator=(const Window&) = delete;

    /// Opens the window unless it already is (a second attempt keeps the first
    /// deadline). Returns whether it was opened now.
    bool open()
    {
        if (isOpen()) return false;
        m_Clock.start();
        m_Open = true;
        m_Timer->start(m_Ms);
        return true;
    }

    /// The browser is back (or the stream ends another way). Returns how long
    /// the window was open, -1 if it was not.
    qint64 close()
    {
        if (!isOpen()) return -1;
        m_Timer->stop();
        m_Open = false;
        return m_Clock.elapsed();
    }

    bool isOpen() const { return m_Open; }

private:
    int m_Ms;
    std::function<void()> m_Expired;
    QTimer* m_Timer = nullptr;
    QElapsedTimer m_Clock;
    bool m_Open = false;
};

} // namespace mw::reattach
