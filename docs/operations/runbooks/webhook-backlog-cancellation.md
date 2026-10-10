# Cancel expired webhook backlog

Use this operation when the operator explicitly elects to abandon old processing rather than
finish uncertain actions. It uses one fixed receipt cutoff and one stopped-fleet window.
It preserves connected entities, settings, statistics, publications, execution claims, action
receipts, original webhook bodies and error evidence. Cancellation does not mean successful
processing or proof that a remote action never happened.

The shared API release must include `WebhookStatus.CANCELLED`, the cancellation migration and
the mandatory source/child readers. Deploy all fourteen roles and both native auxiliaries first.
Both rollback paths enforce the reader floor after this release. Never clear Redis wholesale.

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

The client walks at most 500,000 pre-cutoff receipts through 200-row indexed pages, preserving
raw page bounds before eligibility filtering. It cancels RECEIVED/QUEUED receipts and retrying
or pending-timeout FAILED receipts. Existing legacy/source dispositions remain untouched.
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

`COMPLETE` means cancellation and restart finished, not that latency is healthy. Record the
operation ID, cutoff, exact source/image, projected/removed counts and retained locked jobs.
Then sample fresh ingress windows including still-pending receipts, oldest fresh age, SQL
selection/preparation waits and execution outcomes. Finalize an interrupted release only after
the existing strict smokes pass. New backlog requires diagnosis; do not repeatedly move the
cutoff to hide a runtime fault.

Local validation uses real isolated stores:

```bash
node scripts/agent/with-test-stores.mjs --migrate -- npm test --workspace @maxim/api -- webhook-backlog-cancellation-postgres
node --test infra/scripts/backlog-cancellation.test.mjs
```
