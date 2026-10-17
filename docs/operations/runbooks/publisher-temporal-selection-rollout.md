# Publisher temporal selection rollout

`PUBLISHER_TEMPORAL_SELECTION_ROLLOUT` changes the global Publisher poll's selection
preference. The release default is `off`. It does not authorize a SEND, raise quotas,
change bot assignments, or allow replay of an uncertain effect. Final execution guards
and the existing dispatch switch remain authoritative.

The current selector admits only proved NOW/SNAPSHOT audiences of at most 64 targets.
Scheduled, unproved, larger and unsupported audiences retain the existing path. `test` additionally
requires the complete publication and its bounded historical execution audiences to
contain only the designated chat `-78271094414679` and channel `-78271171091799` with
matching stored entity types. These stored types do not replace fresh live test checks.
Numeric stages use the stable bot/publication cohort namespace `publisher-temporal-v1`.

## Preview and apply

First deploy the compatible runtime through the normal release procedure. Use a clean
checkout at the exact installed API source SHA with successful `Required` and
`Analyze JavaScript and TypeScript` checks. The connector requires these checks even
for a preview; emergency CI bypass and interrupted-release adoption are unavailable.

```bash
./infra/scripts/vps-connect.sh publisher-selection-rollout test
./infra/scripts/vps-connect.sh publisher-selection-rollout test --apply
```

Allowed explicit modes are `off`, `test`, `5`, `25` and `100`. Omission of `--apply`
is a read-only preview using a private temporary dotenv. Each later transition needs
its own reviewed preview and explicit apply; the tool never promotes a stage.

The setter enforces:

- The shared deploy lock, exact active source/image fence, source schema and actual
  selector wiring, exact topology, and initial dispatch/selection parity in all 14 roles.
- Finite unambiguous dotenv values. Non-off selection requires dispatch already enabled.
  The dispatch assignment, including its absence, and all unrelated bytes are preserved.
- A durable private operation record before mutation, then the existing owned Publisher
  pause, webhook quiescence and complete API role recreation on the installed image.
- Effective Compose and runtime readback of both flags, exact image and role identity,
  native auxiliary attestation, strict health/stability smokes, identity verification
  when dispatch is enabled, and the existing pause-release protocol.

No build, migration, PostgreSQL/Redis recreation or queue cleanup is part of the setter.
Selection `off` still recreates the API roles so the requested flag reaches every role.
Dispatch enable/disable retain their existing authority and pause semantics.

## Acceptance before expansion

The following are operator-reviewed prerequisites, not checks enforced by the finite
mode setter. Record the exact source/image, from/to mode, UTC observation window,
collector identity and successful sample times, closed cohort sizes, truncation and gaps.

1. In `test`, use only the designated chat and channel after independently verifying
   actual entity type and exact bot/human authority. Send only marked test content using
   normal Publisher product authentication; Safety Desk Basic Auth is not a Publisher
   session. Keep cancelled, denied, expired and uncertain outcomes in the acceptance data.
2. Prove natural global-poll exposure with `publication_temporal_selection_v1` observations.
   Enrollment and `excludedWaiting` describe classification, not a changed final portion.
   Require positive `changedDecisionBatches` and inspect `changedPositions`, `newlySelected`
   and `displaced`, alongside the marked scenario's persisted outcomes. The comparison
   independently merges the old and new execution candidates with the same already-read
   verification/fallback inputs; it makes no extra SQL query or external action. Those
   inputs span sequential reads, so this is not a comparison of two complete transactions
   at one database snapshot. A flag readback or ordinary NOW SEND
   alone is insufficient: targeted NOW wakeups use a separate selector. Never manufacture
   exposure by editing production SQL or replaying uncertain effects.
3. Before `5`, require the native authorization, concurrency, retry/deadline, receipt and
   loss/restart checks, plus bounded-query cost evidence for the supported audience scope.
   Compare full closed cohorts and p95/p99 at comparable load, separating NOW/scheduled
   and media dimensions. Large audiences need their own unchanged-path evidence.
4. Observe `5` for at least 24 hours and then `25` for at least 24 hours before the next
   explicit promotion. After `100`, observe at least 48 hours. A corrective release,
   missing samples or insufficient comparable operations leaves acceptance incomplete.

