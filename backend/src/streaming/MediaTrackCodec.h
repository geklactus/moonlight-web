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

#include "StreamConfig.h"

extern "C" {
#include "Limelight.h"
}

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>

// The video codec of the WebRTC media track (MediaTrackRelay): which codec the
// track can carry to a given browser, how the browser's answer is read, and
// what a keyframe looks like on the wire. Header-only, free of Qt and
// libdatachannel, so the backend TNR can check it.
//
// ── Why the browser is asked ────────────────────────────────────────────────
//
// On this transport the RTP stream goes to the browser's own WebRTC decoder,
// not to WebCodecs. Which codecs that decoder takes is a different question
// from which VideoDecoder takes (Chrome decoded HEVC in WebCodecs long before
// it listed H265 in RTCRtpReceiver.getCapabilities, and Firefox lists it
// nowhere), so the page asks RTCRtpReceiver and sends the answer with /start:
// `media_h265`, and `media_h265_fmtp`, the fmtp line the receiver lists for
// it. The host offers H.265 on the track only then, with that very line:
// libwebrtc matches an H265 codec on profile, tier AND level, defaulting the
// parameters an offer leaves out to Main / tier 0 / level 3.1, so an offer
// that does not repeat the browser's own line is answered with no codec at
// all. AV1 stays off this track: its RTP negotiation is a question of its own.
namespace MediaTrackCodec {

/// What the track carries. None: nothing it can packetize (AV1, or unknown).
enum class Codec
{
    None,
    H264,
    H265
};

/// RTP payload types of the offer. H.264 keeps the 96 it always had; H.265
/// takes the next dynamic one, so a log line names the codec by its PT.
constexpr int kH264PayloadType = 96;
constexpr int kH265PayloadType = 97;

/// The longest fmtp line kept from the page (Chrome's is ~50 characters).
constexpr size_t kMaxFmtpLength = 160;

/// The codec's name on an a=rtpmap line; "" for None.
inline const char* sdpName(Codec codec)
{
    switch (codec) {
    case Codec::H264: return "H264";
    case Codec::H265: return "H265";
    default: return "";
    }
}

inline int payloadType(Codec codec)
{
    return codec == Codec::H265 ? kH265PayloadType : kH264PayloadType;
}

/// Whether the media track can carry @p codec — the one the host is asked for,
/// Auto resolved by the caller — to a browser that said @p browserH265 about
/// its RTP decoder. H.264 always; H.265 only to a browser that takes it; never
/// AV1 (see above).
inline bool carries(VideoCodec codec, bool browserH265)
{
    switch (codec) {
    case VideoCodec::H264: return true;
    case VideoCodec::HEVC: return browserH265;
    default: return false;
    }
}

/// The codec the host negotiated (a VIDEO_FORMAT_* mask), as the track carries it.
inline Codec fromVideoFormat(int videoFormat)
{
    if (videoFormat & VIDEO_FORMAT_MASK_H265) return Codec::H265;
    if (videoFormat & VIDEO_FORMAT_MASK_H264) return Codec::H264;
    return Codec::None;
}

/// The browser's H.265 fmtp line, kept only when it is one: `name=value`
/// pairs separated by semicolons (letters, digits, `=`, `;`, `-`), at most
/// kMaxFmtpLength characters. It goes into the SDP offer as is, so anything
/// else — a newline, a space, a second attribute — comes back empty.
inline std::string sanitizeFmtp(std::string_view line)
{
    if (line.empty() || line.size() > kMaxFmtpLength) return {};
    bool equals = false;
    for (const char c : line) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                        (c >= '0' && c <= '9') || c == '=' || c == ';' || c == '-';
        if (!ok) return {};
        if (c == '=') equals = true;
    }
    if (!equals || line.front() == ';' || line.back() == ';' || line.back() == '=') return {};
    return std::string(line);
}

