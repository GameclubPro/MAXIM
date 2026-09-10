# Message Duplicate Rollout

## Scope

Message-v1 extends duplicate checks to nonempty short text, visible forwards and attachment
captions. Existing high-signal text sanctions and the separate photo policy remain unchanged.
New coverage is delete-only, per author and chat. Missing, expired or invalid runtime authority
cannot authorize a new delete. Do not enable fleet-wide enforcement as a smoke test.

`duplicateCompareMode=MESSAGE` compares text, navigation/actions and independently verified
media content. `TEXT` compares text/captions and navigation/actions without media. Known media
without a retrievable original remain unverified in MESSAGE mode; filenames, sizes, previews,
platform IDs and download URLs are not equality evidence. Unsupported attachments and split
albums are skipped when the whole message cannot be verified. Complete attachment arrays are
one logical occurrence. Photo-dependent enforcement additionally requires the existing photo
runtime control to permit canonical hashes; this rollout does not widen photo authority.

## Validation And Delivery

Run the impact planner, API/contracts/Prisma/miniapp/admin checks and infra checks. Run the
`message-duplicate` specs with `MAXIM_TEST_REDIS_URL` pointing only to disposable local Redis.
Verify the settings screen on mobile, including the OFF, OBSERVE and DELETE_ONLY status.
Deploy the exact green SHA to every shared API role and the affected static components.

The `message-duplicates` BullMQ worker runs in `api-moderation-background`, concurrency two.
Jobs carry durable receipt references, not message text or media URLs. First media candidates
do not download; potential repeats trigger bounded verification. Ordering/source/pressure
deferrals expire after ten minutes. Failed source handling must retry rather than acknowledge
unfinished history work. Monitor queue backlog and failures through the read-only monitor.

## Canary Control

Run the built operator inside the exact released `api-admin` container through the normal VPS
wrapper. All writes are previews without `--apply`. Inspect `get`, review the explicit CHAT
target through normal managed discovery, then repeat the reviewed command with `--apply`.
Only the designated test chat is a default live smoke target. Preserve administrator immunity;
an administrator's messages cannot prove participant enforcement.

```sh
node apps/api/dist/apps/api/src/scripts/message-duplicate-runtime-control.js get
node apps/api/dist/apps/api/src/scripts/message-duplicate-runtime-control.js set --expected-revision 0 --chat-id=-123 --mode delete_only --ttl-hours 24
node apps/api/dist/apps/api/src/scripts/message-duplicate-runtime-control.js off --expected-revision 1
```

Replace example IDs/revisions with reviewed values. Maximum lifetime is 24 hours, with at most
1000 unique explicit chat IDs. Every update advances a permanent CAS revision, including OFF;
expiry does not reset it. A new control establishes a new effective time and invalidates old
pending bindings. No old occurrence is retrospectively deleted. Renewals require a fresh review.
Status output omits chat IDs and message contents. Do not change unrelated chat or photo settings.

## Stop And Rollback

Use `off --expected-revision <current>`, preview then apply. Final dispatch rechecks control,
settings, author immunity, current MAX contents and read-only history; a queued intent is not
permanent authority. `MESSAGE_DUPLICATE_ENABLED=false` is an additional environment ceiling.

Both API rollback paths require the message-v1 delete guard source capability. Pending intents
can survive a control downgrade, so an older unguarded API is not a valid rollback target.
Use a retained compatible immutable release and the normal queue-fenced rollback workflow.
Never remove the shared message action claims or reset counters to replay moderation.
