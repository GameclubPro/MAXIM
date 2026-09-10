# Message Duplicate Rollout

## Scope

Message-v1 extends duplicate checks to nonempty short text, visible forwards and attachment
captions. Full mode owns message matching instead of the legacy admission filter and applies
the chat's configured explanation/WARN/MUTE/BAN ladder, per author and chat. Disabled reactions,
mute duration, allowed repeats and comparison windows are preserved. Missing, expired or invalid
runtime authority cannot authorize new actions. Fleet-wide rollout is an explicit product
operation, never a smoke test; live test mutations remain limited to the designated test entities.

Strict message-duplicate bindings use their own guarded delete-intent execution path, independent
of `MODERATION_DELETE_INTENT_MODE` and its legacy canary IDs. Admission, persisted recovery and
final dispatch must agree on this distinction. Do not widen the base delete rollout to enable
message duplicates: that would also promote unrelated historical moderation work.

`duplicateCompareMode=MESSAGE` compares text, navigation/actions and independently verified
media content. `TEXT` compares text/captions and navigation/actions without media. Known media
without a retrievable original remain unverified in MESSAGE mode; filenames, sizes, previews,
platform IDs and download URLs are not equality evidence. Unsupported attachments and split
albums are skipped when the whole message cannot be verified. Complete attachment arrays are
one logical occurrence. Full mode v2 bindings authorize verified whole-message media, including
canonical photo hashes. This does not promote the separate perceptual/photo-only filter or its
cross-author scope. When that separate filter is enforcing a photo create, it owns the action;
otherwise verified whole-message comparison may act. Legacy v1 delete-only bindings retain the
photo runtime ceiling. Never infer equality from media IDs or bypass content verification.

## Validation And Delivery

Run the impact planner, API/contracts/Prisma/miniapp/admin checks and infra checks. Run the
`message-duplicate` specs with `MAXIM_TEST_REDIS_URL` pointing only to disposable local Redis.
Verify the settings screen on mobile, including OFF, OBSERVE, DELETE_ONLY and FULL status.
Deploy the exact green SHA to every shared API role and the affected static components.

The `message-duplicates` BullMQ worker runs in `api-moderation-background`, concurrency two.
Jobs carry durable receipt references, not message text or media URLs. First media candidates
do not download; potential repeats trigger bounded verification. Ordering/source/pressure
deferrals expire after ten minutes. Failed source handling must retry rather than acknowledge
unfinished history work. Monitor queue backlog and failures through the read-only monitor.

## Runtime Control

Run the built operator inside the exact released `api-admin` container through the normal VPS
wrapper. All writes are previews without `--apply`. Inspect `get`, review the explicit CHAT
target through normal managed discovery, then repeat the reviewed command with `--apply`.
Only the designated test chat is a default live smoke target. Preserve administrator immunity;
an administrator's messages cannot prove participant enforcement.

```sh
node apps/api/dist/apps/api/src/scripts/message-duplicate-runtime-control.js get
node apps/api/dist/apps/api/src/scripts/message-duplicate-runtime-control.js set --expected-revision 0 --chat-id=-123 --mode delete_only --ttl-hours 24
node apps/api/dist/apps/api/src/scripts/message-duplicate-runtime-control.js set --expected-revision 1 --all-enabled-chats --mode full --permanent
node apps/api/dist/apps/api/src/scripts/message-duplicate-runtime-control.js off --expected-revision 2
```

Replace example IDs/revisions with reviewed values. V2 accepts either a bounded lifetime of at
most 24 hours or explicit `--permanent`. Scope is either at most 1000 unique IDs or
`--all-enabled-chats`; global scope requires no fleet enumeration or settings writes. Per-chat
`antiDuplicateEnabled` remains mandatory. Every update, including permanent OFF, advances the
CAS revision. New revisions/settings use separate fingerprint membership sets, so shadow or
pre-activation history cannot retrospectively escalate sanctions. Status output omits chat IDs
and message contents. Do not change unrelated chat or photo settings.

## Stop And Rollback

Use `off --expected-revision <current>`, preview then apply. Final dispatch rechecks control,
settings, author immunity, current MAX contents and read-only history; a queued intent is not
permanent authority. Full sanctions recheck inside the existing participant sanction lock and
before the actual WARN/MUTE/BAN mutation, with terminal event/ledger idempotency. Absence alone
is not authority: a removed message requires this exact successfully dispatched delete intent
and its matching content/revision binding. `MESSAGE_DUPLICATE_ENABLED=false` is an additional
environment ceiling.

Both API rollback paths require the message-v1 delete guard source capability. Pending intents
can survive a control downgrade, so an older unguarded API is not a valid rollback target.
Use a retained compatible immutable release and the normal queue-fenced rollback workflow.
Older v1-only images fail closed on v2 controls/bindings; rollback does not silently downgrade
full sanctions into unguarded deletes. Inspect runtime status after rollback before re-enabling.
Never remove the shared message action claims or reset counters to replay moderation.
