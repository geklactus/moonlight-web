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

#include "mw/native/HidPassthrough.h"

#include <QJsonObject>
#include <QString>

#include <cstdint>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

/// The HID passthrough for a GameStream host that runs on THIS machine.
///
/// A GameStream host elsewhere can never see a device made here, so the
/// passthrough is the native engine's alone (IMediaEngine). One deployment is
/// the exception: Wolf on the machine moonlight-web runs on, where a service of
/// the host's (LOLA's wolf-hid-bridge) puts a device made through uhid into the
/// player's own game container. For that, and only behind the operator's
/// setting (hid_passthrough_gamestream_local, off by default), this recreates
/// the devices the page sends with the same uhid code the native host uses.
///
/// Why the setting is not enough on its own: a device made here lands on this
/// machine's desktop, driven by whoever is on the other end of the stream. With
/// the host elsewhere, the game would never see it and this machine would have
/// a stranger's controller. So the host's address must also be this machine
/// (ClipboardBridge::isSelfAddress), and the device must be on the allow-list.
///
/// Each device is tagged so the host's service can tell whose it is:
/// uniq "wolf:<host session id>:<slot>", phys "moonlightweb/wolf". The id is
/// the host's own name for this stream's session (Wolf's session id, which its
/// game container carries as WOLF_SESSION_ID), learned once the stream starts;
/// until then the passthrough says it is not ready, and announces the change.
///
/// Thread-safe, like HidPassthrough: the policy is set from the session's
/// thread, attaches come from the relay's input handler, frames from the 'hid'
/// channel's callback.
///
/// Design: geklactus/lola docs/adr/0001-wii-remote-path.md and
/// docs/wiimote/spec.md (§2–§5).
class GameStreamHid
{
public:
    /// A device model this passthrough recreates.
    struct Model
    {
        uint16_t vendorId;
        uint16_t productId;
        const char* name;
        /// Whether a silence puts it back to rest (HidDeviceInfo::restWhenSilent).
        bool restWhenSilent;
    };

    /// What it recreates, and nothing else: Wii Remotes for now.
    static const std::vector<Model>& allowList();
    static const Model* allowed(uint16_t vendorId, uint16_t productId);

    /// The tag's parts (see the class comment).
    static constexpr const char* kPhys = "moonlightweb/wolf";
    static std::string uniqFor(const QString& sessionId, int slot);

    /// One device per stream for now (spec §2.1); four with lobbies, later.
    static constexpr int kMaxDevices = 1;

    using Factory = mw::native::HidPassthrough::Factory;
    using RequestSink = mw::native::HidPassthrough::RequestSink;
    using ReasonProbe = std::function<std::string()>;

    /// `factory` and `backendReason` are for tests; by default the OS's uhid
    /// backend and its own word on whether /dev/uhid can be used.
    explicit GameStreamHid(RequestSink onRequest, Factory factory = nullptr,
                           ReasonProbe backendReason = nullptr);
    ~GameStreamHid();
    GameStreamHid(const GameStreamHid&) = delete;
    GameStreamHid& operator=(const GameStreamHid&) = delete;

    /// The operator's setting, and whether the stream's host is this machine.
    void configure(bool enabled, bool hostIsSelf);
    /// The host's id for this stream's session. True when that changed what
    /// unavailableReason() says (the page should hear hidcaps again).
    bool setSessionId(const QString& sessionId);

    /// Empty when a device can be attached; otherwise why not, for the page.
    /// With the setting off, exactly the reason a GameStream host always gave.
    QString unavailableReason() const;

    /// The page's hidattach: empty on success, otherwise why not.
    QString attach(int slot, const QJsonObject& message);
    void attached(int slot);
    /// One message of the 'hid' channel: [slot][report id][seq u16 LE][report].
    void input(const uint8_t* frame, size_t size);
    void reply(int slot, int reportId, const QByteArray& data);
    void detach(int slot);
    /// The stream ends: every device goes, now.
    void detachAll();

    /// The reason a GameStream host gives when this is off (IMediaEngine's).
    static QString offReason();

private:
    QString reasonLocked() const;

    RequestSink m_onRequest;
    Factory m_factory;
    ReasonProbe m_backendReason;

    mutable std::mutex m_mutex;
    bool m_enabled = false;
    bool m_hostIsSelf = false;
    QString m_sessionId;
    std::set<int> m_slots;
    std::unique_ptr<mw::native::HidPassthrough> m_hid; // made at the first attach
};
