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

#include "GameStreamHid.h"

#include "HidCollectionsJson.h"

#include <QDebug>
#include <QJsonArray>

namespace {

// What the page reads, in words a player understands (spec §7). The log gets
// the technical reason beside them.
const char* const kNotHere = "Wii Remotes can't be connected to this stream.";
const char* const kNoBackend = "This host can't take a Wii Remote right now.";
const char* const kNotReady = "The game isn't ready for a Wii Remote yet.";
const char* const kNotAllowed = "Only Wii Remotes can be connected to this game.";
const char* const kOneOnly = "This game takes one Wii Remote per player for now.";

} // namespace

const std::vector<GameStreamHid::Model>& GameStreamHid::allowList()
{
    // A Wii Remote reports only when something changes: never put to rest, a
    // made-up report would be a false answer to the game (spec §4).
    static const std::vector<Model> kList = {
        {0x057e, 0x0306, "Nintendo RVL-CNT-01 (Wii Remote)", false},
        {0x057e, 0x0330, "Nintendo RVL-CNT-01-TR (Wii Remote Plus)", false},
    };
    return kList;
}

const GameStreamHid::Model* GameStreamHid::allowed(uint16_t vendorId, uint16_t productId)
{
    for (const Model& m : allowList())
        if (m.vendorId == vendorId && m.productId == productId) return &m;
    return nullptr;
}

std::string GameStreamHid::uniqFor(const QString& sessionId, int slot)
{
    return "wolf:" + sessionId.toStdString() + ":" + std::to_string(slot);
}

QString GameStreamHid::offReason()
{
    // IMediaEngine::hidUnavailableReason()'s own words: with the setting off,
    // nothing about a GameStream host changes.
    return QStringLiteral("the HID passthrough needs MoonlightWeb's native host");
}

GameStreamHid::GameStreamHid(RequestSink onRequest, Factory factory, ReasonProbe backendReason)
    : m_onRequest(std::move(onRequest))
    , m_factory(std::move(factory))
    , m_backendReason(backendReason ? std::move(backendReason) : ReasonProbe([] {
        return mw::native::HidPassthrough::unavailableReason();
    }))
{}

GameStreamHid::~GameStreamHid()
{
    detachAll();
}

void GameStreamHid::configure(bool enabled, bool hostIsSelf)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    m_enabled = enabled;
    m_hostIsSelf = hostIsSelf;
    if (enabled && !hostIsSelf)
        qWarning() << "[GameStreamHid] hid_passthrough_gamestream_local is on, but this "
                      "stream's host is not this machine: no device will be made";
}

bool GameStreamHid::setSessionId(const QString& sessionId)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    if (sessionId == m_sessionId) return false;
    const QString before = reasonLocked();
    m_sessionId = sessionId;
    return reasonLocked() != before;
}

QString GameStreamHid::unavailableReason() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    const QString why = reasonLocked();
    // With the setting off nothing about a GameStream host changes, the log included.
    if (m_enabled && (!m_reasonLogged || why != m_loggedReason)) {
        m_reasonLogged = true;
        m_loggedReason = why;
        if (why.isEmpty()) {
            qInfo().noquote() << "[GameStreamHid] can take a device now, for session"
                              << m_sessionId;
        } else {
            const std::string backend = m_hostIsSelf ? m_backendReason() : std::string();
            qWarning().noquote() << "[GameStreamHid] can't take a device:" << why
                                 << (backend.empty() ? QString()
                                                     : QStringLiteral("(%1)").arg(
                                                           QString::fromStdString(backend)));
        }
    }
    return why;
}

QString GameStreamHid::reasonLocked() const
{
    if (!m_enabled) return offReason();
    if (!m_hostIsSelf) return QString::fromLatin1(kNotHere);
    if (!m_backendReason().empty()) return QString::fromLatin1(kNoBackend);
    if (m_sessionId.isEmpty()) return QString::fromLatin1(kNotReady);
    return {};
}

QString GameStreamHid::attach(int slot, const QJsonObject& message)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    if (const QString why = reasonLocked(); !why.isEmpty()) {
        if (m_enabled && m_hostIsSelf) {
            const std::string backend = m_backendReason();
            if (!backend.empty())
                qWarning().noquote()
                    << "[GameStreamHid] no device:" << QString::fromStdString(backend);
        }
        return why;
    }

    const auto vendorId = static_cast<uint16_t>(message.value(QStringLiteral("vendorId")).toInt());
    const auto productId =
        static_cast<uint16_t>(message.value(QStringLiteral("productId")).toInt());
    const Model* model = allowed(vendorId, productId);
    if (!model) {
        qWarning().noquote() << "[GameStreamHid] refused"
                             << QStringLiteral("%1:%2")
                                    .arg(vendorId, 4, 16, QLatin1Char('0'))
                                    .arg(productId, 4, 16, QLatin1Char('0'))
                             << "(not on the allow-list)";
        return QString::fromLatin1(kNotAllowed);
    }
    const bool sameSlot = m_slots.count(slot) > 0;
    if (!sameSlot && static_cast<int>(m_slots.size()) >= kMaxDevices)
        return QString::fromLatin1(kOneOnly);

    QString error;
    mw::native::HidDeviceInfo device;
    device.collections =
        collectionsFromJson(message.value(QStringLiteral("collections")).toArray(), &error);
    if (!error.isEmpty()) return QStringLiteral("unreadable collections: ") + error;
    device.name = message.value(QStringLiteral("productName")).toString().left(120).toStdString();
    device.vendorId = vendorId;
    device.productId = productId;
    device.uniq = uniqFor(m_sessionId, slot);
    device.phys = kPhys;
    device.restWhenSilent = model->restWhenSilent;

    if (!m_hid) m_hid = std::make_unique<mw::native::HidPassthrough>(m_onRequest, m_factory);
    const std::string why = m_hid->attach(slot, device);
    if (!why.empty()) {
        qWarning().noquote() << "[GameStreamHid] device refused:" << QString::fromStdString(why);
        return QString::fromStdString(why);
    }
    m_slots.insert(slot);
    qInfo().noquote() << "[GameStreamHid] slot" << slot << QString::fromLatin1(model->name) << "as"
                      << QString::fromStdString(device.uniq);
    return {};
}

void GameStreamHid::attached(int slot)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    if (m_hid) m_hid->attached(slot);
}

void GameStreamHid::input(const uint8_t* frame, size_t size)
{
    if (size < 4) return;
    std::lock_guard<std::mutex> lock(m_mutex);
    if (!m_hid) return;
    const auto seq = static_cast<uint16_t>(frame[2] | (frame[3] << 8));
    m_hid->input(frame[0], frame[1], seq, frame + 4, size - 4);
}

void GameStreamHid::reply(int slot, int reportId, const QByteArray& data)
{
    if (slot < 0 || reportId < 0 || reportId > 0xFF || data.isEmpty()) return;
    std::lock_guard<std::mutex> lock(m_mutex);
    if (!m_hid) return;
    m_hid->reply(slot, static_cast<uint8_t>(reportId),
                 reinterpret_cast<const uint8_t*>(data.constData()),
                 static_cast<size_t>(data.size()));
}

void GameStreamHid::detach(int slot)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    m_slots.erase(slot);
    if (m_hid) m_hid->detach(slot);
}

void GameStreamHid::detachAll()
{
    std::unique_ptr<mw::native::HidPassthrough> gone;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_slots.clear();
        gone = std::move(m_hid);
    }
    // No parking: each device is removed with the passthrough, outside the lock.
}
