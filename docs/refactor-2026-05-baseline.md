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
- Routine mini app visual tooling should also stay Major-only by default. CDN/app2
  URLs require an explicit override tied to resumed CDN/restricted-LTE work.
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
  moderation notices. `NightModeTransitionEventService` owns close/open
  transition moderation-event creation and metadata while legacy still supplies
  a focused adapter for generic button builders.
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
  `private-control-session-normalizer.ts` owns session creation, persisted
  session normalization, pending input/mass-action parsing, and private-control
  screen/entity/view parsers. `private-control-draft-normalizer.ts` owns pure
  broadcast/suggestion draft normalization, broadcast target-state resolution,
  broadcast draft cloning, and suggestion draft object normalization.
  `private-control-media-attachments.ts` owns private bot attachment extraction,
  image/video download, media MIME/filename normalization, and suggestion media
  upload draft construction.
  Private forwarded-command parsing/extraction now lives in
  `admin-forwarded-command.util.ts` private wrappers/options, while action
  handlers remain in legacy behind `ManualModerationService`.
  Private-control manual moderation/rules command calls now route through
  `ManualModerationService` instead of direct `AdminService` calls.
- Settings page extraction has started:
  comments and extra sections are delegated to focused components while keeping
  route-owned state and lazy boundaries intact.

## Next Optimized Plan

1. Protect the completed moderation hot-path seams before taking new runtime cuts.
   Access lookup state and methods such as `resolveSenderChatAdminCheck`,
   `recheckSenderChatAdminBeforeModeration`, `isOtherBotAdminModerationBypass`,
   `getRemoteChatAdminAccess`, batch shared-cache helpers, guarded timeout
   execution, and `persistRemoteAdminGrant` already live in
   `ModerationAccessService`. `moderation-bot-routing.util.ts` owns read,
   moderation-action candidate, and auto-attach/night-mode route selection.
   Night-mode runtime, delivery, notice rendering, bot-speech media, closed-notice
   options, and transition-event creation are already behind focused modules.
   `ModerationService` no longer injects `AdminService`; channel-suggestion
   payload parse/build is behind `AdminDialogLinkService`, and manual command
   execution goes through `ManualModerationService`. The next work in these files
   should be regression guards, residual wrapper deletion, or complete-service
   extractions only. Leave destructive roster refresh scheduling and action
   execution/backoff state in legacy until a complete runtime service seam is
   available.
   Validate with:
   `npm test --workspace @maxim/api -- moderation-bot-routing.util.spec.ts moderation.admin-access.spec.ts moderation.shared-chat.spec.ts moderation.service.spec.ts`
   and `npm run typecheck --workspace @maxim/api`.

2. Make `PrivateControlService` the next primary backend slice.
   Keep `PrivateControlService` as the only public facade and do not import
   `private-control.service.legacy.ts` from new code. The manual-command bridge
   seam is closed; keep future private-control manual command work behind
   `ManualModerationService` or a narrower command service instead of direct
   `AdminService`. Move decomposition seams in this order:
   A. Extract pure render helpers only where they do not fetch data: launcher,
   moved-to-miniapp screens, preview payload rendering, small section summaries,
   and button/layout/string helpers. Defer rules/broadcast/giveaway/events/logs
   screens that fetch data.
   B. Extract handoff state/delivery helpers for broadcast, rules, giveaway, and
   profile mention flows, preserving the existing session fields and idempotency.
   C. Extract action bridges for broadcast publishing, channel suggestions,
   giveaway actions, settings/rules, and domain allowlist operations through
   existing focused services where available. Extend `ManagedBroadcastService`,
   `ChannelDialogService`, `ManagedGiveawayService`, and `ManualModerationService`
   rather than adding new logic to `AdminService`.
   D. Move callback routing, pending-input orchestration, `respond`, error
   handling, and context parsing last, after render, draft, handoff, and action
   services are covered by focused tests.
   Validate after each step with:
   `npm test --workspace @maxim/api -- private-control-launcher-renderer.spec.ts private-control-handoff-state.spec.ts private-control-draft-normalizer.spec.ts private-control-session-normalizer.spec.ts private-control.service.spec.ts`
   for session/draft state cuts; add `manual-moderation.service.spec.ts` for the
   manual-command bridge seam, and
   `admin-forwarded-command.util.spec.ts private-control-media-attachments.spec.ts`
   for future private bot command/media cuts. Add
   `miniapp-mutation-tunnel.controller.spec.ts admin-dialog-link.service.spec.ts channel-dialog.service.spec.ts managed-giveaway.service.spec.ts managed-broadcast.service.spec.ts`
   whenever handoff/action paths move.

3. Keep manual/admin command bridging out of runtime hot paths while private
   control is split. `ManualModerationService` is still partly a bridge over
   legacy `AdminService`; that is acceptable as an extraction boundary, but new
   manual command logic should land behind it or behind narrower focused helpers.
   Watch super-ban, fanout, developer actions, channel-suggestion handoff, and
   private-control admin callbacks for accidental new `AdminService` coupling.
   Validate with:
   `npm test --workspace @maxim/api -- moderation.service.spec.ts manual-moderation.service.spec.ts admin-dialog-link.service.spec.ts`.

4. Continue mini app settings extraction as second priority.
   `SettingsExtraSection` and `SettingsCommentsSection` are extracted. Next split
   required subscription in two stages: presentational blocks first, controller
   hook second. Keep `VkParsingCard`, required-subscription picker, broadcast
   composer, stats/events clients, and route CSS lazy boundaries intact. Material
   UI checks should use local screenshots or Major production-origin screenshots;
   `npm run audit:miniapp:visual` defaults to `https://major-maksimov.ru/app/`.
   Validate with:
   `npm run check:miniapp-css`,
   `npm run typecheck --workspace @maxim/miniapp`,
   and `npm run build --workspace @maxim/miniapp`.

5. Keep contracts extraction opportunistic and subpath-based.
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
