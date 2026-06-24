# MAXIM Reliability Refactor Plan, June 2026 Refresh

This document is the current safety baseline for the reliability-first refactor.
It should stay conservative: preserve public behavior, keep runtime deploys small,
and make each extraction reviewable through focused tests.

## Non-Negotiable Boundaries

- Do not expand the allowed direct `*.legacy` import set. Public facade files remain
  the only temporary legacy import boundary.
- Runtime entrypoints stay behind focused services:
  `WebhookIngestionService`, `ModerationExecutionService`,
  `MaxActionDispatchService`, and `ManagedEntitiesDiscoveryService`.
- New runtime/admin hot-path code should route through focused services before
  touching legacy implementations.
- Do not grow `packages/contracts/src/core.ts`; add or use subpath exports for
  new domains and keep package exports, root TS paths, and API Jest mappers aligned.
- Routine mini app deploy and smoke target is only
  `https://major-maksimov.ru/app/`. Do not publish or smoke CDN/app2/Object Storage
  unless CDN/restricted-LTE work is explicitly resumed.
- For API validation, do not run Prisma-generating API Jest/typecheck commands in
  parallel.

## Current Fitness Gates

- Boundary guard: `npm run check:refactor-guards`.
- API focused gates:
  - `npm test --workspace @maxim/api -- moderation.admin-access.spec.ts moderation.shared-chat.spec.ts`
  - `npm test --workspace @maxim/api -- night-mode-transition`
  - `npm test --workspace @maxim/api -- moderation.service.spec.ts manual-moderation.service.spec.ts`
  - `npm test --workspace @maxim/api -- private-control.service.spec.ts channel-dialog.service.spec.ts managed-giveaway.service.spec.ts`
- Mini app focused gates:
  - `npm run check:miniapp-css`
  - `npm run typecheck --workspace @maxim/miniapp`
  - `npm run build --workspace @maxim/miniapp`
- Contracts gates:
  - `npm run typecheck:contracts`
  - `npm test --workspace @maxim/api -- contracts`
- Broad/risky runtime slices finish with `npm run check` before push/deploy.

## Current Hotspots

- API: `apps/api/src/admin/admin.service.legacy.ts` remains the large admin
  implementation behind the `AdminService` facade. New admin entrypoints should
  prefer focused services such as `ManagedEntitiesService`, `AdminSettingsService`,
  `ManagedBroadcastService`, `ManualModerationService`, `ChannelDialogService`,
  and `ManagedGiveawayService`.
- API: `apps/api/src/moderation/moderation.service.legacy.ts` remains the large
  moderation implementation behind the `ModerationService` facade. Webhook,
  queue, action, and discovery entrypoints must not call it directly.
- API: `apps/api/src/moderation/private-control.service.legacy.ts` remains the
  large private-control implementation behind the `PrivateControlService` facade.
- API: `apps/api/src/moderation/rule-engine.service.ts` is the rule facade and
  detector host; `detect()` remains the behavioral boundary while detectors are
  extracted.
- Mini app: `apps/miniapp/src/pages/settings-page.legacy.tsx` remains the largest
  settings route implementation behind the settings page facade.
- Contracts: `packages/contracts/src/core.ts` remains large but should not grow.

## Completed Refactor Slices

- Rule-engine extraction has already split detection context, hot-path profiling,
  message/media limits, commercial detection, normalization, topic filters,
  duplicate state, and related specs into focused modules.
- Moderation access/read-bot slice is largely extracted:
  `moderation-access.service.ts` owns chat-admin access checks, remote lookup
  batching/cache/backoff, and transient MAX lookup handling, with legacy wrappers
  delegating into it.
- Bot routing helpers have started and now cover the main non-I/O selection
  seams:
  `moderation-bot-routing.util.ts` centralizes read, moderation-action, and
  auto-attach/night-mode transition bot route selection helpers used by the
  legacy facade.
