/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin. GPLv3.
 */
#include "test_framework.h"
#include "backend/streambackend/IStreamBackend.h"

#include <QString>

// A failed /launch or /resume hands Qt's error string to BackendError, and that
// string quotes the whole URL. rikey (the input AES key) and rikeyid (its IV)
// must be gone before the message reaches a log line or the browser.
void run_backend_error_tests()
{
    SECTION("BackendError: launch secrets never survive in the message");

    const QString qtResume =
        QStringLiteral("Error transferring https://192.168.4.120:47784/resume?uniqueid=0123abcd"
                       "&uuid=1f2e&mode=1280x720x60&rikey=00112233445566778899AABBCCDDEEFF"
                       "&rikeyid=-123456789&localAudioPlayMode=0 - server replied: Bad Request");
    const BackendError e = BackendError::make(BackendError::Protocol, qtResume, 400);
    CHECK(!e.message.contains(QStringLiteral("00112233445566778899AABBCCDDEEFF")));
    CHECK(!e.message.contains(QStringLiteral("-123456789")));
    CHECK(
        e.message.contains(QStringLiteral("rikey=(hidden)&rikeyid=(hidden)&localAudioPlayMode=0")));
    // What a reader needs to diagnose the failure stays.
    CHECK(e.message.contains(QStringLiteral("server replied: Bad Request")));
    CHECK(e.message.contains(QStringLiteral("/resume?uniqueid=0123abcd")));
    CHECK_EQ(e.httpStatus, 400);
    CHECK(e.kind == BackendError::Protocol);

    // The key last in the query, and lower-case hex.
    const BackendError last = BackendError::make(
        BackendError::Timeout,
        QStringLiteral("Error transferring https://h:47984/launch?appid=1&rikey=deadbeef"));
    CHECK(last.message.endsWith(QStringLiteral("rikey=(hidden)")));

    // A message with no URL is left exactly as it was.
    const QString plain = QStringLiteral("Connection refused");
    CHECK_EQ(BackendError::make(BackendError::Unreachable, plain).message, plain);

    // Only the parameters themselves: a word that merely ends in "rikey" is not one.
    const QString lookalike = QStringLiteral("forikey=1");
    CHECK_EQ(BackendError::withoutLaunchSecrets(lookalike), lookalike);
}