/// Whether the browser's SDP answer keeps the video codec the offer carried:
/// its m=video section is not rejected (port 0) and maps @p payloadType to
/// @p codec. An answer that keeps nothing means no picture can reach the
/// browser's <video>; the page's codec fallback is what gets it a stream.
inline bool answerKeeps(std::string_view sdp, Codec codec, int payloadType)
{
    const std::string_view name = sdpName(codec);
    if (name.empty()) return false;
    size_t pos = 0;
    while (pos < sdp.size()) {
        const size_t lineEnd = sdp.find('\n', pos);
        const size_t next = lineEnd == std::string_view::npos ? sdp.size() : lineEnd + 1;
        std::string_view line = sdp.substr(pos, next - pos);
        while (!line.empty() && (line.back() == '\n' || line.back() == '\r'))
            line.remove_suffix(1);
        pos = next;
        if (line.substr(0, 8) != "m=video ") continue;
        // "m=video <port> <proto> <pt>...": a port of 0 rejects the section.
        if (line.substr(8, 2) == "0 ") return false;
        // The section runs to the next m= line.
        const std::string wanted = "a=rtpmap:" + std::to_string(payloadType) + ' ';
        while (pos < sdp.size()) {
            const size_t end = sdp.find('\n', pos);
            const size_t after = end == std::string_view::npos ? sdp.size() : end + 1;
            std::string_view l = sdp.substr(pos, after - pos);
            while (!l.empty() && (l.back() == '\n' || l.back() == '\r'))
                l.remove_suffix(1);
            pos = after;
            if (l.substr(0, 2) == "m=") return false;
            if (l.size() < wanted.size() + name.size() ||
                l.substr(0, wanted.size()) != std::string_view(wanted))
                continue;
            std::string_view rest = l.substr(wanted.size());
            // The codec name, then "/90000", compared without case: Firefox
            // writes H264 where Chrome writes H264 too, but the RFC allows both.
            if (rest.size() < name.size()) continue;
            bool same = true;
            for (size_t i = 0; i < name.size() && same; ++i) {
                const char a = rest[i], b = name[i];
                const char la = (a >= 'A' && a <= 'Z') ? static_cast<char>(a + 32) : a;
                const char lb = (b >= 'A' && b <= 'Z') ? static_cast<char>(b + 32) : b;
                same = la == lb;
            }
            if (same && (rest.size() == name.size() || rest[name.size()] == '/')) return true;
        }
        return false;
    }
    return false;
}

/// Whether an Annex B access unit begins a picture decodable on its own: its
/// first VCL NAL is an IDR (H.264 type 5) or an IRAP (HEVC types 16-21: BLA,
/// IDR_W_RADL, IDR_N_LP, CRA). Parameter sets, SEI and AUD ahead of it are
/// walked past; a unit with no VCL NAL at all is no keyframe. The GameStream
/// depacketizer flags a keyframe by the parameter sets that open it; this
/// reads the slice itself, which is what the browser's decoder goes by.
inline bool startsWithKeyframe(const uint8_t* data, size_t size, bool hevc)
{
    if (!data || size < 4) return false;
    size_t from = 2; // a start code's 0x01 sits at index 2 at the earliest
    while (from < size) {
        const void* hit = std::memchr(data + from, 0x01, size - from);
        if (!hit) return false;
        const size_t one = static_cast<size_t>(static_cast<const uint8_t*>(hit) - data);
        from = one + 1;
        if (data[one - 1] != 0 || data[one - 2] != 0) continue;
        const size_t header = one + 1;
        if (header >= size) return false;
        const uint8_t type = hevc ? static_cast<uint8_t>((data[header] >> 1) & 0x3F)
                                  : static_cast<uint8_t>(data[header] & 0x1F);
        if (hevc) {
            if (type < 32) return type >= 16 && type <= 21; // the first VCL NAL decides
        } else {
            if (type >= 1 && type <= 5) return type == 5;
        }
        from = one + 3; // the next 0x01 needs a header byte and two zeros first
    }
    return false;
}

} // namespace MediaTrackCodec