Stop expansion for any new duplicate external effect, wrong sanction, authority bypass,
lost receipt, or more than 10% p95/p99 degradation at comparable load. A successful
command or healthy queue does not prove publication acceptance or MAX client visibility.

Selector observations count selection attempts, not unique publications or successful
SENDs. The bounded in-process observer emits immediately and subsequently at most once
per minute when another poll occurs. Restarts, logger errors and a tail without another
poll can lose observations. Missing logs are a coverage gap, never zero exposure or
proof of success. Use persisted journals for accepted operations and terminal outcomes;
see [publication diagnostics](publisher-publication-diagnostics.md).

## Transition evidence and recovery

Each applied selection operation keeps one bounded private JSON record under
`/var/lib/maxim-deploy/publisher-selection-rollouts/<operation-id>.json`. It records
`operation=selection`, exact source SHA, original/requested mode, whether the original
key existed, retained dispatch state, start/finish UTC times, terminal status and whether
runtime readback completed. Files are fsynced, at most 4 KiB and mode `0600`; the containing
directory is owned and mode `0700`. No content, bot/user identifiers or secrets are recorded.
These records are operational evidence, not recovery authority, and never replace the
release manifest or the existing recovery journals.

Failure to write the initial record stops before pause or dotenv mutation. If the final
audit write fails after runtime verification, the command fails without reporting success
or resetting the actual flag. A subsequent failure record can have `runtimeVerified=true`.
If the process is killed or storage remains unavailable, the record may remain `started`;
inspect actual runtime and existing pauses before acting. Never infer rollback from a
failed wrapper, erase evidence, or rerun an interrupted operation blindly.

For a healthy completed rollout, return to the old selector with a reviewed preview/apply:

```bash
./infra/scripts/vps-connect.sh publisher-selection-rollout off
./infra/scripts/vps-connect.sh publisher-selection-rollout off --apply
```

This preserves dispatch and all durable effects. It does not roll back an image or relax
reader/version floors. For interrupted pause/fleet state, inspect the reported cause and
use the existing guarded `publisher-dispatch-disable --apply` recovery procedure. The
selection setter refuses to adopt that state. Preserve receipts, claims, queues and
unknown effects throughout recovery.

Guarded dispatch-disable recovery reads the persisted selection mode under the shared
lock. Its first identity check permits mode drift so the existing recovery path can
repair it. The shortcut that avoids recreating API roles requires both an explicitly
disabled dispatch switch and exact persisted-mode parity on all 14 roles. A stale or
missing explicitly configured mode requires the normal complete recreation. An absent
selection assignment means `default-off`, accepting only missing or `off` runtime values;
an explicit `off` requires `off` in every role. Rendered Compose configuration and final
runtime readbacks must match the preserved mode before completion. Recovery changes
neither the saved selection assignment nor an uncertain external effect.

Image rollback preserves dotenv assignments. Returning to an older image or disabling
dispatch does not prove the selection flag is off; verify an explicit mode transition
and its readback separately before a later compatible release can reuse that setting.

Before the media wave, the controller stops only the exact existing media-analysis
container and confirms it is stopped. The already-attested OCR sandbox stays running;
its IPC volume must then have only that sandbox as a running consumer. The replacement
media role must pass the normal two-consumer attestation before later waves start.

Applied dispatch-disable recovery with explicit webhook-pause adoption can inspect
stopped media-analysis and moderation-background consumers. It still requires each
exact container generation, image, service, role, native profile and read-only socket
mount, plus healthy isolated native auxiliaries and no unexpected running IPC consumers.
Paused, restarting, dead, missing or ambiguous consumers fail closed. Ordinary status,
preview, enable and selection operations retain their running-consumer requirement.

Pause control uses the inspected running admin container ID after checking its exact
image, Compose service and application role. A failed execution is never retried through
another container. With a reviewed stopped admin, pause recovery can use a one-off
action container: stdin is closed so Compose volume prompts cannot consume code or
authorize recreation. The helper returns one nonce-bound, action-specific response;
ordinary diagnostics and unframed JSON cannot acknowledge a mutation.

An interrupted or malformed acquisition/clear response leaves the Redis outcome unknown.
The controller reports that uncertainty before offering guarded disable recovery; it
does not claim the marker is absent or still armed. Inspect the exact runtime and pause
before recovery, and never repeat enable to resolve a missing acknowledgement.
