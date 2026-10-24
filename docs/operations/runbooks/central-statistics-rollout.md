# Central statistics rollout

MAXIM owns canonical channel/chat statistics. EXCHANGE sends its own observations
through the authenticated internal API; it retains its independent product store.
No integration settings, provider labels or confirmation screens are exposed.
This procedure never deletes MAXIM history, publishes messages or grants access.

## Installation order

1. Complete both repositories' required checks. Install Market's root-owned
   statistics admission hook with its initial floor41 **before** updating MAXIM's
   shared deploy lock helper. Preserve the fixed deployment lock and its inode.
2. Release the exact green MAXIM main SHA normally, with central statistics still
   disabled. Both central migrations are additive. The exact-view migration adds
   nullable BIGINT shadow counters with no table rewrite or historical backfill;
   its mandatory reader floor applies to both API rollback paths.
3. Release Market's additive migration42 in LEGACY mode using its own guarded
   immutable release procedure. Preserve its original database and volumes.
4. Read the single persistent `statistics_store_control.producer_epoch` from that
   Market database. This nonsecret UUID identifies the producer installation;
   never generate a replacement for a retry. Follow Market's central cutover
   runbook for the bounded read and its source/DB identity checks.
5. Activate MAXIM through a second **normal exact-green-SHA deploy**:

   ```sh
   MAXIM_STATISTICS_CENTRAL_EPOCH="$MARKET_STATISTICS_PRODUCER_EPOCH" \
     ./infra/scripts/vps-connect.sh deploy main --auto
   ```

   The caller-only UUID is captured before `.env.vps` loading. It selects the
   complete shared API component even if the target SHA is unchanged. Under the
   existing deployment lock and stopped-producer/consumer queue fence, the helper
   atomically patches exactly `STATISTICS_CENTRAL_ENABLED=true`,
   `STATISTICS_CENTRAL_MODE=CENTRAL` and `STATISTICS_CENTRAL_EXCHANGE_EPOCH` in the
   canonical dotenv. It preserves unrelated bytes, permissions and credentials.
   A conflicting persisted epoch is refused before runtime transition and again
   before replacement. All fourteen Compose and running container environments
   must match before the queue fence is released. Native auxiliaries receive none
   of these keys. No manual dotenv edits or partial role restarts are required.

6. Run Market's separately reviewed cutover release with a stable cutover UUID.
   Its authenticated preflight requires enabled CENTRAL status, all capabilities,
   retired legacy history and the exact persistent producer epoch. Only Market's
   explicitly approved test history/cache is cleared; MAXIM facts remain intact.
7. Provision the bounded metadata audit with the matching released tooling, then
   verify natural authorized ingest/read and public/frontend identities. See the
   [central audit](central-statistics-audit.md). Actual MAX devices and natural
   24/48-hour observations need independent evidence.

## Failure handling

An absent activation variable performs no dotenv or runtime change. `--plan`
never persists activation. A repeated activation with the same epoch is safe;
it must still use current exact-SHA green CI and the normal release fence.
Neither disabling a flag nor a failed rollout permits an old reader or resets the
producer identity. Preserve installed compatibility floors and recovery journals.
Do not recreate stores, lower floors or re-enable retired history exchange.

Focused checks: `statistics-central-rollout-state.test.mjs`, existing
`statistics-exchange-rollout-state.test.mjs`, Market admission/cutover PostgreSQL
tests and the exact statistics rollback tests. Report local, exact-SHA CI, released,
public acceptance and MAX-device evidence separately.
