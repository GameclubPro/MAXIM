# Major networks rollout

`MAJOR_NETWORKS_ROLLOUT` accepts `off`, `test` and `on`, with `off` as the release default.
The gate applies only to the moderation profile. `test` admits only the existing
`SYSTEM_ADMIN_USER_IDS` allowlist; Publisher never enters this rollout. Networks reuse
the existing favorite categories, separately for chats and channels.

Group-settings read/preview/apply and network statistics enforce the same gate on the API.
Authenticated shared favorite catalogue/composition remain available for the home screen.
An owner can still read an existing operation status while `off`; the action-role runner
continues settling retained operations under their existing authority and revision checks.

## Preview and apply

Deploy the compatible foundation through the normal release procedure first. Use a clean
checkout at the exact active API source SHA with successful `Required` and
`Analyze JavaScript and TypeScript`. The setter refuses a different active SHA, CI bypass
and interrupted-release pause adoption, including for previews.

```bash
./infra/scripts/vps-connect.sh major-networks-rollout test
./infra/scripts/vps-connect.sh major-networks-rollout test --apply
```

Omitting `--apply` performs the locked read-only preflight with a private temporary dotenv.
An applied transition changes only `MAJOR_NETWORKS_ROLLOUT`. The dispatch switch and both
Publisher reader modes retain their exact values and whether their assignments existed;
all unrelated dotenv bytes are preserved. Major does not require Publisher dispatch enabled.

The setter reuses the existing shared deploy lock, active immutable image fence, Publisher
operator pause and webhook quiescence protocol. It recreates all 14 API roles on that image,
then requires exact Compose/runtime mode and identity readbacks, native auxiliary checks,
strict health/stability smokes and the existing pause-release protocol. No build, migration,
store recreation, queue cleanup or automatic promotion is part of this command.

Each applied transition writes a fsynced private record under
`/var/lib/maxim-deploy/major-networks-rollouts/<operation-id>.json` before mutation. The record
retains the exact SHA, original/requested mode, all three Publisher value/configured pairs,
UTC times, terminal exit status and whether runtime verification completed. Records contain
no entity/user identifiers, content or secrets. A record is operational evidence; the existing
manifest, deploy journal and pause ownership remain recovery authority.

## Acceptance and expansion

The mode setter proves rollout parity, not product acceptance. Before enabling `on`, record
the exact source/image, mode, UTC window, closed test account and designated test destinations.
Use normal authenticated product flows; SQL reports cannot prove current human or bot rights.

- Verify moderation `test` admission for a configured system admin, exclusion for an ordinary
  account and exclusion for Publisher. Verify `off` hides/disables the new entry points.
- On the designated test chat/channel only, verify separate category catalogues, multiple
  categories, unchanged home names, two-device composition conflicts and refresh behavior.
  Do not use public groups/channels for diagnostics or permission probes.
- For group settings, use only explicitly changed fields and verify per-recipient completion,
  lost rights, stale revisions, interrupted-operation recovery and retained committed outcomes.
  Missing or uncertain outcomes do not permit blind replay.
- Inspect actual observation coverage with the bounded
  [network statistics audit](network-statistics-audit.md). Missing baselines, capped archives,
  stale samples and source/authority gaps must remain visible. Summed subscribers or participants
  are totals across entities, never unique people. Chat and channel metrics remain separate.

Only after the relevant UI stage is installed and the closed scenarios pass, explicitly review
and run the `on` preview/apply pair. No cron, elapsed window or successful setter promotes it.
Record incomplete coverage and production acceptance separately from local/CI checks.

## Disable and recover

For a healthy completed transition, use the same reviewed preview/apply with `off`:

```bash
./infra/scripts/vps-connect.sh major-networks-rollout off
./infra/scripts/vps-connect.sh major-networks-rollout off --apply
```

This also recreates every API role. It preserves favorite assignments, settings, observations,
durable group-operation journals and uncertain effects. Once migration
`20261022120000_add_managed_network_foundation` is applied, both API rollback paths retain the
compatible foundation source floor even while the gate is `off`.

If a command fails, inspect the exact running image, dotenv/readbacks, audit record, existing
pause and deploy journal before acting. A failed wrapper does not establish that the mode
reverted. The setter refuses interrupted-pause adoption; use the existing guarded recovery
procedure described in the [Publisher rollout](publisher-temporal-selection-rollout.md).
Never erase the lock, journals, receipts or queue state, rerun uncertain effects, or roll back
to an image without the installed foundation readers and writers.
