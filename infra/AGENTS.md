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
  - `api-publisher`
- `ocr-native-sandbox` is an auxiliary of the shared API image, not a fourteenth API role. It has
  no network, API identity, runtime env file, or secrets and is reachable only from
  `api-media-analysis` through the project-scoped `ocr_native_ipc` Unix-socket volume.
- Public health/webhooks go to `api-ingress`; `/api/v1/` and closed owner APIs go to `api-admin`; queue roles do not own public HTTP traffic.
- The domain-separated Publisher dialog signing key is mounted only in `api-admin`, `api-action`, and `api-publisher`. Keep the Publisher bot token exclusive to `api-publisher` and init-data verification keys exclusive to `api-admin`.
- `miniapp-major-static` serves `https://major-maksimov.ru/app/` on local port 3003. `miniapp-static` serves legacy support host `maxim.play-team.ru` on port 3000 and is not a routine target.
- `admin-static` serves the closed Safety Desk on local port 3004 behind `admin.major-maksimov.ru` Basic Auth.
- Current canonical user host is `https://major-maksimov.ru`; `/app/` is the only routine production mini app path.
- CDN, Object Storage, and app2 delivery are paused. Do not deploy, publish, smoke, or propose them as fallback. Historical context is non-authoritative under `docs/operations/archive/`.

## VPS Access

- Preferred local aliases, when configured: `maxim-vps` for backend deploy, `maxim-vps-edge` for the edge, and `maxim-vps-legacy` only for explicit legacy work.
- Portable setup:
  - copy `infra/env/vps.env.example` to ignored root `.env.vps`;
  - run `./infra/scripts/vps-connect.sh doctor`;
  - use `health`, `ps`, `logs <service>`, `deploy main [services...]`, `monitor-readonly [duration-sec] [interval-sec]`, or `postgres-audit [queue|activity|duplicate|all]`.
- Interactive `shell` is break-glass, not routine access. It requires caller-only `MAXIM_VPS_DATABASE_BREAK_GLASS=1` and a non-empty `MAXIM_VPS_DATABASE_BREAK_GLASS_REASON`; never persist either value in `.env.vps`.
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
- Exact-runtime manifest recovery: `./infra/scripts/vps-connect.sh finalize-release-recovery main`. Use
  it only after an interrupted transition already left all 13 API roles and both active static
  services running the green exact target SHA with the webhook queue fence fully released. It
  performs no build, migration, or container recreation.
