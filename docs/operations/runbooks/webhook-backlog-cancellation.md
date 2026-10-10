# Cancel expired webhook backlog

Use this operation when the operator explicitly elects to abandon old processing rather than
finish uncertain actions. It uses one fixed receipt cutoff and one stopped-fleet window.
It preserves connected entities, settings, statistics, publications, execution claims, action
receipts, original webhook bodies and error evidence. Cancellation does not mean successful
processing or proof that a remote action never happened.

The shared API release must include `WebhookStatus.CANCELLED`, the cancellation migration and
the mandatory source/child readers. Deploy all fourteen roles and both native auxiliaries first.
Both rollback paths enforce the reader floor after this release. Never clear Redis wholesale.

Before changing this protocol, read the [latency prevention checklist and regression matrix](webhook-latency-prevention.md).
The [10 October review](../incidents/2026-10-10-webhook-latency-recovery.md) records the terminal-
history scan, JSONB snapshot incompatibility and restart-inventory race. Missing Docker objects
require re-attestation through the identical request; do not infer that an unknown object was
owned or change the journal to pass. Historical direct-host emergency exceptions do not waive
the normal connector's exact-SHA CI gate.

Create a private mode-0600 JSON request with these four fields:

```json
{
  "id": "<new UUID v4>",
  "cutoff": "<fixed UTC ISO timestamp before now>",
  "sourceSha": "<full installed shared API SHA>",
  "imageId": "sha256:<installed shared API image ID>"
}
```

Run `./infra/scripts/vps-connect.sh cancel-webhook-backlog /absolute/private/request.json`.
The connector requires exact green CI and the host requires clean matching source. The host
holds the persistent deploy lock, captures the exact fleet generations, stops them once, and
executes a bounded client with only database/Redis credentials. Static sites and stores stay up.

The client walks at most 500,000 receipts through 200-row indexed pages, preserving raw page
bounds before cutoff and eligibility filtering. It cancels pre-cutoff RECEIVED/QUEUED receipts
and retrying or pending-timeout FAILED message ordering heads. The latter use the existing
ordered-head partial index, including NULL chat keys, so terminal FAILED history is not scanned.
Historical nonmessage FAILED receipts are outside this selection. Existing legacy/source dispositions remain untouched.
Permanent exact semantic/message tombstones also stop late copies; they do not grant immunity
to an author or an entire chat. Claims remain immutable, including ambiguous action evidence.

The client captures exact action job exclusions, seals the operation, projects `CANCELLED`
without changing other receipt fields, and removes only selected webhook/action jobs through
BullMQ. Future schedules, publication actions and unattributed delayed cleanup remain intact.
Related source actions are denied at the final transport boundary even if their Redis job is
reintroduced. A still-locked job is retained and reported; its cancelled receipt/child guard
prevents execution after restart. Other moderation continuation queues retain their existing
exact-source guards. This is not a queue namespace reset.

The durable host journal is `/var/lib/maxim-deploy/backlog-cancellation.json`. Failure retains
the journal and stopped fleet; repeat the **same request** to resume. Never edit or delete the
journal, delete claim evidence, or advance the cutoff during recovery. A lost connection may
leave the single labelled helper; resume stops/removes only that exact helper before retrying.
SQL projection and job removal are idempotent. The host restarts only the captured generations.

A separately authorized new cancellation can start after `COMPLETE`: the host preserves the exact
completed journal in a content-addressed mode-0600 archive, then captures fresh runtime generations.
It never reuses an operation ID with a different cutoff or replaces an unfinished journal. Diagnose
and correct newly accumulating failures before a later cancellation; it is not a recurring drain.
The normal client also stores BullMQ snapshots in the lossless Base64 envelope described below.

If the initial `7f16c5f2` runtime exhausts its scan budget on terminal FAILED history, use
`python3 infra/scripts/resume-backlog-pending.py <same-private-request.json>` from the committed
compatible controller. It retains the cutoff, installed image, original snapshots and captured
fleet. Its additional selection walks the existing ordered-head partial index in 200-row pages,
including NULL chat keys, with a 100,000-row bound and a plain plan check. This completes the
already captured backlog plus every pre-cutoff pending message ordering head. Historical
nonmessage failures outside the captured set are not scanned or claimed as cancelled.
The controller may differ only in its five finite tooling/test/document paths. It retains its
source receipt and helper hash, mounts only that helper read-only into the original isolated
image, and uses the same deploy lock and journal. Green exact controller CI is required unless
the existing explicit emergency bypass and nonempty recorded reason are supplied. Never use
the continuation to change runtime code or the frozen request.
Redis job snapshots use an explicit `BULLMQ_JOB_JSON_UTF8_BASE64_V1` envelope when written by
the continuation, preserving the exact serialized JSON even when PostgreSQL rejects a string
in the original job metadata. A reviewed helper correction requires the exact last helper
digest in `MAXIM_BACKLOG_PENDING_PREVIOUS_SHA256`; the journal retains the initial digest and
every subsequent revision rather than replacing the previous evidence.

`COMPLETE` means cancellation and restart finished, not that latency is healthy. Record the
operation ID, cutoff, exact source/image, projected/removed counts and retained locked jobs.
Then sample fresh ingress windows including still-pending receipts, oldest fresh age, SQL
selection/preparation waits and execution outcomes. Finalize an interrupted release only after
the existing strict smokes pass. New backlog requires diagnosis; do not repeatedly move the
cutoff to hide a runtime fault.

Receipt-created measurement windows must have ended before observation. Include all statuses,
pending ages, cap/truncation and excluded-clock counts alongside completed-only percentiles;
an empty or future cohort proves nothing. Apply the sustained acceptance window in
[bot recovery](bot-reliability-recovery.md#capacity-and-acceptance) after fresh progress returns.

Local validation uses real isolated stores:

```bash
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- webhook-backlog-cancellation-postgres
node --test infra/scripts/backlog-cancellation.test.mjs
```
