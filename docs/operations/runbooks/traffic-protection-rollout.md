# Traffic Protection Rollout

## Scope

Chat-only, explicit opt-in settings in the existing Limits section:

- `slowModeEnabled`, `slowModeIntervalSeconds`: one send per user per interval.
- `mediaMessageCooldownEnabled`, `mediaMessageCooldownSeconds`: a shared interval
  across photos, stickers, videos, files and voice messages.
- `stickerMessagesEnabled`: explicit permission to send stickers, true by default.

Intervals are integral seconds, 10 through 86400. Both interval policies are off
by default. They and sticker blocking only delete messages; they do not add strikes,
warn, mute, ban or contribute to global reputation. The separate existing
`antiSpamEnabled` burst-ban behavior remains unchanged.

Rules are evaluated after existing actionable content rules. A commercial
review-only candidate does not exempt a message from traffic limits. Existing
hourly quotas and photo/sticker cooldowns retain their contracts.

## State And Safety

The migration adds backward-compatible columns and one static revision trigger.
It does not delete data or replace existing columns. The migration-policy approval
records the parser's conservative `EXECUTE FUNCTION` false positive explicitly.

The database owns `trafficPolicyRevision` and `trafficPolicyEffectiveAt`. Changes
to the five settings increment the revision and start a new activation baseline;
unrelated saves do not. Old clients preserve omitted fields. Apply-all transports
copy settings, never another chat's revision or event counters.

Redis claims use chat, author, rule and policy revision, with event-time anchors
and stable decision replay. Edits do not consume a send. A direct MAX media-group
identity shares the decision across parts within two seconds of its first observed
part; ambiguous batches without a stable identity are not charged. Reusing a group
outside that bounded span does not produce a new punitive decision from old state.
Rejected attempts never extend the interval. Unknown state does not authorize deletion.

Only the durable delete executor can enforce these rules, including when the base
legacy delete rollout is off. At dispatch, traffic-only intents recheck the exact
message, sender, current admin access/immunity, source fingerprint, settings revision
and deadline. Source-changing edits invalidate pending deletion. Decisions expire
after the lesser of their interval and five minutes; blocking stickers uses five minutes.
Independent non-traffic reasons keep their own guards.

There is no pre-send interception: a message can appear briefly before the bot
removes it. No new native MAX slow-mode endpoint or ability to restore the original
deleted message is assumed.

## Validation

Use only isolated local Redis/Postgres for the opt-in integration suites:

```bash
MAXIM_TEST_REDIS_URL=redis://127.0.0.1:26379 \
MAXIM_TEST_POSTGRES_URL=postgresql://postgres:traffic-test-only@127.0.0.1:25432/traffic_test \
npm test --workspace @maxim/api -- traffic-protection
```

The database suite creates its own schema inside a transaction and rolls it back.
Redis cleanup removes only keys bearing the suite's random chat identity.
Also run contracts, API, Prisma, mini app, admin and infra checks because this
release changes shared contracts and the shared API image.

## Deployment And Activation

Deploy the green exact-SHA image through the normal wrapper, recreating every API
role under the queue fence, plus mini app and admin contract consumers. Migration
precedes the new API clients. Postgres/Redis must not be recreated.

Do not enable policies fleet-wide. After runtime convergence and healthy strict
smokes, verify only in the designated test chat with agent-created content and
authorised test users. Start with a 30-second interval and no existing burst-ban
test traffic. Verify creation, edit, replay, media group, setting disable and final
MAX confirmation independently. Restore the test chat's original settings.

## Rollback

Disable the affected policy in the current chat to revoke pending traffic-only
deletions; the revision guard also prevents off/on resurrection. Cached producers
can briefly observe the old revision, but dispatch cannot enforce it.

Both runtime and immutable rollbacks require the traffic pre-dispatch guard source
floor. Never roll back to a pre-guard executor that could consume pending traffic
intents without checking their settings. Use a retained guard-compatible release;
do not lower the floor to bypass this requirement.

This release does not activate learned semantic models, Commercial OCR, QR/ASR/video
analysis, automatic raids, or blanket new-participant sanctions. Those remain
separate gated deliveries from the antispam roadmap.
