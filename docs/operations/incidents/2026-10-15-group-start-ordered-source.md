# Fresh group messages behind an unfinished source

The administrator reported no response to `Старт` at 23:09 Moscow time on
15 October 2026 (`20:09Z`). The supplied group ID and invite were matched through
MAX. Bot identity, subscriptions and current administrator permissions were valid.
Private evidence retains the exact destination and source IDs; this document does
not publish them.

Runtime throughout diagnosis and recovery was
`4d02c44e8996d30bf8cc126fd92f4a7c30091c3d`, manifest
`release-20261015T183321Z-4d02c44e8996`, image ID
`sha256:40f7a1c914a50c37e4eb9c7d8acab324541ad6851eceeecdf2ad5ae9cbb5ebdf`.

## Evidence and cause

- The complete `chat-message-window` audit for `20:09:00Z–20:10:00Z` examined
  207 receipts without truncation. Six belonged to the reported group: two
  processed lifecycle observations and four quarantined message receipts,
  representing two messages received by two bots. The audit does not expose
  message text, so it does not independently identify which was `Старт`.
- The complete bounded quarantine audit linked all four message receipts to one
  unfinished canonical source created at `14:20:42.415Z` (17:20:42 Moscow time).
  The source was FAILED after business start. Its enforced READY claim retained
  preparation and start evidence but no lease, completion or finished checkpoint.
  New messages reached ingress but could not reach the handshake through this
  ordering dependency; their deadlines subsequently expired.
- The old source had a confirmed successful DELETE, completed at
  `14:20:43.060Z`. One successful effect does not prove whole-handler completion
  and does not permit replay. The minute-wide historical message audit was
  truncated; only the exact observed source and effect are used here.
- An online ordered-anchor inventory found 115 rows across 112 chats, including
  88 unfinished started owners before this repair. It was a complete bounded
  online walk, not a frozen recovery proof. Only the one reviewed source in the
  reported group was selected and authorized for abandonment.

## Authorized recovery

After successful online admission, the owner explicitly authorized temporary
fleet shutdown and permanent no-replay settlement of that one source. The
[source-abandonment protocol](../runbooks/webhook-source-abandonment.md) stopped
the exact 14 API and two native generations and fenced all 24 webhook queues.
Frozen inventory returned one owner, complete coverage, no unknown sources and
no saturation. A second independent snapshot matched before installation.

The controller installed and independently verified sealed dispositions,
materialized the required receipts, restarted the exact fleet and resumed the
queues. Strict smokes passed. Its final result was `coldRecoveryComplete=true`,
`fleetReady=true`, `releaseRecorded=false`; the API image did not change.
The final journal digest is
`33918d0433a9af3dd786ea0d7fa6733d41165624b79b175ed8a684a22e9ae3d8`.
The original started claim, effect evidence and expired message receipts were
not replayed or presented as successful processing.

## Confirmed recovery and remaining acceptance

The closed `20:39:00Z–20:40:00Z` audit examined 538 receipts across its bounded
status heads without truncation and found 42 receipts in this group. All 42
were PROCESSED: 36 message-created, four message-edited and two other events.
Receipt-to-processing latency was at most 312 ms. This establishes fresh
receipt progress for that minute, not policy correctness or remote-send proof.
At `20:42:07.001Z`, the named bot logged an in-chat handshake with outcome
`already_connected`. The complete `20:42Z–20:43Z` audit found 19 processed
receipts without truncation, including a separate successful DELETE with one
attempt. The handshake log is not SEND proof: its send helper catches failures.
The administrator's visible-response confirmation or an exact SEND receipt is
still required. Expired commands from `20:09Z` stay expired.

The maintenance pause remains in monitoring evidence. Recovery of this one
source does not establish recovery of the other inventoried chats or begin
the final 30-minute acceptance window.

## Follow-up constraints

Fresh administrator commands need a separately proven command-only path if
they are to progress behind an unresolved moderation source. A text classifier
or an ordering exception alone is insufficient: ordinary moderation currently
continues after the handshake. The path must bind a fresh persisted receipt,
reserve and settle command authority atomically, exclude competing canonical
execution, retain fresh bot/user administrator checks, and fence ambiguous sends.
Text accompanied by media, nonadministrator commands, duplicate deliveries,
concurrent starts, changed content and process interruption need negative tests.
Old source holds and rollback readers must remain effective.

Other unfinished sources require their own exact evidence, complete reviewed
preview and authorization before an irreversible abandonment. Do not repeat
fleet shutdown per chat or infer a fleet-wide permission from this repair.
