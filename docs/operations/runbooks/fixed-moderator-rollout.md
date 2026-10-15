# Fixed moderator rollout

`Chat.fixedModeratorBotId` pins new moderation effects to one existing moderator.
An unavailable assigned bot does not promote another bot. Publisher remains independent.
The nullable field preserves legacy routing until an explicit assignment is committed.
Selection starts disabled through `MAX_FIXED_MODERATOR_SELECTION_ENABLED=false`.
`MAX_FIXED_MODERATOR_SELECTION_ENTITY_IDS` narrows enabled selection to an exact cohort;
an empty list with the global flag enabled opens selection to all eligible entities.

## Compatibility and evidence

Deploy the compatible API image to all fourteen roles before writing assignments or
enabling selection. Both API rollback paths require `assert-fixed-moderator-source.mjs`,
including final effect, original-message and settings-transaction readers. Retain the
additive schema and assignment journal during rollback. Turning selection off prevents
new user choices; it does not remove existing assignments or restore automatic takeover.

Existing poll, rules, giveaway, engagement and channel-marker edits/deletions require
the original persisted bot/message binding and that bot's current rights. SEND cleanup
requires a terminal, unambiguous successful send receipt. A fixed assignment never
authorizes replay, changes an attempted send, or clears an uncertain-effect fence.

## Preserve existing working bots

Use a clean checkout of the exact green deployed SHA. These commands share the deploy
lock, attest the current release and every API role, and require healthy database/Redis
and operational lag at most ten seconds. They run a passive CLI context in `api-admin`;
no workers, MAX calls, connection activation or public messages are started.

```bash
umask 077
: "${PRESERVATION_CHAT_ID:?Set the reviewed community ID}"
./infra/scripts/vps-connect.sh fixed-moderator-preservation explain "$PRESERVATION_CHAT_ID"
./infra/scripts/vps-connect.sh fixed-moderator-preservation preview 25 > /tmp/preserve-plan.json
# Review the private plan and the reviewed_digest emitted on stderr.
: "${PRESERVATION_REVIEWED_DIGEST:?Set the reviewed preview SHA-256}"
./infra/scripts/vps-connect.sh fixed-moderator-preservation apply /tmp/preserve-plan.json "$PRESERVATION_REVIEWED_DIGEST"
```

Plans contain community identifiers: keep them private, outside Git. The connector
requires an owned regular file with mode 0600, no symlinks/hardlinks, at most 256 KiB,
the exact source SHA and the reviewed content digest. The runtime additionally validates
the complete strict schema. Preview defaults to 25 chats, allows at most 100, and uses a
primary-key cursor (`preview 25 <nextAfter>`). It emits `scanned`, `skipped`, `exhausted`
and `nextAfter`; neither an empty eligible list nor a truncated page proves fleet coverage.

For each community the preview compares the current primary (transitional `botId` as
fallback), exact current rights and enabled duties against confirmed actions in the
last hour. Each of the five action types uses the existing
`max_action_ledger_chat_action_updated_idx`, limited to 64 receipts plus one saturation
sentinel. Missing confirmation, saturation, multiple successful executors, uncertain
effects, missing rights or excessive memberships leave legacy routing intact. Do not
widen those windows or ignore skipped reasons to claim a complete rollout. Review the
query plans and PostgreSQL regressions before the first production preview. The fixed
`explain` command runs only plain EXPLAIN for the five exact indexed probes in a read-only
transaction and emits node/index/cost scalars, without predicates, contents or identifiers.

Apply locks Chat, memberships and settings in that order and repeats eligibility.
It can only preserve the same current bot. The transaction records assignment, revision,
membership roles and `PRESERVE_MODERATOR` audit together. Operator authority is explicitly
`system:fixed-moderator-preservation`, never a fabricated human admin identity. A changed
digest or a preview older than five minutes refuses an uncommitted operation. An already
committed UUID returns its original result even after expiry. After interruption retain
the plan and results; resume the identical plan to resolve committed UUIDs, then preview
remaining uncommitted rows again. Never substitute another executor or UUID for an
unknown outcome.

The wrapper creates one absolute 75-second deadline before preflight. Preflight consumes
that budget; launch requires at least ten seconds remaining. The container checks the
same deadline before database initialization and has its own watchdog. SQL statements
and locks are limited to 1.5 seconds, idle transactions to five seconds, and transactions
to eight seconds. On failure/interruption the shell retains the deploy lock until its
95-second settlement boundary. No caller may shorten the boundary or renew the remote
deadline. Successful exit includes database-context shutdown and a fresh fleet check.

The preserved bot does not change, so no route-cache replacement is required. Final
authority and the home moderator revision are read from SQL. Metadata headers retain
their independent freshness/order; they cannot override the assignment revision.

## Open selection and accept the release

First use the designated test chat/channel, then representative approximately 1%, 10%
and larger cohorts. Include all moderator identities, unavailable-current/healthy-peer
cases, different channel permissions and old bound objects. Settings writes and moderator
assignment share the parent Chat lock, so a stale settings preflight cannot enable duties
the newly assigned bot cannot perform. User selection rechecks fresh human and exact-bot
rights and uses a revision-checked durable UUID journal.

The mini app saves that UUID before POST. A lost response is resolved through the exact
operation endpoint or the same request, never a new automatic mutation. Native storage
waits are bounded without releasing the order of unfinished writes; completed operations
retain a storage tombstone. HTTP 403, 409 and 429 keep an understandable error and the
recoverable request. Validate iPhone/Android, both themes, Back/focus, small viewports,
virtual rows and account isolation before enabling the cohort.

Follow the full acceptance matrix in
[the optimization plan](../plans/2026-10-15-multibot-home-optimization.md). Successful
deployment alone is not completion: retain per-bot functional receipts, closed webhook
cohorts, dependency/queue/error evidence, independent backup/readback/restore, isolated
3× peak tests and observation through a real peak. Finish only after all gates and a
fresh uninterrupted final 30-minute monitoring window after the last change. New errors,
observation gaps or corrective changes restart that final window.

## Isolated catalog load checks

The existing native catalog driver supports `--routing=fixed`. It assigns disposable
fixture chats across the configured bots, verifies each DELETE against that chat's
assignment and rejects non-success receipt statuses, including quarantine and cancellation.
Production preservation never uses this synthetic distribution.

```bash
node scripts/agent/with-test-stores.mjs --migrate -- npm run loadtest:multibot-catalog --workspace @maxim/api -- --chats=10000,12000,30000 --bots=6 --messages=120 --rate=6 --routing=fixed --profiles=uniform,hot,cold,media --output=/tmp/fixed-moderator-load.json
```

`--routing=legacy` retains the former single-primary fixture for comparison. Reports
include actual throughput, p95/p99 receipt/action latency, executor coverage and drain.
The hot profile uses four chats, so it exercises at most four assigned bots; other
profiles spread messages across the available assignments. The fixture has one webhook
queue and one delete queue, each with concurrency four. MAX is simulated with production
quota defaults. The media profile tests attachment ingress and text rules, excluding
native image/OCR work. Run on an otherwise idle test host for performance conclusions.
These finite profiles verify effect invariants; passing them does not establish latency
targets, three times measured production peak, production topology capacity, or daily
acceptance. Assess offered load against per-chat, per-bot and method quotas separately.

`postgres-audit webhook-cohort` schema v4 reports p95 and p99 for the same bounded
closed window. Only valid PROCESSED clocks enter completion latency; cancelled,
duplicate, held and quarantined receipts remain separate. A truncated or empty cohort
cannot prove the latency target, and receipt completion does not prove a MAX effect.
