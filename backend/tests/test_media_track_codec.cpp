/*
 * MoonlightWeb — Backend TNR. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */

/**
 * The media track's codec (MediaTrackCodec.h): which codec the track carries
 * to a browser, the fmtp line it repeats from the page, how the browser's
 * answer is read, and what a keyframe looks like on the wire for H.264 and
 * HEVC alike.
 */

#include "../src/streaming/MediaTrackCodec.h"

#include "test_framework.h"

#include <string>
#include <vector>

namespace {

using Bytes = std::vector<uint8_t>;
using MediaTrackCodec::Codec;

void nal(Bytes& out, std::initializer_list<uint8_t> header, bool fourByteStart = true)
{
    if (fourByteStart) out.push_back(0);
    out.insert(out.end(), {0, 0, 1});
    out.insert(out.end(), header.begin(), header.end());
    out.insert(out.end(), {0xAF, 0x12, 0x00, 0x00, 0x03, 0x01}); // some payload
}

bool keyframe(const Bytes& b, bool hevc)
{
    return MediaTrackCodec::startsWithKeyframe(b.data(), b.size(), hevc);
}

// A browser's answer, as Chrome writes it: audio first, then the video section.
std::string answer(const std::string& videoMediaLine, const std::string& videoLines,
                   const char* eol = "\r\n")
{
    std::string sdp;
    for (const std::string& l :
         {std::string("v=0"), std::string("o=- 1 2 IN IP4 127.0.0.1"), std::string("s=-"),
          std::string("t=0 0"), std::string("a=group:BUNDLE audio video"),
          std::string("m=audio 9 UDP/TLS/RTP/SAVPF 111"), std::string("a=mid:audio"),
          std::string("a=rtpmap:111 opus/48000/2"), videoMediaLine, std::string("a=mid:video"),
          std::string("a=recvonly")})
        sdp += l + eol;
    sdp += videoLines;
    return sdp;
}

} // namespace

