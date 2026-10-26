# Commercial AI deletion

`COMMERCIAL_LLM_ENFORCEMENT_ENABLED=true` replaces only `COMMERCIAL_AD` text-rule
verdicts in opted-in chats. The local workstation 4B model runs first. Commercial
and uncertain answers require the pinned server 9B model; unavailable primary also
falls back to that server within the original budget. Audited disagreement with a
primary negative stays KEEP. AI never bans, mutes, sends notices or increments a
sanction ladder. Commercial image OCR remains removed. Other moderation rules
retain their own authority.

## Admission and failures

The background role advertises readiness through a short Redis worker lease. A
CAS admits one source into a single expiring slot; there is no inference waiting
list, Bull queue, retry or historical replay. Admission is fire-and-forget on a
separate fail-fast Redis connection, with one in-flight admission per producer.
Busy, absent, pressured, stale, oversized, uncertain and failed work is skipped.
The workstation has an atomic two-second admission interval (at most thirty starts
per minute). Only a requested server confirmation consumes the existing shared
ten-second server lease/cooldown (at most six starts per minute). A local negative
can complete while the server is busy; a positive or uncertain result with no
server capacity is skipped immediately. Neither tier has a waiting list. The
governor and 12 GiB headroom guard remain. Actual rates can be lower; this is **partial
traffic coverage**, not a promise to classify every message. Failure leaves that
message to independent moderation rules. Previously queued SHADOW observations
never authorize deletion and the SHADOW runner stops in enforcement mode.

Inputs must be complete text of at most 2,500 characters from an exact active
canonical message source no older than ten seconds. Contacts are sanitized before
inference. The worker starts within three seconds of admission, inference has a
20-second budget, and effects expire 60 seconds after the original event clock.
No timeout renews that clock. A pending slot from a different worker generation is
discarded without inference. One successful, exact model/prompt/runtime/cascade
result creates a source-bound Redis proof with the same absolute expiry.

## Durable effects

The new `COMMERCIAL_LLM_DELETE` reason enters the existing DELETE journal only
through that proof-bound child handoff. It preserves the original webhook receipt,
receiving/execution bot and event time in `moderation_delete_reason_origins`; it
cannot revive the canonical handler or attribute another target/rule. The ordinary
holds, executor checks and unknown-effect fences remain active. Registration with
an unknown result is reported as `registration_unknown`, never retried as inference.

Every actual DELETE checks the current settings fingerprint, exact current MAX
message/text/author, regular-member access, bot/admin and participant immunity,
proof and absolute deadline. Changed content, disabled settings, missing proof,
uncertain rights and expiry reject AI authority. That rejection permits another
independently verified reason to progress. Final SQL/transport deadline fences
remain active. Exact absence is settlement, not an AI deletion or sanction.

## Delivery and rollback

Use `MAXIM_COMMERCIAL_LLM_ENFORCEMENT=true` (or `false`) on the normal exact-green
`./infra/scripts/vps-connect.sh deploy main --auto` invocation. This caller-only
switch selects all fourteen API roles even on the same SHA. Under the shared
lock and durable release journal, all webhook producers quiesce before atomic
canonical `.env` mutation and recreation. The connector verifies Compose and all
fourteen running environments. Stores are never recreated. The UI receives the
configured `DELETE_ONLY`, `OBSERVE` or `OFF` capability; this is not a live health
indicator. Unknown capability retains the existing text-rule controls.

Both API rollback paths and connector bootstrap require the new AI source/proof/
deadline guard, in addition to preceding reader floors. Disabling the flag does
not make an older reader compatible. Use a compatible fix-forward if no retained
image meets the floor. Never clear intents, proof history or other queues.

## Evidence

Real-store tests cover concurrent one-slot admission, source lineage, exact guarded
DELETE, changed text/settings/immunity, dependency failure with another reason,
late/foreign-worker results and unknown DELETE fencing. These are functional fault
checks, not model accuracy measurements. The current readiness report has **zero
independently labelled real samples**; synthetic cases and SHADOW outcomes do not
establish precision or recall. Keep that limitation explicit during rollout.

`commercial-ai-admission` schema v2 separates ineligible sources from eligible
admissions: `offered = ineligible + eligible`, and `eligible = accepted + skipped +
unavailable + inFlight`. Disabled chat settings, missing authority, empty/oversized
text, invalid/stale clocks and unsanitized contacts have separate finite reasons.
Producer saturation and absent advertised readiness are counted separately. The
old offered counter included disabled chats and cannot establish eligible coverage.

`commercial-ai` records result, cascade route, primary/secondary duration, heartbeat
and last successful classification without raw message text. Server capacity skips
are distinct from technical failures. Redis status expires after 30 seconds;
missing status is a coverage gap, not proof of healthy idleness. Record registered
intents separately from confirmed MAX DELETE outcomes.

The sequential `postgres-audit moderation-outcomes [--bot <configured-bot-id>]`
catalog reports exact `COMMERCIAL_LLM_DELETE` events as `COMMERCIAL_AI`, separately
from text rules and retained OCR history. Review its bounded plain `--explain`
first. `DELETE_REMOTE_CONFIRMED` requires a bot DELETE event with the admitted
boolean `moderationDeleteVerified: true` proof. Registration, model verdicts and
similarly named codes never become confirmed AI deletes. The existing 512-event
cap, per-bot index, metadata limits and sample-coverage caveats still apply; this
report establishes neither classifier precision nor full eligible-input coverage.
