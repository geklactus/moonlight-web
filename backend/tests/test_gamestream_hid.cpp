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

/*
 * The HID passthrough on a co-located GameStream host (GameStreamHid): what it
 * says before it makes anything, what it refuses, the tag it gives a device,
 * and a device's life from the page's attach to the stream's end — against a
 * fake uhid, so it runs anywhere.
 */
#include "test_framework.h"

#include "../src/streaming/GameStreamHid.h"
#include "input/VirtualHid.h"

#include <QJsonArray>
#include <QJsonObject>

#include <memory>
#include <vector>

using mw::native::HidRequest;
namespace input = mw::native::input;

namespace {

struct FakeLog
{
    std::vector<input::VirtualHidIdentity> created;
    std::vector<std::vector<uint8_t>> inputs;
    int destroyed = 0;
    class FakeUhid* last = nullptr;
};

class FakeUhid : public input::IVirtualHid
{
public:
    explicit FakeUhid(FakeLog& log)
        : m_log(log)
    {
        m_log.last = this;
    }
    ~FakeUhid() override { destroy(); }
    bool create(const input::VirtualHidIdentity& id, std::string&) override
    {
        m_log.created.push_back(id);
        m_alive = true;
        return true;
    }
    bool input(const uint8_t* r, size_t n) override
    {
        m_log.inputs.emplace_back(r, r + n);
        return true;
    }
    void destroy() override
    {
        if (m_alive) ++m_log.destroyed;
        m_alive = false;
    }
    /// What Dolphin writing to the hidraw node looks like from here.
    void write(uint8_t id, std::vector<uint8_t> data)
    {
        if (m_onRequest) m_onRequest(Request::Output, id, data);
    }

private:
    FakeLog& m_log;
    bool m_alive = false;
};

/// The page's hidattach for a device whose reports are one vendor byte array
/// each, as Chrome shows Nintendo's Wii Remote descriptor (0x10–0x1a out,
/// 0x20–0x3f in; the sizes without the id byte).
QJsonObject attachMessage(int vendorId, int productId)
{
    auto reports = [](std::initializer_list<std::pair<int, int>> list) {
        QJsonArray out;
        for (auto [id, n] : list) {
            QJsonObject item{{"usages", QJsonArray{4278190081.0}}, // 0xFF000001
                             {"reportSize", 8},
                             {"reportCount", n},
                             {"logicalMinimum", 0},
                             {"logicalMaximum", 255},
                             {"isArray", true}};
            out.append(QJsonObject{{"reportId", id}, {"items", QJsonArray{item}}});
        }
        return out;
    };
    QJsonObject app{
        {"usagePage", 1},
        {"usage", 5},
        {"type", 1},
        {"children", QJsonArray{}},
        {"featureReports", QJsonArray{}},
        {"outputReports", reports({{0x10, 1},
                                   {0x11, 1},
                                   {0x12, 2},
                                   {0x13, 1},
                                   {0x14, 1},
                                   {0x15, 1},
                                   {0x16, 21},
                                   {0x17, 6},
                                   {0x18, 21},
                                   {0x19, 1},
                                   {0x1a, 1}})},
        {"inputReports", reports({{0x20, 6},
                                  {0x21, 21},
                                  {0x22, 4},
                                  {0x30, 2},
                                  {0x31, 5},
                                  {0x32, 10},
                                  {0x33, 17},
                                  {0x34, 21},
                                  {0x35, 21},
                                  {0x36, 21},
                                  {0x37, 21},
                                  {0x3d, 21},
                                  {0x3e, 21},
                                  {0x3f, 21}})},
    };
    return QJsonObject{{"type", "hidattach"},
                       {"slot", 0},
                       {"vendorId", vendorId},
                       {"productId", productId},
                       {"productName", "Nintendo RVL-CNT-01"},
                       {"collections", QJsonArray{app}}};
}

const QJsonObject kWiimote = attachMessage(0x057e, 0x0306);

struct Rig
{
    FakeLog log;
    std::vector<HidRequest> asked;
    std::string backendWhy;
    GameStreamHid hid{[this](const HidRequest& r) { asked.push_back(r); },
                      [this] { return std::make_unique<FakeUhid>(log); },
                      [this] { return backendWhy; }};

