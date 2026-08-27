# Mini App Agent Notes

## Scope

- These instructions apply to the public React/Vite MAX mini app. Root workflow and contract rules still apply.
- Production is served under `/app/` by `miniapp-major-static` at `https://major-maksimov.ru/app/`.
- The MAX Bridge script is loaded from `https://st.max.ru/js/max-web-app.js`. Prefer shared wrappers over raw bridge calls.
- Routine work never deploys, publishes, or smokes CDN, Object Storage, app2, or the legacy support static service.

## Validation And Visual Work

- Focused checks: `npm run check:miniapp`, `npm run typecheck:miniapp`, and `npm run build --workspace @maxim/miniapp` for bundle budgets.
- The Major image bakes `VITE_API_BASE=https://major-maksimov.ru/api/v1`; budget changes must also pass a build with that value.
- Emulator examples:
  - `npm run emulator:miniapp -- --device iphone --reuse-server`
  - `npm run emulator:miniapp:android -- --reuse-server`
  - `npm run emulator:miniapp -- --device iphone-se --reuse-server`
  - add `--theme dark` and `--route '<path>'` for the exact screen
- `npm run screenshots:miniapp` and `npm run audit:miniapp:visual` are local-first and start/reuse the local mini app server. They validate the current working tree, not a previously deployed build.
- Use `MINIAPP_SCREENSHOT_MODE=production npm run screenshots:miniapp` or `MINIAPP_VISUAL_AUDIT_MODE=production npm run audit:miniapp:visual` only for an explicit production-origin audit.
- Narrow screenshots with `MINIAPP_SCREENSHOT_SCENARIOS`, `MINIAPP_SCREENSHOT_DEVICE`, and an explicit base URL when necessary. Output lives under `artifacts/miniapp-screenshots/`.
- Native emulator/screenshots install the safe MAX Bridge shim by default. Use `--no-max-bridge` or `MINIAPP_SCREENSHOT_MAX_BRIDGE=0` only for a deliberate bridge-free check.
- Material UI work is not complete from code review alone. Check iPhone and Android sizes, light/dark, safe areas, scrolling, and keyboard overlap.

## CSS And Layout

- `src/styles.css` is the only global CSS entrypoint. Its imports use `@import ... layer(...)`; CSS imported directly from TS/TSX must be fully wrapped in an explicit `@layer`.
- Run `npm run check:miniapp-css` after CSS ownership/import changes.
- Lazy-route CSS remains loaded for the SPA session. Scope route polish to route-specific body/root selectors and test both cold loads and cross-route navigation.
- Do not put global `touch-action` or root `overscroll-behavior-y` locks on `html`/`body`; MAX WebViews can stop page and nested-list scrolling. Put `pan-y` and momentum scrolling on the actual scroll container.
- Do not apply MAX `safeTop` or CSS safe-area values as a blanket content offset; some WebViews already account for system UI. Use `visualViewport` and real element measurements around floating controls.
- Keep stable dimensions and responsive constraints on boards, grids, controls, counters, and fixed-format UI. Text and controls must not overlap at supported mobile sizes.

## Android And Native Behavior

- Android MAX file pickers require a real transparent `<input type="file">` overlay on the tapped control. Hidden 1px inputs plus programmatic `click()`/`showPicker()` can fail.
- Keep the overlay in tab order with an accessible label and visible `:focus-within` state.
- `BroadcastContentComposer` file-input styles stay in its component CSS because `/publications` does not load legacy broadcast-studio styles.
- Read selected image blobs with `Blob.arrayBuffer()` first; retain `FileReader` only as a legacy fallback.
- Use shared `TimeField`, not native `<input type="time">`; Android MAX WebViews can hide native picker actions.
- Register overlay/sheet/editor close behavior through `src/lib/native-back.ts`.
- Mirror durable device-local state through `src/lib/native-storage.ts`.
- Use `src/lib/max-bridge.ts` for MAX links, share/download, haptics, ready, viewport, and BackButton.
- Use `window.WebApp.openMaxLink` only for `https://max.ru/...`; use `openLink` for external URLs.

