# Infrastructure Agent Notes

## Active Production Topology

- `infra/docker-compose.yml` is the main production stack. `infra/docker-compose.scale.yml` is split/load-testing only; never run both at once.
- Use `docker compose`, not the legacy standalone command.
- Production API roles share one image:
  - `api-ingress`
  - `api-admin`
  - `api-enqueue`
  - `api-moderation`
  - `api-moderation-critical`
  - `api-moderation-join`
  - `api-moderation-realtime-b`
  - `api-moderation-realtime-c`
  - `api-moderation-realtime-d`
  - `api-moderation-background`
  - `api-media-analysis`
  - `api-action`
- Public health/webhooks go to `api-ingress`; `/api/v1/` and closed owner APIs go to `api-admin`; queue roles do not own public HTTP traffic.
- `miniapp-major-static` serves `https://major-maksimov.ru/app/` on local port 3003. `miniapp-static` serves legacy support host `maxim.play-team.ru` on port 3000 and is not a routine target.
- `admin-static` serves the closed Safety Desk on local port 3004 behind `admin.major-maksimov.ru` Basic Auth.
- Current canonical user host is `https://major-maksimov.ru`; `/app/` is the only routine production mini app path.
- CDN, Object Storage, and app2 delivery are paused. Do not deploy, publish, smoke, or propose them as fallback. Historical context is non-authoritative under `docs/operations/archive/`.

## VPS Access

- Preferred local aliases, when configured: `maxim-vps` for backend deploy, `maxim-vps-edge` for the edge, and `maxim-vps-legacy` only for explicit legacy work.
- Portable setup:
  - copy `infra/env/vps.env.example` to ignored root `.env.vps`;
  - run `./infra/scripts/vps-connect.sh doctor`;
  - use `shell`, `health`, `ps`, `logs <service>`, `deploy main [services...]`, or `monitor-readonly [duration-sec] [interval-sec]`.
- `npm run vps -- <command>` and `npm run prod -- <command>` call the same wrapper.
- If SSH access changed with the client IP, `./infra/scripts/vps-connect.sh ensure-ssh` can authorize the configured `/32`/CIDR and run doctor.
- If SSH stalls before the banner, check Yandex security-group `22/tcp` reachability first and use `yc compute ssh` as the recovery path when configured.
- GitHub Actions Deploy is manual-only. Local `vps-connect.sh deploy` is the routine path unless hosted-runner SSH reachability is known to work.
- Deploy and rollback scripts run on the backend VPS. Invoke them locally only through the wrapper/SSH.
- Keep Yandex and VK Cloud credentials in ignored local files or configured CLI profiles; never print or commit service-account keys.

## Deploy And Rollback

