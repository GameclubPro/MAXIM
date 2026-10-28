# Bot and AI reliability hardening

Date: 2026-10-28. This plan separates observed availability, confirmed defects and
unresolved effects. Execute one implementation/release stage at a time; independent
read-only investigation can continue. Private source identities and operation evidence
stay outside Git. Each stage needs its own local, CI, installation and acceptance record.

## Evidence and priorities

| Priority | Problem and evidence                                                                                                                                                                                            | Required outcome                                                                                                                                                                      | Acceptance                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Closed support reproductions show a valid future source timestamp rejected by the worker, null history throwing, and an inference refusal emitted after expiry.                                                 | Validate the transport against explicit bounded clocks, reject malformed history without an exception, and preserve the original absolute reply deadline on every result path.        | Closed subprocess regressions, relevant real Redis cases, exact-source CI, immutable bundle installation, fresh transport and model identity.                                                           |
| 2        | Three sampled old started owners have no finished checkpoint; five later dependent receipts expired. Read-only cancellation preview refuses the mixed controller/API sources produced by a static-only release. | Make exact preview work with separately attested controller and installed API identity. Preserve all unknown effects and provide the concrete cancellation scope before any approval. | Connector/host mismatch regressions, exact image and sixteen-generation attestation, immutable READY preview. Apply remains separately authorized under the cancellation runbook.                       |
| 3        | A previously authenticated orphan SSH transport retained the second PC's management port despite existing client keepalives.                                                                                    | Bound server-side liveness for only the management tunnel, independently of model traffic and ordinary administrative access.                                                         | Isolated real OpenSSH disconnect/reconnect and access-restriction tests, scoped effective configuration, real management login after migration, unchanged model identity and progressing pool counters. |
| 4        | AI model attempts and registered delete intentions are observable, but do not establish filter accuracy or completed deletions. Historical permission failures are not current permission evidence.             | Keep input, classification, consultation capacity, intent admission and remote outcome separate; diagnose individual failures before changing routing, concurrency or retry policy.   | Comparable bounded cohorts per bot, explicit sample caps and coverage, labelled closed evaluation before a classification-policy change. No test messages in user destinations.                         |

At 17:53 UTC the sampled three filtering nodes were READY and completing attempts;
support was connected with a fresh poll. The closed 30-second ingress cohort contained
244 processed receipts, 49 duplicates and no pending/failed/quarantined receipts.
This observation does not prove historical quarantine recovery, all-feature coverage,
filter precision or successful user-visible support delivery.

## Recovery boundaries

An absent `EXECUTION_FINISHED` checkpoint cannot be replaced by a timeout, expired lease
or a success label. Preserve uncertain external effects. Use the bounded exact-minute
[owner proof](../runbooks/webhook-dependency-quarantine.md#bounded-owner-and-checkpoint-evidence)
and the exact-source [v2 preview](../runbooks/webhook-backlog-cancellation.md#exact-nominated-sources-v2).
Its READY receipt is necessary before discussing concrete cancellation scope; it does
not authorize stopping the fleet. Keep original deadlines and retained expired evidence.

A possible late-checkpoint scheduling gap is an investigation, not a confirmed cause:
the normal detached completion path already atomically settles claim and receipt.
Establish a reachable failing native case before changing recovery scheduling.

Management liveness must not change the shared administrative user's policy. A dedicated
unprivileged transport identity can receive narrowly scoped server keepalives and only
the fixed loopback reverse forward. Preserve pinned host keys, existing private-key
locations, the model service and sibling projects. Verify restrictions natively before
changing the host; a running tunnel process alone is insufficient acceptance.

## Product and operational follow-up

Support diagnostics remain content-free and private. Connection health and successful
reply delivery remain distinct. Follow the [support runbook](../runbooks/cpu-bot-support.md)
for immutable upgrades and preserve its no-public-fallback rule.

Do not increase moderation concurrency, switch the 4B confirmation policy or replay
publication attempts from age/counter evidence alone. First identify whether delay is
ingress, selection, preparation, ordering, model capacity, rights or external settlement.
Use existing closed cohorts and bounded audit catalogs, with no ad hoc live SQL.

After an authorized backlog operation, acceptance includes the sustained window in
[bot recovery](../runbooks/bot-reliability-recovery.md#capacity-and-acceptance), fresh
cohorts and separate action evidence. A short healthy sample cannot replace that gate.
Record remaining limits, including second-PC startup after Windows sign-in and untested
power-loss recovery, instead of promising that every recurrence is eliminated.
