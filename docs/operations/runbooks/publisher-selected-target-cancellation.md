# Cancel scheduled Publik recipients in explicitly selected groups

Use this operator procedure only for an explicit human request naming the exact MAX invite links.
It stops existing `PUBLIK_V1` recipients without impersonating the blocked author or inventing
administrator grants. Normal mini app cancellation remains the routine administrator path.

## Scope and evidence

`infra/scripts/vps-publisher-cancel-selected-targets.sh` accepts `preview`, `apply`, and `verify`.
Use a clean reviewed tooling checkout, successful exact-SHA `Required` and
`Analyze JavaScript and TypeScript`, and `MAXIM_EXPECTED_DEPLOY_SHA` equal to that tooling SHA.
No API image rebuild or fleet restart is required when the active image already contains the
target-cancellation readers. Keep the operational tooling checkout unchanged until completion.

Prepare a private regular JSON file, owned by the operator, mode `0600`, one hard link, outside
Git. Version 1 has this shape (replace every example value with the authorized scope):

```json
{
  "version": 1,
  "operationId": "b230af67-7191-4e78-92aa-d079207cf174",
  "expectedRuntimeSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "cutoff": "2026-10-29T06:00:00.000Z",
  "reason": "Human request to stop scheduled Publik posts in the listed groups",
  "targets": [
    {
      "name": "Requested group",
      "link": "https://max.ru/join/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

Keep one UUID, cutoff, request and reviewed preview through the operation. The cutoff limits parent
creation, not the future send time. Publications created after the cutoff are outside this request.
The target count is 1–14; only exact HTTPS `max.ru/join/` links are accepted. Titles are display
metadata, never identity evidence. Missing/ambiguous links or a cap reached fail closed.

## Execution

Run through `vps-connect.sh exec` on REG.RU. Synchronize the reviewed tooling with the supported
release workflow or use an isolated clean Git worktree at the reviewed SHA with the production
`.env` available to Compose; preserve the active production checkout and manifest. Check that no
other wrapper owns that tooling checkout. Do not update source underneath an active process.
The following commands run **on the host** from that reviewed tooling root:

```bash
umask 077
export MAXIM_EXPECTED_DEPLOY_SHA="$(git rev-parse HEAD)"
bash infra/scripts/vps-publisher-cancel-selected-targets.sh preview /private/request.json > /private/preview.json
bash infra/scripts/vps-publisher-cancel-selected-targets.sh apply /private/request.json /private/preview.json > /private/applied.json
bash infra/scripts/vps-publisher-cancel-selected-targets.sh verify /private/request.json /private/preview.json > /private/verified.json
```

Review the complete preview before applying: all exact links and negative group IDs, publication
versions, saved recipient IDs, helper digest, and unchanged runtime binding. The preview expires
after 15 minutes for apply. Explicit cancellation authorization already covering that exact scope
does not need a second approval. New scope or destructive actions require their own authorization.

The host wrapper owns the persistent protected deploy lock. Apply additionally requires ordinary
effect authority from the cold journal. It attests the complete component manifest, exact API image
revision, all 14 API roles and both native auxiliaries, Publisher identity and admin health before
and after execution. An image, restart, source or generation change refuses acceptance.
No MAX calls or group messages are made.

## Bounded database operation

One database connection runs inside the existing `api-publisher` image without starting Nest or a
worker. Queries use 1.5-second statement, 0.5-second lock, 5-second idle, 4 MiB work memory and UTC
session budgets. Preview/apply have a 30-second wall deadline and the host child a 45-second limit.
Indexes must be present, valid, ready and unfiltered.

Preview walks catalog primary-key pages of 1,000 plus a sentinel, at most 50,000 rows. Exact links
are compared only after the bounded page. Duplicate bot catalog entries for the same group merge;
different group IDs for one link refuse. Per-group target history is capped at 500 plus a sentinel.
Parent IDs are read by primary key; only the exact Publisher bot, `PUBLIK_V1`, `ACTIVE`/`PAUSED`/
`ERROR` parents created by the cutoff qualify. At most 250 parents and 10,000 saved recipients per
parent are accepted. The preview contains metadata only, no publication content or credentials.

Apply serializes with `publication-calendar`, locks and rechecks exact catalog witnesses and
parent versions, and marks only the reviewed group targets `canceled_at`. It increments the parent
version; only a parent with no remaining uncanceled recipients and its schedule become `CANCELED`.
Every selected marker is verified before the single transaction commits. Mutation records and
per-group audit records identify `operator:publisher-selected-target-cancellation`, the UUID,
preview digest, cutoff and explicit reason. Exact-preview replay is idempotent.

## Preservation and acceptance

The deployed materialization and final-SEND readers enforce the target marker. Other recipients,
drafts, completed publications, legacy routing and other bot scopes survive. This stop-only
operation leaves deliveries, attempts, leases, receipts, calendar reservations, queues and MAX
messages untouched. In particular, retained reservations may still occupy slots; freeing them is
a separate operation requiring the normal uncertainty checks. An already admitted HTTP send cannot
be recalled by this command.

Fresh `verify` reads every reviewed target by primary key and checks the committed mutation digest.
It permits an expired preview for readback, never for a new apply. Preserve private request,
preview, outcome, readback, timestamps, source/image identity and logs outside Git. Report counts
as saved recipients/publications stopped, not deleted MAX messages or a count of recurring sends.
Zero counts and unresolved IDs must remain explicit.

On timeout or connection loss do not generate a new operation or replay sends. Keep the exact UUID
and preview; run bounded `verify` first to distinguish committed markers from an unknown result.
Investigate a changed runtime or missing readback. Do not clear Redis, bypass locks, alter bot
assignments, grant author access or infer success from an HTTP health response.

Native regression coverage is `infra/scripts/publisher-cancel-selected-targets.native.test.mjs`,
run against disposable migrated PostgreSQL via `scripts/agent/with-test-stores.mjs --migrate` and in
the CI compatibility lane. Unit coverage checks request/preview binding and private input files.
