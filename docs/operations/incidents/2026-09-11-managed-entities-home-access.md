# Managed Entities Disappearing From Home

## Evidence And Scope

Reported surface: chat and channel lists in both moderation bots and Publik.
Code inspection identified reproducible failure paths, not a proven attribution of
every individual complaint. The initial bounded production health check was healthy;
Publisher logs included `PUBLISHER_ACTOR_ACCESS_REQUIRED` delivery deferrals.
No production user data was manually changed during diagnosis.

## Findings

1. Moderation roster cleanup and user-access pruning updated access edges without
   a bot scope. A moderation bot losing access could overwrite the independent
   Publisher grant. Conversely, a newer Publisher `USER_DENIED` edge could hide a
   valid moderation grant in the strict home filter.
2. MAX admin pagination returned partial results on repeated markers or page-cap
   exhaustion. Malformed membership payloads became empty arrays. Roster consumers
   interpret absence as revocation, so transport uncertainty became persisted denial.
3. Grants expire after three days. Moderation repairs missing edges after filtering
   them out; Publisher home did not request user-access renewal. Its global scheduler
   can lag or pause, and the cabinet did not observe background recovery after its
   first response.
4. Strict access and membership DB failures became successful empty filter results,
   allowing an incomplete read to replace a previously valid published snapshot.
5. Publisher refresh actions reset query data, temporarily removing loaded rows.
6. Publisher user-access persistence fenced the bot binding and candidate version,
   but not a newer access-edge timestamp. A delayed user verdict could overwrite a
   newer grant or a membership reset while retaining the same candidate version.
7. Post-release read-only monitoring exposed a direct production failure: missing
   poll-message verification used the generic chat `lookup` operation. Bare HTTP 404
   therefore removed bot memberships and marked chat-wide access edges denied. Three
   observed operations affected 147 edges in total. Giveaway result verification had
   the same classification mistake. Message presence uncertainty must not be promoted
   to parent-chat absence.

## Implementation Plan And Status

- Implemented: constrain moderation access pruning and roster cleanup to moderation
  bot IDs; ignore foreign profile verdicts in moderation home filtering. Actual
  membership lifecycle events retain their shared identity invalidation behavior.
- Implemented: reject malformed member payloads and incomplete admin pagination;
  reuse the existing member identity parser for nested admin identities. Failed
  reads are not cached as empty rosters.
- Implemented: user-scoped access renewal, twelve hours before expiry, at most 25
  edges per pass, with in-flight coalescing, cooldown, bounded scope memory, and
  existing worker queues. CHAT and CHANNEL renewal remain independent for moderation.
  Publisher uses only its exact bot and binding, including disabled publication
  policies. Known historical cross-profile denials request MAX verification only.
- Implemented: strict DB filter failures remain unavailable errors, not empty
  authoritative results.
- Implemented: Publisher user verdicts recheck the exact access-edge timestamp under
  the existing parent chat lock before persistence, preserving newer grants and denials.
- Implemented: Publisher home observes recovery for a bounded 22.5-second window;
  leaving/hiding the WebView cancels it. Refresh preserves loaded query data.
- Follow-up implemented after monitoring: add `message_lookup` classification for
  poll/giveaway message verification. Bare 403/404 performs no chat-access mutation;
  explicit chat-level errors still revoke access. User-scoped renewal also rechecks
  the two historical ambiguous-message denial sources without requiring the membership
  that the old classifier removed. MAX must confirm access before any grant.
- Release gates: complete regression checks, exact-SHA CI, scoped API/miniapp
  deployment, and post-deploy health/static smokes.

## Regression Coverage

Focused tests cover cross-profile denial isolation, genuine moderation revocation,
epoch-fenced pruning, preservation of published snapshots on DB failure, malformed
and looping MAX responses, nested administrator identities, renewal queue scope and
coalescing, newer Publisher verdicts, and bounded/cancelled frontend observation.
Native iPhone/light and Android/dark captures cover Publisher chats, channels, empty
state, and read-error state. Production bundle budgets are unchanged.

## Safety And Recovery

Expired grants never authorize an entity. No TTL extension, allowlist-to-grant copy,
cross-profile token fallback, full bot-chat scan, or direct database backfill is used.
Normal workers must confirm both user and bot access and retain their lifecycle/CAS
fences. Genuine revocations remain hidden. Redis/Postgres are not recreated.

Automatic recovery covers expired grants and Publisher edges with the two known
moderation cleanup sources. Other confirmed denials still require the existing
explicit recheck or handshake. A long-running MAX outage can still prevent access
verification; retaining expired privileges is not an acceptable recovery strategy.
