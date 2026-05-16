# MAXIM Reliability Refactor Baseline, May 2026

This document is the first safety baseline for the May 2026 reliability-first refactor. It is intentionally conservative: preserve public behavior, keep runtime deploys small, and make future decomposition easier to review.

## Current Fitness Gates

- `npm run lint`
- `npm run typecheck`
- `npm run test --workspace @maxim/api`
- `npm run test --workspace @maxim/miniapp`
- `npm run build --workspace @maxim/api`
- `npm run build --workspace @maxim/miniapp`
- `npm run check:refactor-guards`
- For broader runtime slices, finish with `npm run check` before push/deploy.

## Hotspots

- API: `apps/api/src/admin/admin.service.ts` is the largest admin surface and mixes managed entities, settings/rules, broadcasts, dialogs, member tools, and operational helpers.
- API: `apps/api/src/moderation/moderation.service.ts` combines webhook pipeline orchestration, bypass/access checks, moderation action dispatch, shared-chat guards, and background scanners.
- API: `apps/api/src/moderation/rule-engine.service.ts` is the rule facade and detector host; `detect()` must remain the behavioral boundary while detectors are extracted.
- Miniapp: `apps/miniapp/src/pages/settings-page.tsx` is the largest interactive workspace and should be decomposed by lazy settings workspaces.
- Miniapp: `apps/miniapp/src/styles/lazy-pages.css` is the largest CSS bundle and should lose route-specific styles over time.

## First Boundaries

- Rule engine extraction keeps `RuleEngineService.detect()` as the public facade and moves normalization, link checks, topic filter checks, blocked-word matching, and duplicate Redis state into focused modules under `apps/api/src/moderation/`.
- The first rule-engine tranche extracted detection context, hot-path profiling, and message/media limits into focused modules with focused specs.
- Contract subpaths are available for high-churn domains: `settings`, `bot-speech`, `broadcast`, `managed-entities`, `giveaway`, and `system`.
- Miniapp route/component CSS extraction has started with lazy handoff and broadcast button sheet styles, leaving `lazy-pages.css` as the compatibility bundle to shrink gradually.

## Runtime Invariants

- Public HTTP routes, miniapp route semantics, MAX webhook behavior, and Prisma schema stay unchanged in the first tranche.
- `packages/contracts` remains the source of truth for API payloads shared by API and miniapp.
- Production API still uses one shared API image split by `APP_ROLE`; API code changes require all shared API roles to be recreated during deploy.
- MAX calls keep explicit traffic classes/source tags and stay within documented rate limits.
- Webhook hot paths must fail open or defer optional work before blocking shard responsiveness.
- Managed entities home visibility remains access-edge scoped and must not reintroduce launch-context assumptions.

## Golden Flows

- MAX webhook ingestion: signature/header validation, queue routing, outbox repair, and duplicate handling.
- Moderation hot path: admin/bot bypass, rule detection, sanction/action fallback, timeout profile, and shared-chat execution guard.
- MAX API reliability: global/per-chat rate limits, circuit/backoff behavior, membership lookup, media upload, and action dispatch.
- Managed entities home: fresh access edges, published snapshots/diffs, recent `bot_added` bootstrap, refresh/backoff state, favorites.
- Broadcasts: compose, schedule/calendar conflict detection, target audience, test delivery, retry/cancel/recovery.
- Giveaways: draft, publish, eligibility checks, draw, claim, reroll, delivery, cancellation.
- Miniapp launch/deep links: `startapp` route parsing, MAX bridge init data refresh, bot handoff links, prefixed app deployments.

## Modernization Backlog

- Keep Node 24 as the baseline.
- Patch/minor dependency updates can proceed inside current majors after fitness gates pass.
- Jest 30 is complete; keep it behind the API test gate when touching test runtime.
- Vite 8 is complete; keep it behind the miniapp typecheck, test, build, and bundle-budget gates.
- Zod 4 and Prisma 7 remain separate upgrade tracks after decomposition.
- Prisma 7 needs its own generated-client/import-path/driver-adapter plan.
- React Compiler and Nest SWC are opt-in experiments after component and service boundaries are stable.
