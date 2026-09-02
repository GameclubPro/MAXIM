# Webhook ingress load test

`npm run loadtest:webhook` exercises only the signed MAX webhook ingress. It does not call the
MAX Bot API itself. The harness defaults to a dry run and never reads the project `.env`; provide a
dedicated environment explicitly.

Use an isolated local/staging database and dedicated synthetic or canary chat identifiers. Do not
point this harness at production as a routine check. Known production hosts are blocked unless both
public and production confirmations are present.

## Configuration

The default custom plan is 100 aggregate HTTP receipts per second for 10 minutes. `RPS` is not
multiplied by the mirror count: the default `1,2,3,6` phases divide the configured window evenly and
keep aggregate ingress at the configured receipt rate.

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
export WEBHOOK_LOAD_MIN_THROUGHPUT_RATIO='0.95'
```

### Baseline-derived profiles

Use an operator-observed aggregate ingress baseline, not a guessed host capacity, for the named
acceptance profiles. These settings only build a plan; they do not set `WEBHOOK_LOAD_EXECUTE` and do
not send traffic by themselves.

The steady profile runs at 2x baseline for 600 seconds by default:

```bash
export WEBHOOK_LOAD_PROFILE='steady-2x'
export WEBHOOK_LOAD_BASELINE_RPS='25'
unset WEBHOOK_LOAD_RPS WEBHOOK_LOAD_DURATION_SEC WEBHOOK_LOAD_EXECUTE
npm run loadtest:webhook
```

The burst profile runs at 4x baseline for 60 seconds by default:

```bash
export WEBHOOK_LOAD_PROFILE='burst-4x'
export WEBHOOK_LOAD_BASELINE_RPS='25'
unset WEBHOOK_LOAD_RPS WEBHOOK_LOAD_DURATION_SEC WEBHOOK_LOAD_EXECUTE
npm run loadtest:webhook
```

Review the redacted dry-run plan before deciding whether to execute it. `WEBHOOK_LOAD_RPS` cannot
override a named profile. The computed rate remains subject to the global 1,000 rps parser limit and
named profiles are accepted only on non-production targets. Known production hosts reject both the
2x and 4x profiles regardless of confirmations or computed rate.

Every phase must deliver at least 95% of its configured aggregate RPS by default. The measurement
uses the longer of configured and actual phase duration, so a short partial run or an elapsed overrun
cannot pass. Scheduling and capacity-gate waits stop at the configured phase deadline. Already
started requests receive only a bounded grace capped by both the request timeout and ACK p99 target;
the harness then aborts them. Each phase reports `throughputRatio`, `throughputPassed`, and
`deadlineExceeded`.

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

Webhook targets and metrics endpoints on public or known production hosts must use HTTPS. HTTP is
accepted only for local or private non-production targets. The harness refuses HTTP redirects
instead of forwarding webhook paths, header secrets, request bodies, or metrics authorization to a
different origin.

Known production hosts accept only the `custom` profile, additionally require this second target
opt-in, and are capped at 100 rps for 600 seconds:

```bash
export WEBHOOK_LOAD_ALLOW_PRODUCTION='I_UNDERSTAND_THIS_TARGETS_PRODUCTION'
```

These confirmations are safety interlocks, not approval to run against production. Use dedicated
canary entities and the normal production change process before enabling them.

## Receipt and claim verification

Verification is optional. Prefer a PostgreSQL role that is already limited to read-only access. The
harness also starts an explicit `READ ONLY` transaction and performs only an indexed lookup of the
exact attempted receipt keys. The verification deadline covers connection and polling; every exact
query receives both client and transaction-local server timeouts capped by the remaining budget.
Rows returned after the deadline never pass acceptance. A bounded rollback/disconnect cleanup may
finish after the sampling deadline:

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
understood. Metrics verification may invoke a full diagnostics endpoint, so its polling interval
defaults to and cannot be lower than 15 seconds. Database verification keeps the 1-second default.
Both polling modes cap each request/query and sleep to the remaining verification deadline:

```bash
export WEBHOOK_LOAD_VERIFY_INTERVAL_MS='15000' # metrics mode only
```

The command exits non-zero when any ACK is non-2xx/transport-failed, ACK p99 is not below the target,
or configured receipt/claim verification does not converge before its timeout.

## End-to-end drain verification

HTTP ACK success proves only that ingress accepted the request. Optional drain verification proves
that the asynchronous webhook pipeline returned to its pre-send pressure after all send phases.
It uses the dedicated protected operational endpoint and never polls the full system dashboard.
The recommended acceptance setup combines exact database verification above with this lightweight
read-only endpoint:

```bash
export WEBHOOK_LOAD_VERIFY_DRAIN='true'
export WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_URL='https://staging.example/api/v1/system/metrics/queues/operational'
export WEBHOOK_LOAD_VERIFY_DRAIN_METRICS_AUTHORIZATION='InitData replace-with-read-only-auth'

# Optional bounded controls and their defaults:
export WEBHOOK_LOAD_VERIFY_DRAIN_LAG_TARGET_SEC='10'
export WEBHOOK_LOAD_VERIFY_DRAIN_HEALTHY_SAMPLES='3'
export WEBHOOK_LOAD_VERIFY_DRAIN_TIMEOUT_SEC='120'
export WEBHOOK_LOAD_VERIFY_DRAIN_INTERVAL_MS='5000'
```

The URL path must be exactly `/api/v1/system/metrics/queues/operational` (or the same controller path
without the deployment `/api` prefix). Dashboard and generic queue-metrics paths are rejected. The
endpoint requires the same InitData and system-admin allowlist as other system diagnostics.

The harness captures global queue lag, pending default webhook work, and pending action work before
sending. Pending work is `waiting + prioritized + active + delayed`; completed and historical failed
jobs do not block drain. After the send phases and receipt/claim verification, a sample is healthy
only when:

- global queue lag is at or below the configured target;
- default webhook pending work is at or below its pre-send baseline, which is zero when the baseline
  was zero;
- action pending work is at or below its pre-send baseline, which is zero when the baseline was zero.

The required number of healthy samples must be consecutive; any unhealthy sample resets the
sequence. A passing sequence must also span at least the configured lag target, preventing a fresh
database backlog from passing three samples before it becomes old enough to cross that target. The
drain interval defaults to 5 seconds and cannot be below 1 second. Sampling stops at the bounded
drain timeout, and each metrics request is capped by the remaining time. Drain verification is
independent of receipt/claim verification and can be combined with either database or legacy metrics
mode.

The result reports `ackPassed`, `throughputPassed`, `receiptAndClaimVerificationPassed`, and
`endToEndDrainPassed` separately. Overall `passed` is false when ACKs succeeded but target throughput
was not sustained or the configured end-to-end drain did not converge.
