# Commercial AI pool

The optional pool makes three pinned classifiers independent primary workers:
`server-9b` on the VPS, `pc-a-4b` on the existing workstation and `pc-b-9b` on the
second PC. The VPS owns admission, expiring reservations and final moderation
authority. PCs make outbound SSH connections and expose their authenticated model
API only on `127.0.0.1:18084`. They receive no MAX token or direct database access.

This runbook describes the implementation and rollout gates. It does not establish
that the pool has been deployed, that either PC passed an unattended reboot, or
that the models passed independent advertisement-quality acceptance.

## Scheduling and failure boundaries

Each model has one physical inference slot. Primary work ranks available nodes by
measured response-time EWMA plus a decaying failure penalty; exact ties rotate.
The three bounded measurements live in the background process and reset on its
restart. Atomic reservations prevent two producers from claiming the same slot.
The shared bounded admission mailbox retains at most two pending inputs and three
active sources. Existing per-chat, source-age, three-second admission and original
20-second inference limits remain. These are short-lived work records, not an
unbounded backlog or a historical replay queue. Expiry is an unclassified input.

Only a 4B result can request a 9B consultation. A consultation must immediately
reserve an idle 9B slot after the atomic check for higher-priority primary work.
It never queues behind another model request, retries, or extends the original
deadline. If neither 9B is immediately available, the result remains `UNSURE`
and cannot authorize deletion. Ordinary primary work can make at most one retry
on a different available node within the original deadline; obsolete results
cannot replace the current attempt.

The initial `confirm-positive` policy requires consultation for both 4B
`COMMERCIAL` and `UNSURE` results. The optional `direct-4b` policy permits a direct
4B commercial decision and consults only for `UNSURE`. Select `direct-4b` only
after a separately reviewed, frozen, independently labelled quality evaluation
accepts its false-positive and missed-advertisement rates. Installing another
model is not that acceptance. Neither policy treats a model's self-reported
confidence as a calibrated probability.

Node leases expire after ten seconds and readiness after six seconds without
renewal. Disconnection prevents new reservations; generation/attempt fences reject
late answers. An interrupted busy PC recycles its owned model process before
advertising readiness again. An idle connection loss can retain its warm model.
The supervisor retries SSH with bounded jitter and re-registers after the connection
and model checks pass. Pool workstation profiles enable the authenticated `/slots`
endpoint on loopback. Before connecting, the supervisor checks its owned model
process and requires one idle slot with `id=0`, `n_ctx=4096` and the exact boolean
`is_processing=false`, alongside the pinned template, alias and slots capability.
Unknown, malformed, oversized or timed-out observations do not establish readiness.
The existing first-PC legacy launcher keeps its own unchanged profile and lifecycle.
A missing PC reduces total capacity without blocking the other workers. Reduced capacity can still produce admission skips; three machines
do not guarantee zero queues or complete traffic coverage under arbitrary load.

The CPU node uses the same physical lease as the legacy CPU classifier. The pinned
llama.cpp b11804 `/health` handler ignores `fail_on_no_slot`; health is liveness only.
Readiness uses the bounded `/slots` contract and `/props.endpoint_slots=true`.
The separate guarded CPU capability upgrade is described in the
[local model runbook](commercial-llm-shadow.md); ordinary API deployment alone does
not establish that the existing CPU container supports slots.

An idle slot observation does not acknowledge cancellation of a pending HTTP request.
Immediately before a CPU pool handoff, an owner-checked operation removes the lease's
expiry. A complete validated response releases its own lease. An ambiguous failure
retains the lease and withdraws CPU capacity, including across an API restart while
Redis retains the key. Neither a later idle observation nor the former 120-second
TTL may release that hold. Other nodes remain independently schedulable. Recovery
requires quiescing the CPU dispatcher and proving the captured model generation
stopped before any exact-token release; never manually delete the key to restore
readiness. Redis data loss and independently initiated legacy requests retain their
existing limitations; this lease is not durable across loss of Redis state.

