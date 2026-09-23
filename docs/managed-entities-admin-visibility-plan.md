# Managed Entity Administrator Visibility

## Scope And Evidence

This follow-up covers home visibility for moderation bots and Publik, for both chats
and channels. Findings are reproducible code paths, not attribution of every missing
production entity. No production rows are repaired manually.

1. Publisher binding refresh verified only the handshake/bot-added actor. Other MAX
   administrators had no Publisher edge and could never enter its home catalog.
2. User-scoped renewal selected grants and two historical corruption sources, but
   not ordinary expired denials. Re-promoted admins and recovered permissions could
   remain invisible. Publisher global denied recovery also has a 30-day evidence window.
3. Renewal repeatedly selected the first 25 stale edges. Pending/failed remote work
   at the front could starve the rest of a user's catalog.
4. Moderation discovery could replace a delayed bot-added job with weaker retry
   settings. Prioritized jobs were not replaceable, and an active pre-event probe
   silently absorbed a new bot-added request.
5. Moderation roster CAS protection consulted newer Publisher edges. Independent
   Publisher activity could suppress a valid moderation grant or cache revocation.
6. Publisher member-endpoint 403/404 responses became persisted user denials without
   confirming absence from the administrator roster of the same bot.
7. Ordinary Publisher messages advance webhook ordering. Treating that timestamp
   as a permissions reset discarded valid in-flight access checks in busy chats.

## Implementation

- Implemented: exact-Publisher admin roster synchronization after binding bootstrap,
  periodic refresh, bot-added/handshake observation and manual recheck. It uses one
  paginated roster read, not one remote call per administrator. Ordinary per-user
  renewal stays targeted. Disabled publication policies do not block discovery.
- Implemented: preserve tri-state bot identity in the MAX authorization roster API.
  Only explicit human admins/owners receive new grants. An untyped listed admin is
  not evidence of absence; malformed/incomplete responses do not revoke anyone.
- Implemented: parent-chat lock, exact binding probe/lifecycle fencing, per-user
  checked-at guards and membership-event checks before roster persistence. Existing
  candidate versions survive updates; bulk inserts use 250-row batches. Absent admins
  lose only their exact Publisher grant, never Major grants or memberships.
- Implemented: home-triggered verification of expired denials after a 15-minute
  minimum age. Moderation requires an active local membership, Publisher its own
  evidenced active binding. Existing historical recovery exceptions remain narrow.
- Implemented: user/profile/entity-type-scoped 25-edge keyset rotation, 30-second
  cooldown, five-minute idle cursor retention, 1,000-scope memory cap and in-flight
  coalescing. End of scan wraps on the next pass.
- Implemented: retain bot-added retry windows when merging queued moderation work;
  include prioritized jobs. Active collisions use BullMQ's bounded deduplicated
  follow-up with keep-last-while-active behavior.
- Implemented: moderation roster protection reads only moderation-bot edges.
- Implemented: member-endpoint 403/404 falls back to the exact Publisher admin
  roster after confirmed bot admin access. A failed fallback remains retryable and
  leaves the user's prior verdict intact; confirmed absence still denies access.
- Implemented: known passive webhook observations do not supersede access probes.
  Bot-added stores its reset event time in the existing access timestamp, so later
  traffic cannot erase that fence. Exact bot snapshots, terminal lifecycle changes,
  unknown event types and per-user membership resets remain protected.

## Verification And Release

- Focused tests cover other-admin installation, CHAT/CHANNEL, disabled publishing,
  explicit human identity, partial MAX responses, newer lifecycle/user state,
  targeted renewal, expired-denial recovery, rotation and queue collisions.
- Native PostgreSQL regressions are part of `chat-routing-postgres-races.spec.ts`,
  already selected by `npm run test:postgres-races --workspace @maxim/api` and CI.
- Run API validation, contract checks, refactor guards and existing mini app home
  tests; no UI contract, schema migration or static asset change is required.
- Stage only owned files, submit through the repository wrapper, require exact-SHA
  Required/CodeQL success and deploy the shared API image to all roles.
- Check ingress/admin live/ready and the canonical public API/app after deployment.

## Bounds And Remaining Limitations

Discovery never copies Major authorization into Publik, extends expired grants,
scans remote bot-wide chat lists on home requests, or treats transport failure as
successful empty data. Redis/Postgres are not recreated and dispatch-off remains off.

Publisher roster recovery rides the existing bounded binding scheduler: healthy
bindings are due about ten minutes after the last successful probe, subject to queue
and MAX backoff. Explicit connection/recheck events can run sooner. A missed webhook
with no local binding/catalog evidence still requires the supported handshake or
forwarded recovery. A long MAX outage cannot safely be hidden by retaining privileges.
