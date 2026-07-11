# Webhook ingress load test

`npm run loadtest:webhook` exercises only the signed MAX webhook ingress. It does not call the
MAX Bot API itself. The harness defaults to a dry run and never reads the project `.env`; provide a
dedicated environment explicitly.

Use an isolated local/staging database and dedicated synthetic or canary chat identifiers. Do not
point this harness at production as a routine check. Known production hosts are blocked unless both
public and production confirmations are present.

## Configuration

The planned acceptance run is 100 aggregate HTTP receipts per second for 10 minutes. `RPS` is not
multiplied by the mirror count: the default `1,2,3,6` phases divide the 10-minute window evenly and
keep aggregate ingress at 100 rps.

```bash
export WEBHOOK_LOAD_TARGET_URL='http://127.0.0.1:3001/api/webhook/max'
export WEBHOOK_LOAD_CHAT_ID='dedicated-load-test-chat-id'
export WEBHOOK_LOAD_SENDER_ID='dedicated-load-test-sender-id'
export WEBHOOK_LOAD_RUN_ID='local-20260711-01'

export WEBHOOK_LOAD_BOT_1_ID='load_bot_1'
export WEBHOOK_LOAD_BOT_1_SECRET_PATH='replace-with-bot-1-path-secret'
export WEBHOOK_LOAD_BOT_1_HEADER_SECRET='replace-with-bot-1-header-secret'
# Configure BOT_2 through BOT_6 with the same three variables for the full matrix.

export WEBHOOK_LOAD_DURATION_SEC='600'
export WEBHOOK_LOAD_RPS='100'
export WEBHOOK_LOAD_MIRROR_COUNTS='1,2,3,6'
export WEBHOOK_LOAD_MAX_IN_FLIGHT='256'
export WEBHOOK_LOAD_REQUEST_TIMEOUT_MS='10000'
export WEBHOOK_LOAD_ACK_P99_TARGET_MS='2000'
```

First inspect the redacted plan. Bot secrets, database URLs, authorization, chat ID, and sender ID
are not printed:

```bash
npm run loadtest:webhook
```

Execute only after the dry-run values have been reviewed:

```bash
export WEBHOOK_LOAD_EXECUTE='I_UNDERSTAND_THIS_SENDS_WEBHOOK_TRAFFIC'
npm run loadtest:webhook
```

Any non-local target also requires:

```bash
export WEBHOOK_LOAD_ALLOW_PUBLIC='I_UNDERSTAND_THIS_SENDS_NETWORK_TRAFFIC'
```

Known production hosts additionally require this second target opt-in and are capped at 100 rps for
600 seconds:

```bash
export WEBHOOK_LOAD_ALLOW_PRODUCTION='I_UNDERSTAND_THIS_TARGETS_PRODUCTION'
```

These confirmations are safety interlocks, not approval to run against production. Use dedicated
canary entities and the normal production change process before enabling them.

## Receipt and claim verification

Verification is optional. Prefer a PostgreSQL role that is already limited to read-only access. The
harness also starts an explicit `READ ONLY` transaction and performs only an indexed lookup of the
exact attempted receipt keys:

```bash
export WEBHOOK_LOAD_VERIFY_DATABASE_URL='postgresql://read_only_user:secret@db.example/maxim'
export WEBHOOK_LOAD_VERIFY_TIMEOUT_SEC='60'
export WEBHOOK_LOAD_VERIFY_INTERVAL_MS='1000'
```

Alternatively, provide a read-only metrics endpoint returning either a direct
`canonicalExecution` object or the system dashboard `webhookSlo.canonicalExecution` shape:

```bash
export WEBHOOK_LOAD_VERIFY_METRICS_URL='https://staging.example/api/v1/system/dashboard'
export WEBHOOK_LOAD_VERIFY_METRICS_AUTHORIZATION='InitData replace-with-read-only-auth'
```

Database verification is exact. Metrics verification compares pre/post counters and is a lower-bound
check, so run it only where the metrics window covers the full test and unrelated webhook traffic is
understood.

The command exits non-zero when any ACK is non-2xx/transport-failed, ACK p99 is not below the target,
or configured receipt/claim verification does not converge before its timeout.
