# Production Runbook

This is the active production entrypoint. Historical delivery/cloud experiments under
`docs/operations/archive/` are non-authoritative.

## Production Shape

- Main stack: `infra/docker-compose.yml` with Postgres, Redis, eleven shared-image API roles,
  `miniapp-major-static`, legacy support `miniapp-static`, and `admin-static`.
- Canonical mini app: `https://major-maksimov.ru/app/`, served by `miniapp-major-static`.
- Closed Safety Desk: `https://admin.major-maksimov.ru/`, served by `admin-static` behind Basic Auth.
- Public health/webhooks terminate at `api-ingress`; `/api/v1/` and owner APIs terminate at
  `api-admin`.
- CDN, Object Storage, and app2 are not production deploy or smoke targets.

## First Deployment

1. On the VPS, create root `.env` from `.env.example` and set real database, MAX, webhook, admin,
   and security values. Treat it as dotenv, not a shell script.
2. On the operator machine, create ignored `.env.vps` from `infra/env/vps.env.example` and configure
   the SSH target/repository path.
3. Verify access:

   ```bash
   ./infra/scripts/vps-connect.sh doctor
   ```

4. Deploy the default production set:

   ```bash
   ./infra/scripts/vps-connect.sh deploy main
   ```

   The local wrapper requires successful `Required` and `Analyze JavaScript and TypeScript` checks
   from GitHub Actions for the exact local commit and requires the synchronized VPS `HEAD` to match that SHA. The default set builds the shared API
   image once, applies Prisma migrations, builds both active static components, force-recreates the
   application containers, and runs strict health/smoke checks before recording the release.

5. Let the ingress reconciler create MAX webhook subscriptions from `MAX_WEBHOOK_BASE_URL`. The
   canonical webhook shape is
   `https://major-maksimov.ru/api/webhook/max/<bot-id>/<MAX_WEBHOOK_SECRET_PATH>`.

Run
`MAXIM_EXPECTED_DEPLOY_SHA=<full-reviewed-sha> ./infra/scripts/vps-pull-build-up.sh main [services...]`
directly only from the backend VPS. That low-level script does not query GitHub CI by itself, so
routine operators use the guarded local wrapper or the acknowledged operator-fallback workflow. A
mutating direct invocation without the expected full SHA is rejected; only `--plan` may omit it.

## Routine Access

```bash
./infra/scripts/vps-connect.sh shell
./infra/scripts/vps-connect.sh health
./infra/scripts/vps-connect.sh ps
./infra/scripts/vps-connect.sh logs api-ingress
./infra/scripts/vps-connect.sh monitor-readonly 300 15
```

`npm run vps -- <command>` and `npm run prod -- <command>` call the same wrapper.

If direct SSH is blocked after an IP change and Yandex security-group configuration is present:

```bash
./infra/scripts/vps-connect.sh ensure-ssh
```

## Submit And Deploy Gate

The submit helper is staged-only by default. Stage the intended paths, then run:

```bash
git add --patch
./infra/scripts/local-commit-push.sh "describe the change" main
```

It runs staged-impact validation, commits, and pushes the exact resulting `HEAD`. `--all` is an
explicit broad-staging option. All root/scoped `AGENTS.md` files are excluded from `--all` unless
`--include-agents` is present, and the helper refuses already-staged agent notes without that flag.

The routine local deploy path resolves the requested branch to a full SHA and queries GitHub for
successful `Required` and `Analyze JavaScript and TypeScript` checks from GitHub Actions on that exact commit. The same SHA is passed to the VPS, which refuses
the rollout if its post-sync `HEAD` differs. An emergency bypass is not routine: it requires both
`MAXIM_DEPLOY_EMERGENCY_BYPASS=1` and a non-empty `MAXIM_DEPLOY_EMERGENCY_REASON`.

## Focused Deployment

```bash
# Read the manifest-based component plan without deploying
./infra/scripts/vps-connect.sh deploy main --plan

# Deploy every component selected since its recorded source SHA
./infra/scripts/vps-connect.sh deploy main --auto

# Canonical mini app only
./infra/scripts/vps-connect.sh deploy main miniapp-major-static

# Closed Safety Desk UI only
./infra/scripts/vps-connect.sh deploy main admin-static

# Any API role request expands to every shared-image API role
./infra/scripts/vps-connect.sh deploy main api-ingress
```

Contract changes normally require all API roles plus affected public/admin clients. Do not deploy
`miniapp-static` for ordinary Major work.

Any API role expands to all eleven roles. Static-only `miniapp-major-static` or `admin-static`
deploys do not start the API build or run Prisma migrations. The deploy compares each active
component's recorded source SHA with the target and adds unreleased affected components, so an
explicit service list cannot silently leave known component impact behind.

Nginx site changes are applied separately after config review. For the closed admin site:

```bash
./infra/scripts/vps-apply-major-admin-site.sh maxim-vps
```

Before applying `maxim.play-team.ru` nginx config, compare it with the live backend file because
sibling application routes may exist there.

## Health And Smoke Checks