- Host-side deploy, release, reclaim, rollback, and monitor tooling requires Node 24 on the backend VPS. Before the first manifest-aware deploy, provision `/var/lib/maxim-deploy` as a writable `0750` directory owned by the deploy user.
- Local submit: stage the intended paths, then run `./infra/scripts/local-commit-push.sh "<message>" main`. The helper is staged-only by default, runs `agent:verify --staged`, commits, and pushes the exact resulting `HEAD`; `--all` is an explicit broad-staging opt-in.
- `--all` excludes every `AGENTS.md` unless `--include-agents` is present, and already-staged agent notes are rejected without that flag.
- Local deploy: `./infra/scripts/vps-connect.sh deploy main [services|--plan|--auto|--full]`.
- Exact-SHA off-host preload: after green main CI, run `./infra/scripts/vps-connect.sh preload-ci-image <api|miniapp|admin> <sha>` for each selected component, then use the normal deploy wrapper. The helper verifies the CI run, checksum, image labels, and free capacity for the uncompressed archive plus a 4 GiB reserve; the remote load holds the shared deploy lock and never mutates containers or non-MAXIM images.
- Direct backend recovery command: `MAXIM_EXPECTED_DEPLOY_SHA=<full-reviewed-sha> ./infra/scripts/vps-pull-build-up.sh main [services...]`.
- The direct backend script does not query GitHub CI on its own. Routine operators must use the guarded local wrapper or operator-fallback workflow; treat direct invocation as a reviewed recovery path and pass the intended `MAXIM_EXPECTED_DEPLOY_SHA` explicitly.
- Immutable component rollback: `./infra/scripts/vps-connect.sh rollback-release <release-id> [api-shared|miniapp-major-static|admin-static]`. Omit components to restore all three from the selected manifest.
- API ref-based fallback rollback: `./infra/scripts/vps-connect.sh rollback-runtime <git-ref> [services...]`, backed by `vps-runtime-rollback.sh` on the VPS.
- Local deploy resolves the selected branch to an exact SHA, requires successful `Required` and `Analyze JavaScript and TypeScript` checks from GitHub Actions for that SHA, and sends it to the VPS for a post-sync `HEAD` equality check. Emergency bypass requires both `MAXIM_DEPLOY_EMERGENCY_BYPASS=1` and `MAXIM_DEPLOY_EMERGENCY_REASON`.
- VPS component selection uses `infra/scripts/lib/change-impact-components.generated.sh`, generated from `config/change-impact.json`. Regenerate it with `node scripts/agent/generate-deploy-impact-bash.mjs`; infra checks reject drift. A manifest/runtime image-ID mismatch selects the affected component fail-closed.
- Any requested API role expands to every shared-image role. Keep `infra/scripts/lib/deploy-topology.sh`, Compose services, and API runtime topology aligned.
- Active deploy images use immutable full-SHA refs: `maxim-api:<sha>`, `maxim-miniapp-major:<sha>`, and `maxim-admin:<sha>`. The shared API image is built once with `docker buildx build --load --provenance=false` and used by every API role; do not restore multi-service Compose/bake API builds.
- Before any local shared API build, the deploy tooling requires every Docker input to match `HEAD`, including root lock/manifests, workspace manifests, `.dockerignore`, API/contracts/scripts, and trusted certificates. Commit or remove input drift before deploying or running ref-based rollback; a new intentional Docker exclusion must update the guard allowlist in the same review.
- Component manifests live under `/var/lib/maxim-deploy`, retain at least five releases, and track each active component's source SHA, image ref, and image ID. Before the first migration or runtime mutation, deploy and both rollback paths atomically rename `current.json` to one typed `current.invalid-*` attempt journal; a new `current.json` is published only after image-ID verification and strict component smokes. Recovery requires explicit adoption and exactly one validated journal. Normal deploy reconciles every active component; partial rollback verifies every inherited component before mutation and commit, and an API rollback journal cannot be recovered without the API queue fence.
- Production deploys run Prisma migrations only when the shared API component is selected. Static-only mini app or Safety Desk deploys build/recreate/smoke their component without running migrations.
- Migration one-offs use `infra/docker-compose.runtime-no-build.yml` with an explicit prebuilt image and `--pull never`; `docker compose run` does not accept `--no-build` on every supported production Compose version. Runtime recreation still requires `docker compose up --no-build`.
- `rollback-release` reuses locally retained immutable images, checks recorded image IDs, force-recreates only selected component services, runs strict smokes, and records a new rollback manifest. API selection additionally requires Postgres/Redis readiness and Prisma compatibility; static-only rollback is image-only and does not require Git or database access. It does not switch Git refs, build images, or run migrations; an incomplete attempt leaves its typed transition journal in place instead of publishing false current inventory.
- `rollback-runtime` is the API-only fallback when a suitable immutable release is unavailable. It requires existing Postgres/Redis readiness, preserves the current Compose file before switching to the exact ref, checks Prisma compatibility, rebuilds the shared image, runs strict smokes, and records a partial API release manifest. It never starts/recreates stateful services and cannot restore static components; an incomplete attempt leaves the transition journal rather than a false `current.json`.
- API rollback topology follows `infra/docker-compose.yml` from the target API source SHA. Targets that predate `api-media-analysis` omit it from recreate/image verification and stop/remove the current role container. Every target that includes the role must run with effective `COMMERCIAL_OCR_ROLLOUT_MODE=shadow` and pass exact `rus`/`eng` language smokes; targets with the compiled raster-smoke capability must also pass raster recognition and internal OCR readiness before a release manifest is recorded.
- API deploy and both rollback paths derive `COMMERCIAL_OCR_VERSION` from the target source's literal `COMMERCIAL_OCR_DEFAULT_VERSION`, export it over `.env`, and fail closed unless all 12 effective and running API roles match it. During a version transition, stop the old `api-media-analysis` before updating producer roles and start it only after every other API role; immutable rollback therefore restores the recorded image's source version instead of the current checkout default.
- Deploy and both rollback paths serialize through the shared lock. Rebuild only affected application components. Ordinary API deploy requires Postgres and Redis to be already running and ready; it refuses instead of starting or recreating them.
- Every shared API image transition, including both rollback paths, must keep the append-only webhook queue registry globally paused across the mixed-version window: acquire a Redis owner token, pause all current/target queues through the one-off control container, stop `api-enqueue`, drain BullMQ active work and live detached timeout quarantines, stop all moderation roles, recreate non-webhook roles before moderation/enqueue, verify every API role on the exact image, pass ingress/admin live smokes, then compare-and-resume. A failed or interrupted transition leaves the owner/pause fence in place; never resume until the full exact-image fence is proven. To continue a reviewed interrupted transition, set `MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1` on the normal `vps-connect.sh` deploy or rollback invocation; this performs an explicit owner-token takeover and must never be persisted in production env. Recovery without `current.json` additionally requires exactly one validated typed transition journal; API or legacy/ambiguous journals can be consumed only by a path that re-proves the API queue fence.
- Production Commercial OCR remains `shadow` unless a real independently adjudicated, production-temporal schema-v2 corpus passes the active gates and yields a fresh valid Ed25519-signed certificate for the exact source/image. Schema v1, synthetic/public data, an unreviewed corpus, an unsigned/untrusted certificate, or operational metrics alone can never authorize deletion.
- Keep the Ed25519 approval private key owner-only and off the eval host, VPS, repository, containers, `.env`, arguments, logs, reports, requests, and certification artifacts. Run evaluation in an ephemeral no-secret environment, freeze and independently review its exact request SHA-256, destroy that environment, then use the separate sign-only CLI on a trusted host/principal. Production receives only `COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64`, the canonical base64 of the matching Ed25519 DER SPKI public key. Missing, malformed, rotated, or mismatched trust fails promotion closed and requires a newly signed certificate.
- Native promotion remains blocked while Sharp/libvips/Tesseract execute in the secret-bearing networked `api-media-analysis` container or direct-PID termination cannot prove descendant cleanup. Keep `shadow` until a no-network/no-secret sandbox or sidecar provides bounded IPC, cgroup limits, and verified process-group teardown, then re-evaluate and re-certify the resulting native identity.
- Guarded promotion syntax is `./infra/scripts/vps-connect.sh commercial-ocr-promote <chat-ids-file> <certification-file> <reviewed-certification-sha256> <none|revision> [--apply]`. The third argument must be the lowercase digest independently approved after the exact certificate bytes were frozen, not an inline digest derived during the promotion invocation. The wrapper recomputes it locally before transfer. Use `commercial-ocr-status` for privacy-safe revision/TTL inspection, `commercial-ocr-downgrade <revision> [--apply]` to clear authority, and `commercial-ocr-recover-shadow [--apply]` only for environment-only emergency reconcile; mutations are previews without `--apply`.
- Promotion transfers bounded certification/cohort files through framed stdin, verifies the signature and independent digest inside the exact active image, and binds the runtime control to `certificationSha256`, `certificationExpiresAt`, unique sorted `certifiedSettingsFingerprints`, and `certifiedSettingsFingerprintSetSha256`; the control expiry cannot exceed the certification expiry. Current chat settings must match a certified fingerprint at intent commit and execution; the final OCR guard re-reads settings/admin/timezone and the same control revision/expiry after MAX/content/immunity checks. Missing/legacy/invalid/expired/unreadable controls, uncertified settings, changed bindings, or transient unknown state perform no delete.
- OCR rollout commands share the deploy lock, reject unreviewed running API containers, verify the current release fence plus identity/parity/restart stability of all 12 roles, and recreate `api-media-analysis` last. HTTP readiness applies only to `api-ingress`, `api-admin`, and `api-media-analysis`; the other nine roles are headless and are fenced by exact running-container identity and restart stability. Applied promotion stops the exact seven moderation producer roles before its absolute-deadline queue/admission drain and control CAS, then restarts them and re-verifies all roles. Recovery must prove action/producers stopped before environment mutation or recreation; applied emergency recovery attempts that quiescence before its exact release fence and performs no recreation if fencing fails. Ambiguous set/clear outcomes best-effort reconcile every environment ceiling to shadow and prove enforcement-capable roles stopped again unless full recovery succeeds. Never replace this with manual `.env` edits or print certification/cohort/control JSON, private keys, or audit text.
- Destructive DB column removal requires the API client-compatible release first and the drop migration in a later release.
- The VPS is shared with sibling applications. Check for another Docker build before heavy work and avoid overlapping builds.
- Normal deploy, runtime rollback, and scale deploy share component-aware disk floors: a clean shared API build requires at least 20 GiB free on `/var/lib/docker`, while a static-only build requires 6 GiB; mixed builds use the higher floor. Normal deploy may skip the build-capacity gate only when every selected ref is the verified target SHA and already exists locally; that rollout is reuse-only and refuses a fallback build if an image disappears. `MAXIM_DEPLOY_DISK_MIN_FREE_BYTES` may raise but never lower the selected floor, and the percentage emergency override does not bypass it.
- If disk preflight blocks, review inventory and run `./infra/scripts/vps-docker-space-reclaim.sh` first. It preserves every image referenced by retained manifests or any container and removes only old unused immutable MAXIM release refs. It leaves shared build cache, volumes, containers, and unrelated images untouched; host-wide Docker GC requires a separately reviewed maintenance plan.

