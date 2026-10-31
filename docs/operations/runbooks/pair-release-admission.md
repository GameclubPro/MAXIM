# Major and Karavan release admission

Both products acquire `major-karavan-release-v1` on the same VPS before their existing product
locks. Svyazka is outside this admission. Product CI, attestations, capacity, migration, reader
floors, manifests and strict smokes remain mandatory.

The persistent inode is `/var/lib/major-karavan-release/state/admission.lock`. Root owns the
protocol marker, installed helper and state reporter; the operator owns the private state
directory and lock. Never unlink the lock, use `flock -u`, forge a token or delete owner metadata
to recover a release. Token reentry also verifies the holder's PID, start ticks, boot identity,
cwd digest, lock inode and exclusive descriptor. Unexpected holder loss leaves an unresolved
owner even when the kernel lock becomes free: independent remote work may still be alive.
Normal confirmed cleanup removes that owner. Owner and recovery records use narrow file and
directory fsync; no host-wide synchronization is needed.

## Initial installation and upgrades

Prepare exact committed `main` targets in both local repositories. Major needs exact successful
`Required` and `Analyze JavaScript and TypeScript`; Karavan needs its exact commit attestation.
Use a clean, unchanged Major release checkout containing the new connector. Finish existing
wrappers first; the installer refuses active wrappers, dirty production source or unsupported branches,
non-fast-forward targets, busy locks and application changes. It accepts only the reviewed
tooling/docs/tests slice, including `packages/contracts/test/`, and the named wrappers' admission
cleanup plumbing; runtime changes use normal releases. Major stays on `main`. Karavan may stay
on `main` or in its normal clean detached release mode; detached advancement never moves a branch.

```bash
./infra/scripts/vps-connect.sh install-pair-release-admission \
  "$MAJOR_SHA" "$KARAVAN_REPOSITORY" "$KARAVAN_SHA" maximadmin
./infra/scripts/vps-connect.sh verify-pair-release-admission maximadmin
./infra/scripts/vps-connect.sh pair-release-state
```

The connector verifies local evidence, sends thin Git bundles into a private temporary directory,
then streams the exact selected Major installer's Git bytes over stdin with a 90-second host budget.
Privileged derived files use a separate root-owned private directory, never the operator transport
directory. Verification executes the installed root-owned helper as the ordinary operator. The installer
holds both existing product locks before initial provisioning; an upgrade takes common admission
first. It verifies target source and installed floors, installs the identical helper/reporter,
and advances both clean checkouts without executing target-owned release scripts.
It never builds or changes containers, stores, services or nginx. The installed helper is
independent of the checkouts, so readback works during a tooling transition.

Do not use ordinary deploy to bootstrap an uninstalled mandatory admission. Before installing
authority or advancing source, the installer persists an owner with `mode=bootstrap` and both
exact targets. An interruption after only one checkout advances leaves that owner in place,
blocking runtime admission and installed verification. Only the same selected bootstrap may
resume, with the original process dead, both product locks held, and each clean checkout still
at its original or selected commit and original branch mode. The installer archives its owner
under `state/bootstrapped/` only after both sources and installed files verify. Do not delete
that owner, use runtime reconciliation for it, roll source back or rerun runtime publication.
Shared coordination is active only after verification passes for both source trees and installed files.

## Planning and applying a release

`pair-release-state` reads fixed bounded manifests, checkout heads and `.env` files. JSON contains
Major target/checkout identities and each component's source SHA/image ID, allowlisted completed
smoke labels, Karavan commit/origin commit/delivery mode/smoke, and configuration hashes. It never
returns environment values or raw manifests. Missing observations are `null`; unknown smoke labels
are counted in `major.unreportedSmokeCount`. The report proves recorded state, not a fresh live
health or device acceptance check.

The coordinator passes `PAIR_RELEASE_EXPECTED_STATE_SHA256=<fingerprint>` to a public release
command. Fresh common admission recomputes the fixed projection and rejects drift before either
product lock. Nested calls retain the holder's original admission proof, because the owning
release may legitimately update source/manifests afterward. After publishing the first product,
reconcile its result and retained components/configuration, then bind the fresh fingerprint for
the second step. Two releases are never an atomic transaction.

Major's ref synchronization/rollback gates retain the admission helper and dispatch; Karavan
rejects a rollback worktree that loses the same protocol before dependency installation or
production-env copy, including `--origin-only`. A failed/lost remote operation needs inspection;
admission does not authorize generic process termination, replay or rollback.

## Interrupted owner recovery

An `admission.status` of `unknown` is a gate, not permission to retry. Inspect the retained owner,
the exact target's CI/attestation and publication/configuration evidence first. A live PID with the
same start ticks and boot identity cannot be reconciled, including one that changed cwd or closed
its original descriptor. Both product locks and common admission must be free, and bounded process
observation must find no remaining release/build actor in either product checkout.

```bash
./infra/scripts/vps-connect.sh reconcile-pair-release-admission \
  "$OWNER_SHA256" "$PAIR_STATE_SHA256" "$PRODUCT" "$TARGET_SHA" \
  "$MODE" "${MAJOR_COMPONENTS:-}"
```

The installed entrypoint also works from a Karavan-only task, using the ordinary operator without sudo:

```bash
ssh maxim-vps timeout 12 bash /var/lib/major-karavan-release/admission.sh state
ssh maxim-vps timeout 20 bash /var/lib/major-karavan-release/admission.sh reconcile \
  "$OWNER_SHA256" "$PAIR_STATE_SHA256" "$PRODUCT" "$TARGET_SHA" \
  "$MODE" "${MAJOR_COMPONENTS:-}"
```

The owner pins product, mode and full target. Tooling recovery proves the exact checkout. Major
runtime recovery requires a new sealed manifest with the selected component sources/images and
all required recorded smokes; Karavan requires exact commit/origin and a new passed smoke. The
coordinator separately checks retained components, configuration and exact CI/attestation before
calling this command. Reconciliation archives the original owner plus its proof under
`state/reconciled/<owner-sha256>.*`; it never removes or unlocks the persistent inode. Source/state
drift, incomplete publication or an interrupted standalone maintenance operation without the required
outcome evidence stays blocked for a separately reviewed recovery. Never switch a runtime owner to
tooling mode or invent a manifest to make recovery pass.