- Exact-SHA off-host preload: after green main CI, run `./infra/scripts/vps-connect.sh preload-ci-image <api|miniapp|admin> <sha>` for each selected component, then use the normal deploy wrapper. The helper verifies the CI run, checksum, image labels, and free capacity for the uncompressed archive plus a 4 GiB reserve; the remote load holds the shared deploy lock and never mutates containers or non-MAXIM images.
- Direct backend recovery command: `MAXIM_EXPECTED_DEPLOY_SHA=<full-reviewed-sha> ./infra/scripts/vps-pull-build-up.sh main [services...]`.
- The direct backend script does not query GitHub CI on its own. Routine operators must use the guarded local wrapper or operator-fallback workflow; treat direct invocation as a reviewed recovery path and pass the intended `MAXIM_EXPECTED_DEPLOY_SHA` explicitly.
- Immutable component rollback: `./infra/scripts/vps-connect.sh rollback-release <release-id> [api-shared|miniapp-major-static|admin-static]`. Omit components to restore all three from the selected manifest.
- API ref-based fallback rollback: `./infra/scripts/vps-connect.sh rollback-runtime <git-ref> [services...]`, backed by `vps-runtime-rollback.sh` on the VPS.
- Local deploy resolves the selected branch to an exact SHA, requires successful `Required` and `Analyze JavaScript and TypeScript` checks from GitHub Actions for that SHA, and sends it to the VPS for a post-sync `HEAD` equality check. Emergency bypass requires both `MAXIM_DEPLOY_EMERGENCY_BYPASS=1` and `MAXIM_DEPLOY_EMERGENCY_REASON`.
- VPS component selection uses `infra/scripts/lib/change-impact-components.generated.sh`, generated from `config/change-impact.json`. Regenerate it with `node scripts/agent/generate-deploy-impact-bash.mjs`; infra checks reject drift. A manifest/runtime image-ID mismatch selects the affected component fail-closed.
- Any requested API role expands to every shared-image role and reconciles the OCR sandbox auxiliary when its image declares that capability. Keep `infra/scripts/lib/deploy-topology.sh`, Compose services, and API runtime topology aligned without adding the auxiliary to the 13-role list.
- Active deploy images use immutable full-SHA refs: `maxim-api:<sha>`, `maxim-miniapp-major:<sha>`, and `maxim-admin:<sha>`. The shared API image is built once with `docker buildx build --load --provenance=false` and used by every API role; do not restore multi-service Compose/bake API builds.
- Before any local shared API build, the deploy tooling requires every Docker input to match `HEAD`, including root lock/manifests, workspace manifests, `.dockerignore`, API/contracts/scripts, and trusted certificates. Commit or remove input drift before deploying or running ref-based rollback; a new intentional Docker exclusion must update the guard allowlist in the same review.
- Component manifests live under `/var/lib/maxim-deploy`, retain at least five releases, and track each active component's source SHA, image ref, and image ID. Before the first migration or runtime mutation, deploy and both rollback paths atomically rename `current.json` to one typed `current.invalid-*` attempt journal; a new `current.json` is published only after image-ID verification and strict component smokes. Recovery requires explicit adoption and exactly one validated journal. Normal deploy reconciles every active component; partial rollback verifies every inherited component before mutation and commit, and an API rollback journal cannot be recovered without the API queue fence.
- The recovery finalizer is the only no-recreate path for an already-converged exact-SHA runtime. It
  requires green exact-SHA CI, a synchronized clean VPS checkout, the shared deploy lock, exactly
  one complete typed transition journal, exact refs and image IDs for every active component, two
  stable runtime/queue-fence observations, a bounded read-only snapshot of successful Prisma
  migrations, and strict API/static/OCR smokes before committing `current.json` and archiving the
  journal. A paused queue, owner key, failed smoke, runtime restart, current manifest, or ambiguous
  journal aborts without recording recovery.
