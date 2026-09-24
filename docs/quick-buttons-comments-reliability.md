# Quick Buttons and Comment Counter Reliability

## Evidence and Scope

The supplied screenshot contains both `ПОДПИСАТЬСЯ =` followed by a URL on the
next line and `ПОДПИСАТЬСЯ=https://max.ru/channel_sibhealth`. It does not identify
the message ID, saved channel settings, bot access, or the expected comment count.
The number beside the eye is a view count. Native MAX comments and signed
mini-app comment threads are separate systems; this release does not synchronize
or merge them.

The findings below are repository reproductions, not a claim that every symptom
in that customer channel has been remotely reproduced. No customer post is
rewritten, deleted, or republished by this investigation.

## Findings and Implemented Plan

1. **Multiline quick buttons were not parsed.** Accept one immediate line break
   after `=`, including CRLF and nonbreaking spaces, as well as straight and mobile
   typographic quotes. Keep ordinary URLs, invalid destinations, blank-line
   continuations and oversized keyboards untouched. Preserve native UTF-16 markup.
2. **Repeated templates produced repeated buttons.** Deduplicate the exact
   normalized `(label, URL)` pair within the post while consuming each valid
   template. Different labels or destinations remain distinct actions.
3. **Literal examples and hidden links were treated as instructions.** Leave
   monospaced examples and templates containing a conflicting native link target
   unchanged. Continue to use the shared credential-free HTTP(S) URL policy and
   reject reserved profile-handoff payloads.
4. **Concurrent keyboard installation blocked quick-button edits.** The webhook
   snapshot could have no keyboard while the locked MAX snapshot already had one.
   Compare media attachment types separately from keyboards, then enforce complete
   preservation of the live attachments and buttons. Text, markup, missing media,
   overflow and unconfirmed MAX responses still fail closed.
5. **A count was incorrectly used as a queue revision.** Retained Publisher jobs
   made `1 -> 2 -> 1` or repeated failed values collide for up to a day. Each refresh
   now has a distinct job identity. Retries of that job keep their normal bounded
   retry policy, while equal live labels produce no remote write.
6. **Counts were sampled before the message edit lock.** Both Major and Publisher
   now read the database count inside the shared renewable message lock, after
   loading the current MAX message. Older concurrent requests cannot restore their
   pre-lock snapshots. A failed count never becomes a synthetic zero.
7. **Counter edits reconstructed old keyboards.** Refresh only the exact currently
   installed target, at its existing position, preserving its URL and all other
   buttons, media and message text. Missing targets and other discussions are
   no-ops. Full attachment preservation and affirmative MAX success are required.
8. **Disabling new chat buttons also disabled existing Publisher counters.**
   Counter execution uses the existing-thread `publication` readiness boundary,
   including for jobs queued by older code. Exact bot, entity, runtime, policy and
   access checks remain; creation jobs still use the creation switches.
9. **The mini app presented a capped list length as the total.** Read at most 81
   rows, return the latest 80, and expose optional `hasMoreMessages`. A truncated
   history shows `80+`, not an asserted total of 80. Exactly 80 rows remain `80`.
   This uses a bounded lookahead, not an additional full-history count on each poll.

## Acceptance and Release

- Parser tests cover the supplied subscription forms, deduplication, NBSP/CRLF,
  mobile quotes, code and hidden-link safety, UTF-16 formatting and limits.
- Transport tests cover a keyboard arriving after the webhook, media loss guards,
  serialized fresh count reads, no-op repeated counts and unchanged surrounding
  content. Profile routing and repeated queue count values have regression tests.
- Both dialog profiles test the 80/81 boundary. Browser checks cover the lower-bound
  label on iPhone SE, iPhone, Android and desktop in light and dark modes.
- Run the impact-selected contract, API, mini-app, admin, static and documentation
  checks. No database migration is required.
- Submit only owned paths, require green exact-SHA CI, deploy all shared API roles
  and both contract-consuming static components, then run the strict release smokes.
- Do not reset historical terminal decoration markers or bulk-rewrite old posts.
  Existing stale counters can refresh on a subsequent comment mutation; this is not
  an automatic historical repair.

## Remaining Boundaries

Quick buttons remain opt-in for fresh posts. Enabling the setting after publication,
editing an already processed post, and anonymous forwarded source-text replacement
do not authorize rewriting history. They require a separately designed explicit
reprocess workflow with exact message scope and current-content guards.

Major counter delivery is still best-effort after comment persistence. Publisher
has bounded queue retries, but neither path has a transactional counter outbox.
A process crash between database commit and refresh admission, a persistent MAX
failure, or an unavailable audit reference can therefore leave a stale counter.
The next reliability increment should add a profile-scoped durable dirty-thread
revision/outbox, an indexed due-work scan, crash-safe admission, bounded backoff,
and convergence metrics. It must retain fresh reads under the shared MAX lock and
never recover by resending the post. This is an architectural follow-up, not a
guarantee provided by this release.

The mini app still shows only the latest 80 comments. Complete history and an exact
total require cursor pagination plus an indexed or transactionally maintained
profile/thread read model. `hasMoreMessages` deliberately reports the current
limitation rather than disguising it or adding expensive polling aggregates.

Customer acceptance needs an exact failing post link, whether the complaint concerns
native MAX comments or mini-app comments, an expected/observed count, and the
quick-button switch/access state. Use bounded read-only diagnostics first. Any
repair of existing customer posts needs an explicit target list and must retain
their existing discussion links.

MAX reference: <https://dev.max.ru/docs-api/methods/PUT/messages>. Editing is limited
to two messages per second per dialog/chat/channel; retain the existing shared
mutation limiter. Empty attachment arrays remove attachments, so counter edits
must not synthesize an empty keyboard snapshot.