- Local ingress live: `http://127.0.0.1:3001/api/health/live`
- Local ingress ready: `http://127.0.0.1:3001/api/health/ready`
- Local admin live/ready: the same paths on `127.0.0.1:3002`
- Public live: `https://major-maksimov.ru/api/health/live`
- Canonical mini app: `https://major-maksimov.ru/app/`
- Local Safety Desk static: `http://127.0.0.1:3004/`

Public `/api/health/ready` is intentionally hidden. During API rollout, ready can recover later than
live while queues drain; observe it before declaring failure.

## Release Inventory

Active release components are `api-shared`, `miniapp-major-static`, and `admin-static`. Successful
builds use full-SHA image refs (`maxim-api`, `maxim-miniapp-major`, or `maxim-admin` plus the full Git
SHA tag). The default inventory under `/var/lib/maxim-deploy` stores each component's source SHA,
image ref, and exact Docker image ID, together with applied migrations and successful smokes.

Unchanged component records carry forward into the next manifest. `current.json` is replaced
atomically only after every selected service runs the expected image ID and all selected strict
smokes pass. A failed build, recreate, or smoke therefore does not promote the candidate release.
At least five release manifests are retained.

Inspect the current manifest and retained IDs from the operator machine:

```bash
./infra/scripts/vps-connect.sh exec 'node infra/scripts/release-manifest.mjs show current'
./infra/scripts/vps-connect.sh exec 'ls -1 /var/lib/maxim-deploy/releases'
```

## Immutable Release Rollback

Prefer a retained immutable release over rebuilding an old ref. Omit component names to restore all
three active components, or name any subset of `api-shared`, `miniapp-major-static`, and
`admin-static`:

```bash
: "${RELEASE_ID:?Set RELEASE_ID to a retained release manifest id}"
./infra/scripts/vps-connect.sh rollback-release "$RELEASE_ID" miniapp-major-static
```

The rollback refuses unknown/mutable component records, missing local images, and image-ID
mismatches. When `api-shared` is selected it also requires the recorded API source commit, existing
Postgres/Redis readiness, and every already-applied Prisma migration. A static-only rollback needs
only the retained image and recorded image ID; it does not depend on Git or database availability.
The script force-recreates only selected component services, verifies their image IDs, runs strict
API/Major/Safety Desk smokes as applicable, and records a new current rollback manifest.

This path does not switch the VPS Git checkout, build an image, or run Prisma migrations. If an
attempt mutates a service but does not record the rollback manifest, it invalidates stale
`current.json` inventory. If any preflight or smoke fails, stop and investigate; do not replace the
recorded image or bypass the compatibility check.

## API Ref-Based Fallback Rollback

Use the ref-based helper only when no suitable retained immutable API release exists. It supports API
runtime roles only:

```bash
ROLLBACK_REF="${ROLLBACK_REF:?Set ROLLBACK_REF to a compatible Git ref}"
./infra/scripts/vps-connect.sh rollback-runtime "$ROLLBACK_REF"
```

It requires the current Postgres and Redis services to be running and ready, then checks that the
target contains all Prisma migrations already applied. Before switching the VPS checkout it
preserves the current Compose file and release/smoke helpers, so historical Compose cannot recreate
stateful services. It builds a SHA-scoped shared API image, runs the API migration command,
recreates all API roles by default, verifies image IDs, runs strict health checks, and records the
rolled-back API component in a new release manifest. It cannot restore either static component. If
an attempt changes runtime but does not reach a recorded manifest, stale `current.json` inventory is
invalidated so the next deploy fails closed. Do not use `deploy main` as a substitute for rolling
back a selected ref.

If migration compatibility fails, stop and prepare an explicit database/runtime recovery plan. Do
not bypass the preflight or attempt an ad hoc destructive migration rollback.

## Stateful-Service Safety

- Do not recreate Postgres or Redis during ordinary application deployment.
- API deploy requires both services to be already running and ready; it fails closed instead of
  starting either service.
- Use indexed, bounded production queries; avoid broad webhook/ledger aggregates during incidents.
- After any Redis data restore, audit delayed/waiting/active/failed queues before starting workers.
- Backup/restore timers remain disabled until their separate volumes and capacity preflights have
  completed successfully.

## Docker Space Reclaim

Run `./infra/scripts/vps-docker-space-reclaim.sh` only after reviewing disk and release inventory.
The helper holds the deploy lock, validates every retained manifest, preserves image IDs/refs from
those manifests and every container, and removes only old unused immutable MAXIM release refs. It
then prunes old BuildKit cache. It does not run a generic image, container, or volume prune.

The 20 GiB deploy build-capacity floor remains mandatory whenever any selected component image is
absent. A deploy may skip that gate only when every selected local image ref exactly matches the
verified target commit (`maxim-api:<sha>`, `maxim-miniapp-major:<sha>`, and/or `maxim-admin:<sha>`).
The script then runs in reuse-only mode: runtime recreation uses `--no-build`, and a target image
that disappears after the preflight aborts the rollout instead of falling back to a build. Manual,
full, mixed API/static, missing-image, wrong-SHA, and unknown targets receive no mode-based bypass;
each selected exact image must be present. This exception does not remove images or volumes and
does not alter retained release manifests.