## Required Smokes

- After runtime deploy:
  - check local `http://127.0.0.1:3001/api/health/live` and `/ready`;
  - check local port 3002 live/ready when `api-admin` changed;
  - check public `https://major-maksimov.ru/api/health/live` only; public ready is intentionally hidden;
  - check `https://major-maksimov.ru/app/` when mini app flows changed;
  - check local port 3004 when Safety Desk changed.
- API ready may recover after live while queues drain; observe the recovery window before declaring regression.
- If Major `/app/` returns 502, inspect `miniapp-major-static`, not `miniapp-static`.
- `monitor-readonly` samples health, Compose state/restarts, canonical `/app/`, and filtered role logs without reconciling webhooks or sending bot messages.
- Read-only monitor keyword scans must discard successful 2xx/3xx access-log lines before matching words such as `error`, `failed`, or `denied` in asset names.

## Environment And Git Safety

- Production `.env` is dotenv, not shell; values can contain unquoted spaces. Read individual keys or container environment and never print secret values.
- If `/var/www/Chat_bot/.env` is missing, current deploy scripts restore it from a running role container, with `infra-api-1` only as legacy fallback.
- If `git pull --ff-only` is blocked by a dirty VPS tree:
  - stash/pull/drop is acceptable only when tracked content already matches `origin/<branch>`;
  - stop if local tracked changes differ from origin.