## Routing And Trust

- Authentication relies on API-validated `initData`/`WebAppData`; `initDataUnsafe` is presentation convenience only.
- A late MAX Bridge `initData` value must replace URL-fallback startup state. Keep Bridge discovery bounded and event-assisted, and use cryptographic/session helpers rather than `Math.random` for boot trace identifiers.
- Rich-text editor and clipboard links must use the shared `max-rich-text-link` parser. Accept credential-free HTTPS and exact `max://user/<id>` links only; never assign pasted or typed href text directly to editor HTML.
- Home launch context does not identify a target managed chat/channel. Discovery comes from server allowlist, access edges, published snapshots, and recent signals.
- Public legal routes `/app/legal/agreement` and `/app/legal/privacy`, including prefixed standalone paths, render without init data and remain before the startup auth gate.
- Public comment and suggestion routes opened by bot buttons close the mini app on native BackButton instead of navigating home.
- Parse start/startapp payloads through `src/lib/launch-route.ts`; do not build custom payload grammars.
- For bot buttons opening internal screens, prefer bot-scoped `https://max.ru/<bot>?startapp=...` links; direct `open_app`/`webApp` launch is fallback only.
- Do not expose internal primary, standby, or execution-owner details. Use `sanitizePublicManagedEntityHeader`; public headers preserve only counters/flags such as `botCount` and `hasSharedAutomation`.

## Publications And Settings

- `/publications` is the ordinary chat/channel publishing workspace. Chat/channel settings are compatibility handoff surfaces; VK parsing is a separate flow.
- The Publisher profile home is its own `/` cabinet with `Чаты`, `Каналы`, and `Посты` navigation. Its entity catalog comes from exact Publik connections, never from the Major catalog.
- Major chat/channel settings expose exactly one compact `Публик` enable switch. Keep readiness, recheck actions, suggestions routing, and future Publisher module controls inside the Publik profile; do not add secondary Publik rows or explanatory status copy to Major.
- Open legacy publishing only for `workspace=autoposts`, an exact `legacyKind` + `legacyId`, or `handoff=1` backed by a real private-bot draft. A bare handoff flag cannot restore legacy creation.
- Publication search, entity/status filters, and schedules are server-side and cursor-bound; never fetch every page for client filtering.
- Rows with `publicationOccurrenceId != null` are Publication envelopes and must stay hidden from legacy broadcast/autopost APIs and UI.
- Channel publication buttons are derived directly from `commentsEnabled` and `postSuggestionsEnabled`; do not add a separate button-mode control or preview filter.
- Settings section apply defaults to the current chat. Applying all requires explicit `mode: 'all'`; keep contract, UI default, and preview transport aligned.
- Required-subscription controls list fresh managed chats and channels, preserve external-link fallback, and save only server-verifiable targets.
- Stop-word UI owns both blocked words and blocked domains. Domain entry defaults to `DOMAIN`, not an accidental exact root URL.
- Keep `VkParsingCard` lazy-loaded on chat/channel settings routes.

## Performance And Product Presentation

- Home statistics prefetch imports stay lazy; statically importing events/stats clients into `chats-page.tsx` spends startup budget.
- Stats API clients should import contracts as types where possible, and stats routes use focused CSS instead of `lazy-pages.css`.
- Channel audience charts use joined/left net growth from `series.membership`; `series.participants` is total-audience context. Prefer observed `viewsDelta`, with total views only as fallback.
- Statistics screens stay factual: metrics, freshness, coverage, charts, top posts, and publishing windows. Do not add pseudo-AI advice or coaching copy.
- Managed poll lists render persisted `imageCount`; raw poll images belong to details only.
- Home readiness is user-scoped and separate from global discovery completion. Managed entities are unique per chat/channel, not repeated per bot.