- Production deploys run Prisma migrations only when the shared API component is selected. Static-only mini app or Safety Desk deploys build/recreate/smoke their component without running migrations.
- Migration one-offs use `infra/docker-compose.runtime-no-build.yml` with an explicit prebuilt image and `--pull never`; `docker compose run` does not accept `--no-build` on every supported production Compose version. Runtime recreation still requires `docker compose up --no-build`.
- `rollback-release` reuses locally retained immutable images, checks recorded image IDs, force-recreates only selected component services, runs strict smokes, and records a new rollback manifest. API selection additionally requires Postgres/Redis readiness and Prisma compatibility; static-only rollback is image-only and does not require Git or database access. It does not switch Git refs, build images, or run migrations; an incomplete attempt leaves its typed transition journal in place instead of publishing false current inventory.
- `rollback-runtime` is the API-only fallback when a suitable immutable release is unavailable. It requires existing Postgres/Redis readiness, preserves the current Compose file before switching to the exact ref, checks Prisma compatibility, rebuilds the shared image, runs strict smokes, and records a partial API release manifest. It never starts/recreates stateful services and cannot restore static components; an incomplete attempt leaves the transition journal rather than a false `current.json`.
- API rollback topology follows `infra/docker-compose.yml` from the target API source SHA. Targets that predate `api-media-analysis` omit it from recreate/image verification and stop/remove the current role container. Targets that predate `ocr-native-sandbox` remove the auxiliary and use only the legacy smoke branch. Every target that includes the role must run with effective `COMMERCIAL_OCR_ROLLOUT_MODE=shadow` and pass exact `rus`/`eng` language smokes; sandbox-capable targets must also pass isolation, UDS raster recognition, and internal OCR readiness before a release manifest is recorded.
- API deploy and both rollback paths derive `COMMERCIAL_OCR_VERSION` from the target source's literal `COMMERCIAL_OCR_DEFAULT_VERSION`, export it over `.env`, and fail closed unless all 13 effective and running API roles match it. During a version transition, stop old `api-media-analysis` before the sandbox, recreate and attest the target sandbox before media analysis, and only then start producer roles; immutable rollback therefore restores the recorded image's source version and native boundary instead of the current checkout default.
- Both API rollback paths have an irreversible source floor at image-text stop-list binding v1 and its `api-action` pre-dispatch guard. Pending OCR delete intents can outlive an environment downgrade, so never permit rollback to a target without that exact guard, even when the current image-text rollout ceiling is `shadow`.
- Deploy and both rollback paths serialize through the shared lock. Rebuild only affected application components. Ordinary API deploy requires Postgres and Redis to be already running and ready; it refuses instead of starting or recreating them.
- Every shared API image transition, including both rollback paths, must keep the append-only webhook queue registry globally paused across the mixed-version window: acquire a Redis owner token, pause all current/target queues through the one-off control container, stop `api-enqueue`, drain BullMQ active work and live detached timeout quarantines, stop all moderation roles, recreate non-webhook roles before moderation/enqueue, verify every API role on the exact image, pass ingress/admin live smokes, then compare-and-resume. A failed or interrupted transition leaves the owner/pause fence in place; never resume until the full exact-image fence is proven. To continue a reviewed interrupted transition, set `MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1` on the normal `vps-connect.sh` deploy or rollback invocation; this performs an explicit owner-token takeover and must never be persisted in production env. Recovery without `current.json` additionally requires exactly one validated typed transition journal; API or legacy/ambiguous journals can be consumed only by a path that re-proves the API queue fence.
- Production Commercial OCR remains `shadow` unless a real independently adjudicated, production-temporal schema-v2 corpus passes the active gates and yields a fresh valid Ed25519-signed certificate for the exact source/image. Schema v1, synthetic/public data, an unreviewed corpus, an unsigned/untrusted certificate, or operational metrics alone can never authorize deletion.
- Keep the Ed25519 approval private key owner-only and off the eval host, VPS, repository, containers, `.env`, arguments, logs, reports, requests, and certification artifacts. Run evaluation in an ephemeral no-secret environment, freeze and independently review its exact request SHA-256, destroy that environment, then use the separate sign-only CLI on a trusted host/principal. Production receives only `COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64`, the canonical base64 of the matching Ed25519 DER SPKI public key. Missing, malformed, rotated, or mismatched trust fails promotion closed and requires a newly signed certificate.
- Sharp/libvips/Tesseract execute only in the no-network/no-secret `ocr-native-sandbox`. Keep its exclusive bounded UDS volume, exact safe environment, cgroup limits, non-root read-only container, verified normal process-group teardown, and whole-container recycle after every forced native timeout or abandoned in-flight native operation intact. Run the one-off media-to-sandbox raster smoke before starting the media worker or releasing producers. This removes the old structural blocker but does not authorize promotion: keep `shadow` until the sandbox-backed native identity is re-evaluated and freshly certified.
- Guarded promotion syntax is `./infra/scripts/vps-connect.sh commercial-ocr-promote <chat-ids-file> <certification-file> <reviewed-certification-sha256> <none|revision> [--apply]`. The third argument must be the lowercase digest independently approved after the exact certificate bytes were frozen, not an inline digest derived during the promotion invocation. The wrapper recomputes it locally before transfer. Use `commercial-ocr-status` for privacy-safe revision/TTL inspection, `commercial-ocr-downgrade <revision> [--apply]` to clear authority, and `commercial-ocr-recover-shadow [--apply]` only for environment-only emergency reconcile; mutations are previews without `--apply`.
- Promotion transfers bounded certification/cohort files through framed stdin, verifies the signature and independent digest inside the exact active image, and binds the runtime control to `certificationSha256`, `certificationExpiresAt`, unique sorted `certifiedSettingsFingerprints`, and `certifiedSettingsFingerprintSetSha256`; the control expiry cannot exceed the certification expiry. Current chat settings must match a certified fingerprint at intent commit and execution; the final OCR guard re-reads settings/admin/timezone and the same control revision/expiry after MAX/content/immunity checks. Missing/legacy/invalid/expired/unreadable controls, uncertified settings, changed bindings, or transient unknown state perform no delete.
- OCR rollout commands share the deploy lock, reject unreviewed running API containers, verify the current release fence plus identity/parity/restart stability of all 13 roles and the separate sandbox auxiliary, and recreate `api-media-analysis` last while retaining the already-attested sandbox for env-only rollouts. HTTP readiness applies only to `api-ingress`, `api-admin`, and `api-media-analysis`; the other ten roles are headless and the sandbox uses Docker health plus exact isolation/image/restart fencing. Applied promotion stops the exact seven moderation producer roles before its absolute-deadline queue/admission drain and control CAS, then restarts them and re-verifies all roles. Recovery must prove action/producers stopped before environment mutation or recreation; applied emergency recovery attempts that quiescence before its exact release fence and performs no recreation if fencing fails. Ambiguous set/clear outcomes best-effort reconcile every environment ceiling to shadow and prove enforcement-capable roles stopped again unless full recovery succeeds. Never replace this with manual `.env` edits or print certification/cohort/control JSON, private keys, or audit text.
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
  - for sandbox-capable API releases, require one healthy `ocr-native-sandbox` on the exact API
    image, exact no-network/no-secret runtime attestation, and the media-to-sandbox UDS raster smoke.