void run_media_track_codec_tests()
{
    SECTION("MediaTrackCodec — what the track carries, to which browser");
    {
        CHECK(MediaTrackCodec::carries(VideoCodec::H264, false));
        CHECK(MediaTrackCodec::carries(VideoCodec::H264, true));
        CHECK(!MediaTrackCodec::carries(VideoCodec::HEVC, false));
        CHECK(MediaTrackCodec::carries(VideoCodec::HEVC, true));
        CHECK(!MediaTrackCodec::carries(VideoCodec::AV1, true));
        // Auto is the caller's to resolve first.
        CHECK(!MediaTrackCodec::carries(VideoCodec::Auto, true));
    }

    SECTION("MediaTrackCodec — the negotiated format names the codec on the wire");
    {
        CHECK(MediaTrackCodec::fromVideoFormat(VIDEO_FORMAT_H264) == Codec::H264);
        CHECK(MediaTrackCodec::fromVideoFormat(VIDEO_FORMAT_H264_HIGH8_444) == Codec::H264);
        CHECK(MediaTrackCodec::fromVideoFormat(VIDEO_FORMAT_H265) == Codec::H265);
        CHECK(MediaTrackCodec::fromVideoFormat(VIDEO_FORMAT_H265_MAIN10) == Codec::H265);
        CHECK(MediaTrackCodec::fromVideoFormat(VIDEO_FORMAT_AV1_MAIN8) == Codec::None);
        CHECK(MediaTrackCodec::fromVideoFormat(0) == Codec::None);
        CHECK_EQ(MediaTrackCodec::payloadType(Codec::H264), 96);
        CHECK_EQ(MediaTrackCodec::payloadType(Codec::H265), 97);
        CHECK_EQ(std::string(MediaTrackCodec::sdpName(Codec::H265)), std::string("H265"));
        CHECK_EQ(std::string(MediaTrackCodec::sdpName(Codec::None)), std::string(""));
    }

    SECTION("MediaTrackCodec — the browser's fmtp line is kept as it is, or not at all");
    {
        const std::string chrome = "level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST";
        CHECK_EQ(MediaTrackCodec::sanitizeFmtp(chrome), chrome);
        CHECK_EQ(MediaTrackCodec::sanitizeFmtp("profile-id=1"), std::string("profile-id=1"));
        CHECK_EQ(MediaTrackCodec::sanitizeFmtp(""), std::string(""));
        // Anything that is not name=value pairs would land in the SDP as is.
        CHECK_EQ(MediaTrackCodec::sanitizeFmtp("profile-id=1 "), std::string(""));
        CHECK_EQ(MediaTrackCodec::sanitizeFmtp("profile-id=1\r\na=sendrecv"), std::string(""));
        CHECK_EQ(MediaTrackCodec::sanitizeFmtp("a=fmtp:97 profile-id=1"), std::string(""));
        CHECK_EQ(MediaTrackCodec::sanitizeFmtp("profile-id"), std::string(""));
        CHECK_EQ(MediaTrackCodec::sanitizeFmtp("profile-id=1;"), std::string(""));
        CHECK_EQ(MediaTrackCodec::sanitizeFmtp(";profile-id=1"), std::string(""));
        CHECK_EQ(MediaTrackCodec::sanitizeFmtp("profile-id="), std::string(""));
        CHECK_EQ(MediaTrackCodec::sanitizeFmtp(std::string(200, 'a') + "=1"), std::string(""));
    }

    SECTION("MediaTrackCodec — the answer keeps the codec offered, or it does not");
    {
        const std::string h265 = answer("m=video 9 UDP/TLS/RTP/SAVPF 97",
                                        "a=rtpmap:97 H265/90000\r\n"
                                        "a=fmtp:97 level-id=180;profile-id=1;tier-flag=0\r\n"
                                        "a=rtcp-fb:97 nack\r\n");
        CHECK(MediaTrackCodec::answerKeeps(h265, Codec::H265, 97));
        CHECK(!MediaTrackCodec::answerKeeps(h265, Codec::H264, 96));
        CHECK(!MediaTrackCodec::answerKeeps(h265, Codec::H265, 96));
        // Case does not matter on the rtpmap line; the line endings neither.
        CHECK(MediaTrackCodec::answerKeeps(
            answer("m=video 9 UDP/TLS/RTP/SAVPF 97", "a=rtpmap:97 h265/90000\n", "\n"), Codec::H265,
            97));
        // The section rejected: port 0.
        CHECK(!MediaTrackCodec::answerKeeps(
            answer("m=video 0 UDP/TLS/RTP/SAVPF 97", "a=rtpmap:97 H265/90000\r\n"), Codec::H265,
            97));
        // The codec dropped from the answer, the section kept for the bundle.
        CHECK(!MediaTrackCodec::answerKeeps(answer("m=video 9 UDP/TLS/RTP/SAVPF 96", ""),
                                            Codec::H265, 97));
        // An rtpmap in another section is not this one's.
        CHECK(!MediaTrackCodec::answerKeeps(
            answer("m=video 9 UDP/TLS/RTP/SAVPF 96", "a=rtpmap:96 H264/90000\r\n") +
                "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=rtpmap:97 H265/90000\r\n",
            Codec::H265, 97));
        // Today's H.264 answer reads as it always did.
        CHECK(MediaTrackCodec::answerKeeps(
            answer("m=video 9 UDP/TLS/RTP/SAVPF 96",
                   "a=rtpmap:96 H264/90000\r\na=fmtp:96 "
                   "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n"),
            Codec::H264, 96));
        CHECK(!MediaTrackCodec::answerKeeps("", Codec::H264, 96));
        CHECK(!MediaTrackCodec::answerKeeps("v=0\r\nm=audio 9 RTP/SAVPF 111\r\n", Codec::H264, 96));
        CHECK(!MediaTrackCodec::answerKeeps(h265, Codec::None, 97));
    }

    SECTION("MediaTrackCodec — an HEVC keyframe is the IRAP slice, whatever opens the unit");
    {
        Bytes idr;
        nal(idr, {0x40, 0x01}); // VPS
        nal(idr, {0x42, 0x01}); // SPS
        nal(idr, {0x44, 0x01}); // PPS
        nal(idr, {0x26, 0x01}); // IDR_W_RADL (19)
        CHECK(keyframe(idr, true));

        Bytes cra;
        nal(cra, {0x46, 0x01});        // AUD
        nal(cra, {0x4E, 0x01});        // prefix SEI
        nal(cra, {0x2A, 0x01}, false); // CRA (21), three-byte start code
        CHECK(keyframe(cra, true));

        Bytes idrNlp;
        nal(idrNlp, {0x28, 0x01}); // IDR_N_LP (20)
        CHECK(keyframe(idrNlp, true));

        Bytes bla;
        nal(bla, {0x20, 0x01}); // BLA_W_LP (16)
        CHECK(keyframe(bla, true));

        Bytes trail;
        nal(trail, {0x4E, 0x01}); // prefix SEI
        nal(trail, {0x02, 0x01}); // TRAIL_R (1): the first VCL NAL decides
        nal(trail, {0x26, 0x01}); // an IDR after it changes nothing
        CHECK(!keyframe(trail, true));

        Bytes reserved;
        nal(reserved, {0x2C, 0x01}); // RSV_IRAP_VCL22: not a picture we know
        CHECK(!keyframe(reserved, true));

        Bytes parameterSetsOnly;
        nal(parameterSetsOnly, {0x40, 0x01});
        nal(parameterSetsOnly, {0x42, 0x01});
        CHECK(!keyframe(parameterSetsOnly, true));
    }

    SECTION("MediaTrackCodec — an H.264 keyframe is the IDR slice (type 5)");
    {
        Bytes idr;
        nal(idr, {0x67}); // SPS
        nal(idr, {0x68}); // PPS
        nal(idr, {0x65}); // IDR
        CHECK(keyframe(idr, false));
        // The same bytes read as HEVC say nothing: 0x67 is a type-51 NAL.
        CHECK(!keyframe(idr, true));

        Bytes delta;
        nal(delta, {0x06}); // SEI
        nal(delta, {0x41}); // non-IDR slice
        CHECK(!keyframe(delta, false));

        Bytes shortCodes;
        nal(shortCodes, {0x67}, false);
        nal(shortCodes, {0x65}, false);
        CHECK(keyframe(shortCodes, false));
    }

    SECTION("MediaTrackCodec — nothing to read is no keyframe");
    {
        CHECK(!MediaTrackCodec::startsWithKeyframe(nullptr, 0, true));
        const Bytes tiny = {0, 0, 1};
        CHECK(!keyframe(tiny, true));
        const Bytes startCodeOnly = {0, 0, 0, 1};
        CHECK(!keyframe(startCodeOnly, false));
        const Bytes noStartCode = {0x65, 0x88, 0x84, 0x00, 0x11};
        CHECK(!keyframe(noStartCode, false));
    }
}