    /// On, the host is this machine, the session known.
    void ready(const QString& session = QStringLiteral("12345678901234567890"))
    {
        hid.configure(true, true);
        hid.setSessionId(session);
    }
};

} // namespace

void run_gamestream_hid_tests()
{
    SECTION("GameStreamHid — setting off: a GameStream host's reason, unchanged; nothing made");
    {
        Rig r;
        CHECK(r.hid.unavailableReason() ==
              QStringLiteral("the HID passthrough needs MoonlightWeb's native host"));
        CHECK(r.hid.unavailableReason() == GameStreamHid::offReason());
        // Off, whatever else holds: a host on this machine and a known session.
        r.hid.configure(false, true);
        r.hid.setSessionId(QStringLiteral("1"));
        CHECK(r.hid.unavailableReason() == GameStreamHid::offReason());
        CHECK(r.hid.attach(0, kWiimote) == GameStreamHid::offReason());
        CHECK(r.log.created.empty());
    }

    SECTION("GameStreamHid — on, but the host is elsewhere: refused, nothing made");
    {
        Rig r;
        r.hid.configure(true, false);
        r.hid.setSessionId(QStringLiteral("1"));
        CHECK(!r.hid.unavailableReason().isEmpty());
        CHECK(r.hid.unavailableReason() != GameStreamHid::offReason());
        CHECK(!r.hid.attach(0, kWiimote).isEmpty());
        CHECK(r.log.created.empty());
    }

    SECTION("GameStreamHid — no uhid here: refused in plain words");
    {
        Rig r;
        r.backendWhy = "/dev/uhid is not writable by this user (udev rule missing)";
        r.ready();
        CHECK(r.hid.unavailableReason() ==
              QStringLiteral("This host can't take a Wii Remote right now."));
        CHECK(!r.hid.attach(0, kWiimote).isEmpty());
        CHECK(r.log.created.empty());
    }

    SECTION("GameStreamHid — not ready until the host's session id is known; the change is "
            "announced once");
    {
        Rig r;
        r.hid.configure(true, true);
        CHECK(!r.hid.unavailableReason().isEmpty());
        CHECK(!r.hid.attach(0, kWiimote).isEmpty());
        CHECK(r.log.created.empty());
        CHECK(r.hid.setSessionId(QStringLiteral("42"))); // now available: say so
        CHECK(r.hid.unavailableReason().isEmpty());
        CHECK(!r.hid.setSessionId(QStringLiteral("42"))); // the same: nothing to say
        CHECK(r.hid.attach(0, kWiimote).isEmpty());
    }

    SECTION("GameStreamHid — the allow-list: Wii Remotes only");
    {
        CHECK(GameStreamHid::allowed(0x057e, 0x0306) != nullptr);
        CHECK(GameStreamHid::allowed(0x057e, 0x0330) != nullptr);
        CHECK(GameStreamHid::allowed(0x045e, 0x028e) == nullptr); // an Xbox 360 pad
        CHECK(GameStreamHid::allowed(0x057e, 0x2009) == nullptr); // a Switch Pro Controller
        for (const GameStreamHid::Model& m : GameStreamHid::allowList())
            CHECK(!m.restWhenSilent); // quiet on purpose: never put to rest

        Rig r;
        r.ready();
        CHECK(r.hid.attach(0, attachMessage(0x045e, 0x028e)) ==
              QStringLiteral("Only Wii Remotes can be connected to this game."));
        CHECK(r.log.created.empty());
        CHECK(r.hid.attach(0, attachMessage(0x057e, 0x0330)).isEmpty());
        CHECK_EQ(r.log.created.size(), static_cast<size_t>(1));
    }

    SECTION("GameStreamHid — the device is tagged with the host's session and its slot");
    {
        Rig r;
        r.ready(QStringLiteral("12345678901234567890"));
        CHECK(r.hid.attach(0, kWiimote).isEmpty());
        CHECK_EQ(r.log.created.size(), static_cast<size_t>(1));
        const input::VirtualHidIdentity& id = r.log.created[0];
        CHECK(id.uniq == "wolf:12345678901234567890:0");
        CHECK(id.phys == "moonlightweb/wolf");
        CHECK_EQ(id.vendorId, static_cast<uint16_t>(0x057e));
        CHECK_EQ(id.productId, static_cast<uint16_t>(0x0306));
        CHECK(id.name == "Nintendo RVL-CNT-01");
        CHECK(GameStreamHid::uniqFor(QStringLiteral("7"), 3) == "wolf:7:3");
    }

    SECTION("GameStreamHid — a device's life: reports in, the game's writes out, a reattach "
            "keeps it, detach and the stream's end remove it");
    {
        Rig r;
        r.ready();
        CHECK(r.hid.attach(0, kWiimote).isEmpty());
        r.hid.attached(0);

        // A data report (0x30: buttons) on the 'hid' channel: [slot][id][seq][bytes].
        const uint8_t frame[] = {0, 0x30, 1, 0, 0x00, 0x08};
        r.hid.input(frame, sizeof frame);
        CHECK_EQ(r.log.inputs.size(), static_cast<size_t>(1));
        CHECK(r.log.inputs[0] == (std::vector<uint8_t>{0x30, 0x00, 0x08}));

        // A status report (0x20) as hidreply: injected once, as it came.
        const QByteArray status("\x00\x00\x00\x00\x00\x96", 6);
        r.hid.reply(0, 0x20, status);
        CHECK_EQ(r.log.inputs.size(), static_cast<size_t>(2));
        CHECK(r.log.inputs[1] == (std::vector<uint8_t>{0x20, 0, 0, 0, 0, 0, 0x96}));
        r.hid.reply(0, 0x20, status.left(5)); // not the report's size
        CHECK_EQ(r.log.inputs.size(), static_cast<size_t>(2));

        // What the game writes (lights: player 1) goes to the page's request path.
        r.log.last->write(0x11, {0x11, 0x10});
        CHECK_EQ(r.asked.size(), static_cast<size_t>(1));
        CHECK(r.asked[0].slot == 0 && r.asked[0].kind == HidRequest::Kind::Output &&
              r.asked[0].reportId == 0x11);
        CHECK(r.asked[0].data == (std::vector<uint8_t>{0x11, 0x10}));

        // The page reattached and sends the device again: the game keeps it.
        CHECK(r.hid.attach(0, kWiimote).isEmpty());
        CHECK_EQ(r.log.created.size(), static_cast<size_t>(1));
        CHECK_EQ(r.log.destroyed, 0);

        // One device per stream: a second one on another slot is refused.
        CHECK(r.hid.attach(1, kWiimote) ==
              QStringLiteral("This game takes one Wii Remote per player for now."));
        CHECK_EQ(r.log.created.size(), static_cast<size_t>(1));

        // Detached: removed, and the slot is free again.
        r.hid.detach(0);
        CHECK_EQ(r.log.destroyed, 1);
        r.hid.input(frame, sizeof frame); // to nothing: no harm
        CHECK_EQ(r.log.inputs.size(), static_cast<size_t>(2));
        CHECK(r.hid.attach(1, kWiimote).isEmpty());
        CHECK(r.log.created[1].uniq == "wolf:12345678901234567890:1");

        // The stream ends: every device goes.
        r.hid.detachAll();
        CHECK_EQ(r.log.destroyed, 2);
        r.hid.detachAll(); // twice: no harm
        CHECK_EQ(r.log.destroyed, 2);
    }

    SECTION("GameStreamHid — the stream's end removes what is left, with the object");
    {
        FakeLog log;
        {
            GameStreamHid hid(
                nullptr, [&] { return std::make_unique<FakeUhid>(log); },
                [] { return std::string(); });
            hid.configure(true, true);
            hid.setSessionId(QStringLiteral("9"));
            CHECK(hid.attach(0, kWiimote).isEmpty());
        }
        CHECK_EQ(log.destroyed, 1);
    }
}