- Night-mode execution has started:
  `night-mode-transition-runtime.service.ts` owns transition execution logic while
  `ModerationExecutionService` remains the public queue/runtime entrypoint.
  `night-mode-transition-notice.util.ts` owns pure close/open notice rendering
  and self-notice matching. `night-mode-transition-delivery.service.ts` owns
  schedule notice send/delete flow and terminal MAX access-loss handling.
  `night-mode-transition-closed-notice-options.util.ts` owns comments/base-button
  options composition for close notices. `BotSpeechMediaService` owns shared
  bot-speech media resolution/upload/option merging for night-mode and other
  moderation notices while legacy still supplies focused adapters for generic
  button builders and event helpers.
- Manual/admin command bridge has started:
  forwarded admin-command parsing is isolated in `admin-forwarded-command.util.ts`,
  and `ModerationService` prefers `ManualModerationService` for group/manual admin
  command execution.
- Moderation/AdminService bridge cleanup is complete for the moderation hot path:
  channel-suggestion payload parse/build moved behind `AdminDialogLinkService`,
  `ModerationService` no longer injects `AdminService`, and
  `manualModerationCommandBridge` no longer falls back to `AdminService`.
- Private control extraction has started:
  shared private-control types/constants and `PrivateControlSessionStore` are
  separated from `private-control.service.legacy.ts`.
- Settings page extraction has started:
  comments and extra sections are delegated to focused components while keeping
  route-owned state and lazy boundaries intact.

## Next Optimized Plan

1. Finish remaining moderation access/bot-routing debt only at complete seams.
   Keep thin wrappers in `moderation.service.legacy.ts` for hot-path stability.
   Access lookup state and methods such as `resolveSenderChatAdminCheck`,
   `recheckSenderChatAdminBeforeModeration`, `isOtherBotAdminModerationBypass`,
   `getRemoteChatAdminAccess`, batch shared-cache helpers, guarded timeout
   execution, and `persistRemoteAdminGrant` already live in
   `ModerationAccessService`. `moderation-bot-routing.util.ts` owns read,
   moderation-action candidate, and auto-attach route selection. The next API
   cleanup here should remove residual wrapper/coupling debt or add focused tests,
   not reopen moved logic. Leave destructive roster refresh scheduling and action
   execution/backoff state in legacy until a complete runtime service seam is
   available.
   Validate with:
   `npm test --workspace @maxim/api -- moderation-bot-routing.util.spec.ts moderation.admin-access.spec.ts moderation.shared-chat.spec.ts moderation.service.spec.ts`
   and `npm run typecheck --workspace @maxim/api`.

2. Continue night-mode as a runtime service behind `ModerationExecutionService`.
   Extract only business logic behind the existing execution boundary; do not add
   another public execution bridge. The current runtime service owns
   transition-state/lock/schedule decisions, and the notice util owns pure
   close/open text rendering plus self-notice matching. The delivery service owns
   send/delete sequencing, request lanes/source tags, event callback timing, and
   terminal MAX handling. Closed-notice options composition is isolated in
   `night-mode-transition-closed-notice-options.util.ts`, and shared bot-speech
   media handling is isolated in `BotSpeechMediaService`. The next complete seam
   is reducing the remaining legacy event creation metadata adapter. Preserve
   schedule-driven close/open notices, webhook-only delete gates, and the
   `moderation-bot-routing.util.ts` night-mode bot-id fallback order.
   Validate with:
   `npm test --workspace @maxim/api -- night-mode-transition-delivery.service.spec.ts night-mode-transition-notice.util.spec.ts bot-speech.spec.ts moderation.service.spec.ts moderation-execution.service.spec.ts night-mode-transition.processor.spec.ts night-mode-transition-scheduler.service.spec.ts night-mode-transition.queue.spec.ts managed-entity-access-loss.service.spec.ts`
   plus `admin-settings.service.spec.ts` cases when schedule reconciliation moves.