- If local GitHub access is blocked but the VPS can reach it, first verify remote repo SHA/status. The VPS deploy key may push the repo, but never print/copy its private material.

## Nginx And Edge

- Closed Safety Desk/support APIs use same-origin `admin.major-maksimov.ru/api/v1/...`, proxied to `api-admin` with `X-Forwarded-Host` and Basic Auth `X-Remote-User` checks.
- Public sites must deny `/api/v1/safety-desk` and `/api/v1/support-requests` before generic `/api/v1/` proxy rules.
- Apply admin nginx changes separately with `./infra/scripts/vps-apply-major-admin-site.sh maxim-vps` after review.
- Nginx `add_header` inheritance stops when a location defines any local header. Locations with local `add_header` directives must repeat the full security-header set, and site apply scripts must keep their EXIT rollback guard armed until localhost/SNI route and header smokes pass.
- Before applying `infra/nginx/maxim.play-team.ru.conf`, compare the live backend site: it may contain sibling routes such as `reshenie` and `karavan` that must not be removed.
- Never keep nginx backups in `/etc/nginx/sites-enabled`; nginx parses every file there. Store backups outside included directories before `nginx -t`.
- `maxim.play-team.ru` enters through Yandex edge `maxim-site-edge-1` and TCP HAProxy to the backend private address. Deploy/rollback still run on `maxim-vps`, not the edge.
- Edge HAProxy passes TLS through. Its TCP timeouts cover the longest public request; path-specific exceptions belong at backend nginx.
- Keep protected edge `eth0` MTU at 1450 (TCP MSS 1410 expectation) when changing network config.
- The `maxim.play-team.ru` certificate lineage covers only `maxim.play-team.ru` and `hook.maxim.play-team.ru`; do not add `www` without DNS/nginx support because NXDOMAIN breaks renewal.
- `app.major-maksimov.ru` redirects to canonical `major-maksimov.ru`; keep the public root free of internal infrastructure details.

## Postgres And Redis

- Keep Postgres `shm_size` comfortably above `shared_buffers` (currently 512m versus 128MB). Reducing it can trigger `53100` errors under admin/suggestion load.
- Keep production Prisma pool caps aligned with `apps/api/src/config/production-compose-prisma-pool.spec.ts`. Prefer lower concurrency/batches and governor controls before raising connection caps.
- Live audits use indexed, bounded queries and short samples. Broad `webhook_events`/ledger aggregates can saturate I/O despite connection headroom.
- Full backup and restore-smoke timers are disabled by default. Configure `/etc/maxim-postgres-backup.env` with separate persistent/disposable volumes and enough capacity, then run each service successfully before enabling timers.
- Never place a full restore in Docker's production root filesystem.
- Redis persists BullMQ queues, delayed jobs, locks, and snapshots in named `redis_data:/data`. Avoid routine recreation; preserve/check RDB/AOF and queues first.
- Scale deploy preflights `infra-scale_redis_data` before stopping main.
- After a Redis restore/merge, audit schedule queues before workers start. Rebuild future `night-mode-transitions` from DB rather than restoring stale due jobs; require empty wait/active/failed and `delayed_due_now=0`, with persisted `NIGHT_MODE_CLOSE_NOTICE` as idempotency source.
