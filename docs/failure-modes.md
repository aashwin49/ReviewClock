# ReviewClock – Failure Modes Testing

## 1. Duplicate Delivery

* **Objective:** Confirm a repeated GitHub delivery ID cannot create another inbox record or duplicate PR facts.
* **Testing procedure:** Sent the same valid, signed `pull_request` body twice over HTTP to `/hooks/github/:endpointId`, with the same `X-GitHub-Delivery` value. Waited for the worker to process the first record, then queried deliveries and pull requests.
* **Expected result:** Both requests are acknowledged; MongoDB's unique `(sourceId, deliveryID)` index rejects the second insert; one delivery and one PR/event fact remain.
* **Actual result:** Both requests returned `202`. Exactly one Delivery row and one PullRequest row existed; its lifecycle event was present once. The route catches MongoDB `E11000`, writes a server log entry, and does not enqueue a second worker task. Duplicate attempts do not get a separate Delivery row or appear as a `duplicate` database status in the real delivery log.
* **Status: PASS** (automated HTTP and disposable MongoDB drill).
* **Issues found:** No processing or data duplication issue found. Duplicate attempts are visible only in server logs, not as separate rows in the Deliveries UI.
* **Code changes:** Added regression coverage in `backend/tests/phase8.integration.test.js`; production duplicate handling was already implemented and needed no change.

## 2. Signature Forgery

* **Objective:** Confirm webhook bodies without the correct source-specific HMAC cannot enter the delivery pipeline.
* **Testing procedure:** Sent a body changed after signing, a request with a malformed/fake signature, and a request without `X-Hub-Signature-256`. Checked delivery and PR counts for the test source.
* **Expected result:** Each request returns `401`; no Delivery, PullRequest, or worker processing is created.
* **Actual result:** All three requests returned `401`. No delivery or PR row was created. The handler calculates HMAC-SHA256 over `req.rawBody`, loads the webhook secret for the matched endpoint, validates the signature shape, and compares digest bytes with `timingSafeEqual`.
* **Status: PASS** (automated HTTP drill against the local Express app).
* **Issues found:** No signature bypass or data entry found. A real request from GitHub was not sent.
* **Code changes:** Added regression coverage in `backend/tests/phase8.integration.test.js`; production signature verification was already implemented and needed no change.

## 3. Event Reordering

* **Objective:** Confirm event arrival order does not make older lifecycle or review events overwrite newer PR state.
* **Testing procedure:** Ran `backend/tests/prState.test.js`, including its four-event permutation test (all 24 orderings), late older lifecycle event, duplicate event, reopening, close/merge, approval/comment, and changes-requested cases.
* **Expected result:** The final derived state is consistent across permutations; older events do not supersede newer timestamps; repeated events do not add duplicate facts.
* **Actual result:** All state derivation tests passed. All 24 event orderings resulted in `Merged`; the late older open did not undo a newer close; reopening and review-status transitions passed; duplicate event application remained idempotent.
* **Status: PASS** (automated unit tests).
* **Issues found:** No Phase 9 event-ordering defect found. GitHub `updated_at` / review `submitted_at` timestamps determine ordering; equal-time events use a stable action or event-ID tie-breaker.
* **Code changes:** No Phase 9 production change. Existing permutation and state tests were run without weakening assertions.

## 4. Worker Crash Recovery

* **Objective:** Confirm a worker can reclaim a delivery left in `processing` after a crash, while concurrent workers do not claim it twice.
* **Testing procedure:** Seeded an isolated Delivery in `processing` with an expired `processingAt` lease to model a worker that exited after claiming it. Confirmed the row remained in `processing`, then called two worker polls concurrently with a 60-second lease. Checked final delivery, PR, and activity records.
* **Expected result:** One poll atomically reclaims the expired delivery; the other cannot claim it; the recovered event is processed and idempotency prevents duplicate PR/activity updates.
* **Actual result:** Exactly one of the concurrent polls returned a PR. Delivery ended `processed` with `processingAt` cleared. One PR and one activity row with the event key existed.
* **Status: PASS** (automated worker/MongoDB integration drill).
* **Issues found:** No recovery or concurrent-claim defect found. A worker that dies after the lease expires may cause recovery to wait until the configured lease (default 60 seconds); this is expected lease behavior.
* **Code changes:** Added regression coverage in `backend/tests/phase8.integration.test.js`; the existing atomic `findOneAndUpdate` lease claim and `eventKey` activity idempotency were sufficient.

## Overall Result

* **Total tests passed:** 31 across the final applicable backend runs (30 in the suite excluding the legacy broad-cleanup test, plus that integration test run separately).
* **Total tests failed:** 0 in the final runs. One initial non-escalated MongoDB run timed out because the sandbox denied loopback access; rerunning the same suite with approved localhost access passed.
* **Total tests blocked:** 0 automated Phase 9 drills. External GitHub and deployed tunnel verification remains manual and was not counted as a passed test.
* **Remaining issues:** The real GitHub-to-Cloudflare-Tunnel path has not been tested from GitHub. Duplicate attempts are logged server-side but are not retained as separate rows in the Deliveries UI.
* **Overall Phase 9 status:** Automated failure drills pass; live external webhook verification remains outstanding.

## Reproduction

Run the Phase 9 and related backend tests against a disposable MongoDB, never a user database:

```sh
MONGODB_URI_TEST=mongodb://127.0.0.1:27030/reviewclock_phase9_test npx vitest run --exclude tests/worker.test.js
MONGODB_URI_TEST=mongodb://127.0.0.1:27030/reviewclock_phase9_test npx vitest run tests/worker.test.js
```

The integration suite is opt-in: it skips its MongoDB tests unless `MONGODB_URI_TEST` is explicitly set. `tests/worker.test.js` performs broad cleanup within its configured test database, so it is run separately against the disposable database.

## Reconnect versus webhook recovery

SSE catch-up resumes from the browser's saved activity sequence and replays `Activity` rows that already exist in MongoDB. If Express is down when GitHub sends a webhook, Cloudflare returns an origin error such as `502`; the request never reaches ReviewClock, so no `Delivery`, PR update, or activity row exists for SSE to replay. GitHub does not automatically redeliver failed webhook deliveries. After the backend and tunnel are healthy, open the repository's **Settings → Webhooks → Recent Deliveries** and use **Redeliver** on the failed request. GitHub retains deliveries for manual redelivery for three days. The redelivery keeps the original `X-GitHub-Delivery` value; the unique index safely prevents a second insert if the original request had actually reached ReviewClock.

For a browser-only SSE interruption while Express and MongoDB remain available, the frontend now closes the errored EventSource and requests a fresh single-use stream ticket. It reconnects using the last sequence successfully processed by the React handler; the server replays newer activity records from MongoDB in sequence. This avoids relying on the old one-use ticket and its cross-site cookie fallback during EventSource's built-in retry.

References: [GitHub handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries), [GitHub redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks).