3. Keep manual/admin command bridging out of the moderation hot path.
   `ModerationService` no longer injects `AdminService`; continue routing manual
   group/private commands through `ManualModerationService` and focused helpers.
   Watch super-ban, fanout, developer actions, and channel-suggestion handoff
   paths for accidental legacy admin coupling.
   Validate with:
   `npm test --workspace @maxim/api -- moderation.service.spec.ts manual-moderation.service.spec.ts admin-dialog-link.service.spec.ts`.

4. Slice `PrivateControlService` after the moderation hot path stabilizes.
   Keep `PrivateControlService` as the public facade. Next low-risk slices are
   draft/media normalization, render builders, forwarded action handlers, then
   handoff/broadcast/channel-suggestion action services. Leave callback routing
   and pending-input orchestration until the end.
   Validate after each step with:
   `npm test --workspace @maxim/api -- private-control.service.spec.ts`; add
   `channel-dialog.service.spec.ts managed-giveaway.service.spec.ts` for action or
   handoff moves.

5. Continue mini app settings extraction as second priority.
   `SettingsExtraSection` and `SettingsCommentsSection` are extracted. Next split
   required subscription in two stages: presentational blocks first, controller
   hook second. Keep `VkParsingCard`, required-subscription picker, broadcast
   composer, stats/events clients, and route CSS lazy boundaries intact.
   Validate with:
   `npm run check:miniapp-css`,
   `npm run typecheck --workspace @maxim/miniapp`,
   and `npm run build --workspace @maxim/miniapp`.

6. Keep contracts extraction opportunistic and subpath-based.
   If a domain needs new shared contracts, create/update a subpath export and
   synchronize API, mini app, tests, and typechecks in the same slice. Do not use
   `core.ts` as a catch-all.
   Validate with:
   `npm run typecheck:contracts` and API contract specs before broader checks.

## Deployment Rule

- Docs, tests, and refactor-plan updates do not require VPS deploy.
- Runtime-affecting changes in API, mini app, contracts, Prisma, Docker, or MAX
  integration should finish with local validation and a VPS deploy unless the user
  explicitly says not to deploy.
- For shared API code changes, recreate every API role that uses the shared image.
- For routine mini app production checks while Major is primary, deploy/smoke
  `miniapp-major-static` and `https://major-maksimov.ru/app/` only.

## Golden Flows

- MAX webhook ingestion: signature/header validation, queue routing, outbox
  repair, and duplicate handling.
- Moderation hot path: admin/bot bypass, rule detection, sanction/action fallback,
  timeout profile, and shared-chat execution guard.
- MAX API reliability: global/per-chat rate limits, circuit/backoff behavior,
  membership lookup, media upload, and action dispatch.
- Managed entities home: fresh access edges, published snapshots/diffs, recent
  `bot_added` bootstrap, refresh/backoff state, favorites.
- Broadcasts: compose, schedule/calendar conflict detection, target audience,
  test delivery, retry/cancel/recovery.
- Giveaways: draft, publish, eligibility checks, draw, claim, reroll, delivery,
  cancellation.
- Mini app launch/deep links: `startapp` route parsing, MAX bridge init data
  refresh, bot handoff links, prefixed app deployments.

## Modernization Backlog

- Keep Node 24 as the baseline.
- Patch/minor dependency updates can proceed inside current majors after fitness
  gates pass.
- Prisma audit debt: `npm audit --omit=dev` currently reports
  `GHSA-92pp-h63x-v22m` through Prisma's `@prisma/dev -> @hono/node-server`
  chain. Do not run `npm audit fix --force` for it, because npm proposes
  installing Prisma 6.19.3. Track this until a Prisma 7-compatible patch resolves
  the transitive advisory.
- Jest 30 is complete; keep it behind the API test gate when touching test
  runtime.
- Vite 8 is complete; keep it behind the mini app typecheck, test, build, and
  bundle-budget gates.
- Zod 4 is complete; keep contract changes behind contracts, API, and mini app
  gates.
- Prisma 7 remains a separate upgrade track after decomposition.
- React Compiler and Nest SWC are opt-in experiments after component and service
  boundaries are stable.