- API ready may recover after live while queues drain; observe the recovery window before declaring regression.
- If Major `/app/` returns 502, inspect `miniapp-major-static`, not `miniapp-static`.
- `monitor-readonly` samples health, Compose state/restarts, canonical `/app/`, and filtered role logs without reconciling webhooks or sending bot messages.
- `monitor-readonly` runs one lifecycle-bound lightweight capacity sampler on an independent cadence alongside the heavier full diagnostics and archives only allowlisted capacity/readiness/queue-fence scalars, arithmetic-validated aggregate action-health counters, and identifier-free API fleet counts under the operator's local XDG state directory. Fleet health derives its expected topology from the release component's source Compose (normally 13 roles; supported pre-Publisher/OCR rollbacks have 11 or 12), then requires exact `APP_SERVICE_NAME`/`APP_ROLE` mapping, protected image label, owned Compose container name, manifest image identity, singleton/running state, zero duplicates, and zero unexpected main, scale, or manual/foreign MAXIM API containers; restart totals are reported separately. When the source Compose declares `ocr-native-sandbox`, the sampler additionally requires exactly one healthy, same-image, no-network auxiliary with its complete safe environment and cgroup/mount boundary, without changing API role counts. The remote classifier may inspect bounded Docker metadata and only the allowlisted runtime identity keys, but only count aggregates split by main/scale/manual may leave the probe. Unrelated sibling-project API containers without a MAXIM runtime/image/protected/name signal are ignored. Never archive env values, container names or IDs, image refs, SHA values, or per-role names. Keep `MAXIM_MONITOR_CAPACITY_INTERVAL_SEC` between 15 and 60 seconds so the two-/five-minute alert windows remain continuous. The top-level monitor owns and reaps the isolated diagnostic worker, capacity sampler, and log `tee`; none may inherit the full-monitor lock. The sampler must never overlap itself, and archive writes stay serialized by their dedicated lock. The system-mode `condition` and readiness `softWarningCode` enums may be archived, but free-form reasons must not be. The private hourly JSONL archive is atomically replaced, capped at 240 records/hour, and rotated after 14 days; it must never receive raw monitor logs, request data, identifiers, URLs, payloads, or secrets.
- Treat the full `monitor-readonly` stream as sensitive: its default `0600` random local file is removed on exit. Retention requires an explicit new absolute `MAXIM_MONITOR_LOG` path in an existing owner-private directory; never follow or overwrite an existing target, and remove the retained log after the reviewed incident.
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
- Run routine production database diagnostics only through `./infra/scripts/vps-connect.sh postgres-audit [queue|activity|duplicate|all]`. The catalog accepts no SQL, file path, or stdin from the operator and runs through the bounded audit role/session. The `duplicate` report uses only identifier-free aggregates from capped index walks and exact column grants; after synchronizing a catalog change, re-run the reviewed audit-role provision step before using `duplicate` or `all`.
- Never pass ad hoc SQL or raw `psql`/`pg_dump`/`pg_restore` through `vps-connect.sh exec` or an agent shell. Reviewed human break-glass use requires caller-only `MAXIM_VPS_DATABASE_BREAK_GLASS=1` plus a non-empty `MAXIM_VPS_DATABASE_BREAK_GLASS_REASON`; the privileged SSH/Docker principal is not a database safety boundary.
- Production audit queries stay read-only, output-bounded, index-compatible, single-session, and guarded by server and wall-clock timeouts, `max_parallel_workers_per_gather=0`, a unique `application_name`, and exact-backend cleanup. `LIMIT` does not bound the scan or sort required to find rows. Use plain `EXPLAIN`, never `EXPLAIN ANALYZE`, for a new live query shape.
- Never run whole-table `COUNT`, `DISTINCT`, `GROUP BY`, JSON `OR`/`IN`, or unbounded ordering over `webhook_events`, `audit_logs`, delivery, or ledger tables on the sole primary. Prefer health snapshots and fixed catalog reports. Add a reviewed catalog query when existing reports are insufficient.
- Full backup and restore-smoke timers are disabled by default. Configure `/etc/maxim-postgres-backup.env` with separate persistent/disposable volumes and enough capacity, then run each service successfully before enabling timers.
- On the current VPS, the persistent MAXIM backup root is `/mnt/maxim-cold/backups/maxim` and the disposable restore root is `/mnt/maxim-cold/restore-smoke/maxim`; keep both on the dedicated cold filesystem. The backup service may run as `maximadmin`, but the restore-smoke service must run as `root` because the disposable PostgreSQL container creates root-owned host files that otherwise survive cleanup.
- Operator copies use `infra/scripts/pull-latest-backup-to-local.sh` with age-encrypted `.age`, `.sha256`, and `.ack` pairs. Its remote ACK fast path trusts only a canonical sidecar plus size/publication metadata; any new or changed candidate falls back to full sidecar/content verification in `pull-backup-to-local.sh`. The local scheduler lock is an advisory `flock` file descriptor, so an interrupted task cannot leave a stale lock.
- A direct live PostgreSQL stream is a reviewed maintenance path, not an unattended timer on the sole primary: require the readiness guard, low I/O priority, a unique `application_name` cleanup path, and an external lag watchdog; a standby or an approved maintenance window is required before replacing the cold-volume producer.
- PostgreSQL backup and deploy/rollback/preload operations serialize through the shared deploy lock. Keep backup readiness-gated, rate-limited, low-priority, time-bounded, and exact-`application_name` cleaned; stop the backup service normally before an urgent deploy instead of bypassing either lock.
- After one rollout readiness timeout, inspect queue trend, active PostgreSQL backends, backup services, and host I/O before retrying or extending the timeout. Recover through the typed transition journal and reviewed queue-fence adoption path; never hand-write the release manifest.
- `npm run check:infra` must execute ShellCheck and fail closed. When a system binary is unavailable it uses the pinned `shellcheck@4.1.0` fallback. Put a ShellCheck directive alone on the line immediately before its command; explanatory prose belongs in a separate comment.
- Never place a full restore in Docker's production root filesystem.
- Redis persists BullMQ queues, delayed jobs, locks, and snapshots in named `redis_data:/data`. Avoid routine recreation; preserve/check RDB/AOF and queues first.
- After the runtime release removes every legacy VK publish producer/worker, retire only `vk-parsing-publish` with `./infra/scripts/vps-connect.sh vk-parsing-retire-legacy-queue` followed by the reviewed `--apply`. Apply holds the deploy lock, refuses workers, pauses and rechecks `active=0`, never uses force, uses bounded 1,000-job batches under a 120-second deadline, and treats an absent queue as success. It does not touch Postgres, the shared `vk-parsing-sync` queue, or `vk-parsing-publisher`; keep the legacy monitor counter as a regression sentinel.
- Retire the unsharded `moderation-default` queue only through `./infra/scripts/vps-connect.sh moderation-default-retire-legacy-queue`, preview first, then a separately reviewed `--apply`. Apply attests and briefly stops the sole `api-enqueue` producer, takes a fresh bounded private snapshot, proves every referenced webhook event terminal or absent through its primary key, rejects BullMQ flow/repeat linkage, pauses only the legacy queue, rechecks the snapshot, and never uses force. A referenced remote deadline bounds detached apply work; only after that boundary may EXIT restore `api-enqueue` and prove the exact healthy fleet. If deletion did not finish, the remaining queue stays paused; if a later postcheck failed, it may already be absent. After any error rerun preview before reviewing apply recovery. Keep the queue name in the append-only rollout registry and monitor census as a zero-count regression sentinel.
- Scale deploy preflights `infra-scale_redis_data` before stopping main.
- After a Redis restore/merge, audit schedule queues before workers start. Rebuild future `night-mode-transitions` from DB rather than restoring stale due jobs; require empty wait/active/failed and `delayed_due_now=0`, with persisted `NIGHT_MODE_CLOSE_NOTICE` as idempotency source.
