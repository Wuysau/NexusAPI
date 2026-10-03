# HTTP/2 acknowledgment fixture cancellation

## Hosted failure and characterization

Main `02dc9b3`, CI `37156131886`:Go2356 pass/3 fail/0 skipped. The single failing leaf is TestResultAcknowledgmentCompletedUpload/http2_tls/finite_error; its two parent tests account for the other failures. The fixture requires its complete response Flush to succeed, although production deliberately closes the unused acknowledgment body after receiving headers. No production deadline or data-race failure was reported.

The exact unchanged test passes100 local race iterations; that is not a reproduction of the hosted failure. A retained ignored Go standard-library scheduling overlay instead pauses HTTP/2 between HEADERS and buffered DATA until the request is canceled. Under this forced transport ordering, the original assertion fails with `http2: stream closed` in160 ms. The overlay is characterization evidence, not an unmodified transport acceptance run.

## Minimal fixture correction

Keep real private TLS/HTTP1/HTTP2 and every upload-frame, authorization, bounded-worker-release, cancellation and no-replay assertion. A transparent transport observer delegates the original TLS transport and its idle-connection cleanup, recording only response status/protocol/TLS by synthetic result path. A response Flush error is accepted only after that actual expected HTTP/2 acknowledgment has reached the client and the peer has canceled its request. Live, unobserved or mismatched errors remain failures. Apply the same oracle to early HTTP/2 acknowledgment because it has the same transport ordering. No production code, timeout increase, sleep, skip or replay change.

## Verification

Same forced ordering:observed expected ACK GREEN; remove only observation RED, each3 parent-inclusive results. Real unmodified-transport ACK race50 iterations:850 passed/0 failed/0 skipped,24.9 seconds, no data races. Full connector-package race235 pass/0fail/0skip,20.4 seconds; Linux package vet, scoped gofmt/diff and independent review pass.

Fresh complete `npm run ci:go`:2359 passed/0 failed/0 skipped, lint0issues, actual storage200→500→200, Budget/Worker posting/release/replay pass,288 seconds. All331 relevant Go/scripts/migration/service/package inputs have identical before/after hashes; unrelated Control Plane Task changes are excluded explicitly. No latest-main hosted acceptance claim is made before that CI completes. All private receipts remain ignored; no provider accounts or production databases are involved.