The VPS and its Redis admission service remain the coordination point. A VPS or
Redis outage prevents AI admission; adding PCs does not make that control plane
highly available. Busy, uncertain, stale and failed work cannot delete a message.
The [commercial AI deletion guards](commercial-ai-deletion.md#durable-effects)
and independently enabled moderation rules keep their existing authority.

## Flags and first host rollout

All fourteen API roles must agree on these canonical dotenv values:

| Setting                               | Default            | Meaning                                            |
| ------------------------------------- | ------------------ | -------------------------------------------------- |
| `COMMERCIAL_LLM_POOL_WORKERS_ENABLED` | `false`            | Allow pool worker registration and readiness.      |
| `COMMERCIAL_LLM_POOL_ENABLED`         | `false`            | Route eligible enforcement work through the pool.  |
| `COMMERCIAL_LLM_POOL_4B_POLICY`       | `confirm-positive` | Explicit `confirm-positive` or `direct-4b` policy. |

Routing requires worker registration enabled. The separate
`COMMERCIAL_LLM_ENFORCEMENT_ENABLED` flag and per-chat eligibility still control
whether an input may enter commercial AI enforcement. Registration-only mode
does not itself submit production messages or establish classification quality.
Safety Desk reads the configured enforcement status namespace: legacy while routing
is off and pool-v2 while routing is on. Missing pool status never falls back to an
old legacy heartbeat; process generations and freshness retain their existing meaning.
It also starts the server node's readiness checks in the background role while
enforcement is off. The new PC and server can register before routing begins;
the existing 4B worker stays on the legacy path until routing is enabled.
Pool routing applies only to fresh ENFORCE work. Historical SHADOW observations
keep the legacy classifier path and never acquire deletion authority.

Finish the planner-selected local checks and require successful `Required` and
`Analyze JavaScript and TypeScript` on the exact deployment SHA. Use the ordinary
clean release checkout and guarded full API rollout. For the first stage:

```bash
MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED=true \
MAXIM_COMMERCIAL_LLM_POOL_ENABLED=false \
MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY=confirm-positive \
  ./infra/scripts/vps-connect.sh deploy main --auto
```

The three `MAXIM_` values are caller-only deploy overrides, protected from
`.env.vps`. Unspecified values retain the canonical dotenv setting. Any explicit
pool override selects all API roles, even at the same source SHA. Under the
ordinary persistent deploy lock and producer quiescence, the wrapper atomically
persists the complete resolved settings, recreates the API roles, and verifies
Compose and all fourteen runtime environments. Never edit one container's flags
or bypass the normal stopped-worker fence. Stores are not recreated.

The existing first-PC launcher, 4B weights, SSH key and
`commercial-llm workstation-bridge` command stay installed unchanged. When both
pool flags are true, that server-side entrypoint adapts its exact legacy wire
identity to `pc-a-4b` in the pool. It retains the legacy three-second request
ceiling and permits 512 bounded frames per minute. With routing off it selects
the original legacy path. Recreating the background role closes the old SSH
session; the existing supervisor reconnects and takes the selected path. Do not
install a second 4B launcher or replace its authorized key for this migration.

The new host operation is
`commercial-llm workstation-pool-bridge pc-a-4b|pc-b-9b`. It accepts
exactly one allowlisted identity and executes the compiled bridge in the attested
active `api-moderation-background` container. A worker hello cannot choose another
node, executable or container. This is a long-running framed worker transport,
not an interactive diagnostic command.

## Second-PC installation and startup

Use Linux or WSL under the account owning the pinned artifacts and the reviewed
`maxim-vps` SSH identity. Node 24, Python 3, `flock`, a compatible NVIDIA/CUDA
runtime and working strict host-key verification are prerequisites. On the new
9B PC, use a separate key restricted to the exact `pc-b-9b` host bridge and a
dedicated SSH alias. Install only its public key on the VPS through the first
PC's existing administrative connection; never copy the first PC's private key.
Keep the standalone 9B launcher for rollback. After the host registration stage
is ready, stop that exact owned process before starting the pool worker: both
use port 18084 and cannot share the port or GPU memory. This does not change or
stop the existing first-PC 4B worker.

The installer consumes existing files, verifies pinned sizes and SHA-256 values,
and copies them into a private per-node directory. It does not download weights.
The profile names all required GGUF/runtime/support archives in
`infra/scripts/commercial-llm-pool-profile.mjs` and its imported workstation
profile. Prepare only the matching node's verified artifacts. From the reviewed
checkout, for the second PC:

```bash
node infra/scripts/commercial-llm-pool-workstation.mjs install pc-b-9b \
  --artifact-dir /absolute/path/to/verified-artifacts --ssh-alias maxim-ai-pool-vps
~/.local/bin/maxim-llm-pc-b-9b start
~/.local/bin/maxim-llm-pc-b-9b status
```

The new 9B launcher uses an immutable installed script/runtime bundle and a
private local API key. Preserve the existing 4B launcher's lifecycle settings;
its protocol compatibility is provided on the VPS.
The model must pass identity, template and warm-up checks before READY. A
`started` result only confirms that supervision began; check subsequent local
status and host readiness separately. Neither warm-up nor READY is a labelled
advertisement evaluation.

For Windows, run the startup helper as the same Windows user who owns that WSL
distribution. Replace `Ubuntu` with the actual installed distribution name:

```powershell
.\infra\scripts\commercial-llm-pool-startup.ps1 -Operation Install `
  -NodeId pc-b-9b -Distro Ubuntu -Mode Startup
.\infra\scripts\commercial-llm-pool-startup.ps1 -Operation Status -NodeId pc-b-9b
```

`Startup` uses that owning user's Windows credential through Task Scheduler and
can start before interactive sign-in; its credential prompt must be completed by
that user. `Logon` needs no stored logon credential but starts only after sign-in.
The task runs a foreground WSL watch so Windows can detect and restart a failed
supervisor. Do not register as SYSTEM or point another account at the user's WSL
distribution. Passwords never belong in project files or shell commands.

After an unexpected shutdown, an enabled worker resumes, loads and warms the
model, then reconnects. It cannot be ready instantaneously at power-on. BIOS/UEFI
"restore after AC power loss" is a separate hardware setting; Windows startup
cannot switch on a powered-off PC. Sleep and Internet availability also affect
readiness and must be checked on each machine.

Manual stop is persistent, including across reboot:

```bash
~/.local/bin/maxim-llm-pc-b-9b stop
~/.local/bin/maxim-llm-pc-b-9b start
```

Only explicit `start` re-enables a manually stopped worker. `resume` and the
Windows watch preserve the disabled state. The startup helper's `Remove`
operation stops the exact owned worker and removes only its matching task.

## Acceptance and routing activation

Before enabling routing, preserve evidence for the new PC and server node's
exact artifact/runtime identity, warm-up, registration and loss/recovery behavior,
and verify the existing 4B through its legacy path. Its pool registration can be
checked only after the routing rollout and automatic SSH reconnect. Exercise disconnect
while idle and busy, duplicate-session rejection, stale-answer rejection, model
failure, manual stop across reboot, and reboot before sign-in if `Startup` is
required. Use closed fixtures without MAX deletion authority. Do not send probes
to user groups or claim a complete reboot test from Task Scheduler registration.

Locally run the focused protocol/mailbox/bridge, real-Redis admission/lease,
workstation lifecycle and rollout tests. The production Compose change also
selects full repository validation through the existing impact planner. A
functional test does not replace independent model-quality evaluation. There is
no operator-facing end-to-end pool smoke command in this change; retain this as
an explicit acceptance gap until a reviewed closed harness is supplied.

After those gates and the exact-SHA release checks, enable routing while retaining
the initial quality policy:

```bash
MAXIM_COMMERCIAL_LLM_POOL_WORKERS_ENABLED=true \
MAXIM_COMMERCIAL_LLM_POOL_ENABLED=true \
MAXIM_COMMERCIAL_LLM_POOL_4B_POLICY=confirm-positive \
  ./infra/scripts/vps-connect.sh deploy main --auto
```

If enforcement is currently disabled, its separate guarded rollout switch is
also required; do not assume enabling the pool enables enforcement. Inspect
fresh node readiness and completed classifications separately from accepted
inputs, capacity skips, uncertainty and confirmed MAX delete effects. Record
latency by node and route, eligible coverage, consultation completion/skips and
availability gaps. An outage test must show that healthy nodes continue making
progress; an idle heartbeat alone proves no throughput.

## Downgrade and durable readers

To stop pool routing while keeping registered workers for diagnostics:

```bash
MAXIM_COMMERCIAL_LLM_POOL_ENABLED=false \
  ./infra/scripts/vps-connect.sh deploy main --auto
```

That returns enforcement and the unchanged first-PC bridge to their legacy
routing behavior after automatic reconnect. To disable both registration
and routing, supply both corresponding `MAXIM_` flags as `false` in the same
guarded rollout. Never clear admission keys, intents, proofs or queues to make a
transition look complete.

Pool effects carry durable source version 2 and the explicit policy identity
`commercial-pool-v2`. Both API rollback paths and connector bootstrap require the
legacy version-1 reader **and** the pool version-2 reader in the target source,
in addition to the existing proof/origin/deadline guard. Turning routing or
enforcement off does not remove that floor. Retain a compatible image before
enabling writers; if no retained image has both readers, use a compatible
fix-forward. A static-only rollback keeps its existing component scope.
