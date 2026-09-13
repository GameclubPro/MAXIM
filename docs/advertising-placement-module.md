# Advertising Placement Module

Date: 2026-09-13. Target: the Major mini app at
`https://major-maksimov.ru/app/`.

## Current Scope

The working pilot is implemented locally for the user-authorized MAX identity,
with fresh chat-admin authorization on every management operation and again
immediately before sending. Other identities retain the exact disabled
announcement and coming-soon badge. Pilot availability is returned by the
authenticated server, not inferred from unsafe launch data or a client ID list.

The separate Svyazka credential was explicitly authorized on 2026-09-13. It can
only look up an active real chat listing owned by the pilot, by exact MAX chat
identity. It grants no session, ownership, payment or publication permission.
The two bots never exchange MAX launch data or tokens. Provisioning is a
separate guarded step; no key belongs in Git, browser bundles or logs.

Explicit enablement binds the current listing. A separate button sends one
message using Major's immediate, routed, rate-limited, durably fenced transport.
There is no scheduler or legacy publication runner. Revision and previous-send
CAS plus immutable request IDs prevent duplicate or competing requests. Disable,
lost rights and a missing/replaced listing reject unattempted sends. Uncertain
delivery is never retried automatically; an explicitly acknowledged new send
is a new intent, not a rewritten delivery history. Disabling does not remove an
already delivered button. A missing listing opens normal Svyazka onboarding.

Migration `20260913120000_add_advertising_placement_pilot` creates only two new
tables. It has no backfill, change to existing settings, or consent mutation.
The action journal uses exact primary-key reads, not fleet or JSON scans.

### Pilot Verification

- Full isolated `npm run check`: 11,843 API tests, 213 contract tests, 1,273
  mini app tests, static/infrastructure checks and Safety Desk tests/build/smoke
  passed. Separate PostgreSQL concurrency tests passed all four cases.
- Narrow API tests cover nonpilot/nonadmin rejection, wrong-chat/URL binding,
  upstream errors, disable/revocation before dispatch, concurrent duplicates,
  uncertain results and a failed final receipt write. The ordinary unavailable
  card remains covered by its original noninteractive component test.
- The final 12-case focused API run also verifies that a replaced listing is
  visibly unbound until explicitly reconnected. Capability decoding and the
  isolated preview handler stay out of the eager contract/preview dependency
  graph; only a literal server `available: true` opens the module.
- Browser pilot checks exercise enable, send, disable, retained result and
  reopening. Controlled switches wait for the confirmed state; Playwright's
  immediate checkbox assertion was unsuitable for this non-optimistic mutation.
- The initial preview used symbolic chat IDs against the numeric MAX response
  schema. Explicit synthetic MAX IDs and schema validation now guard fixtures.
- The shared worktree contains concurrent unrelated UI work. Its combined build
  exceeded startup budget; the isolated task snapshot with lockfile-based
  dependencies passed without increasing budgets. Do not attribute those
  unrelated edits to this release. Production dependency audit retains two
  moderate findings and zero high/critical findings; no packages were upgraded.
- Concurrent comment/giveaway commits were retained as ancestors. Their separate
  `f34d086b` startup-preload allowance is not part of this module's diff. The
  combined production build passed; final mini app validation passed 1,282 tests.

### Pilot Delivery

- [x] Core implementation and isolated full checks.
- [x] Final mobile visual acceptance: iPhone SE/light and Android/dark, four
      inspected screenshots; the standard 13-scenario strict smoke passed.
- [x] Reviewed source commits `b747616b` and `0d191f00`.
- [x] Separate credential provisioning and both project releases.
- [x] Public frontend/API verification.
- [ ] Real MAX device and live-delivery acceptance.

Major runtime: `0d191f00f500b0d61efd93335ce188702fca0b21`, release
`release-20260913T004513Z-0d191f00f500`. Exact-SHA Required and CodeQL checks
passed. A concurrent standard deployment held the shared lock and already
targeted this exact SHA; a duplicate release was not forced. The committed
manifest, all 13 API roles, OCR auxiliary and both active static services were
verified on the expected images. PostgreSQL and Redis were retained. Prisma
reports all 271 migrations up to date; ingress/admin live and ready returned
success after the normal rollout backlog recovered.

Public HTML loads the expected entry; 61 entry/settings/workspace dependency
files matched the local production build byte for byte. Public iPhone SE/light
and Android/dark pilot/closed scenarios passed and the images were inspected.
Unauthenticated capability/state calls return 401. A read-only lookup from the
running api-admin container confirmed its dedicated credential works; no live
chat message or advertising consent was changed by these checks. The final
current-action feedback correction passed 1,283 mini app tests and browser
verification; old success cannot stand in for a pending send.

Svyazka runtime is independently released as
`7dfa68059582c7e2749795a4925fe14d1ee49d6c`; its ledger remains in MAX-MARKET.
Public screenshots are retained under `artifacts/miniapp-screenshots/` in the
two `2026-09-13T00-53-13-362Z` and `2026-09-13T00-54-57-229Z` folders.

The user-owned API agent notes and concurrent home-stability changes remain
outside these commits. A newer documentation-only HEAD does not advance the
runtime SHA or require another deployment.

## Previous Announcement

The previous release was an unavailable announcement, not a working integration.
Chat settings show `Рекламная площадка` with the visible `Скоро` badge next to
the other content/service modules. The native button is disabled and has no
click handler, link, switch, settings panel or writable field. It is unavailable
to every user and is searchable by the Svyazka/advertising/barter aliases.

No API, Prisma migration, integration credentials, scheduler or MAX send path
is introduced. Existing settings and the Svyazka marketplace are unchanged.
Future activation requires a separate reviewed implementation: verified chat-to-
listing binding, a Svyazka listing deep link and an explicitly enabled delivery
policy. A future module switch must not stand in for advertisement consent.

## Announcement Verification

- `apps/miniapp/test/settings-advertising-soon.test.ts` guards the disabled,
  noninteractive component, chat-only placement and absence of a writable
  settings/section contract.
- `chat-settings-advertising-soon` is the real-browser scenario: search finds
  the module, the badge is visible, clicks do not open a panel, navigate or
  make a write request. It is included in the standard CI visual smoke.
  Screenshots stay in ignored artifacts.
- Local iPhone SE/light and Android/dark layout, contrast and accessibility
  checks passed and both images were inspected. The scoped submission checks
  passed: 1271 mini app tests, 492 repository-tooling checks, CSS ownership,
  typechecking, production budgets and the 13-scenario standard visual smoke.
- Local development-server smokes reported canceled module fetches on ports
  3000 and 4183. The same strict smoke passed against the freshly built local
  production preview; no network failures or layout checks were ignored.
  The CI Mini App job also passed its normal development-server smoke.
- The first direct asset comparison used fewer public Vite build variables
  than Docker and therefore had different hashes. Rebuilding with Docker's
  exact public arguments produced a matching HTML entry and 57 byte-identical
  entry/settings dependency files. This did not require runtime changes.

## Announcement Delivery

- [x] Implemented locally as an unavailable announcement.
- [x] Scoped validation and reviewed commit.
- [x] Released in `miniapp-major-static` only.
- [x] Verified against the public loaded frontend.

Runtime source: `b9c0d2ad963c8a64d64c9456380d77d3d4608f02`.
Release: `release-20260912T222228Z-b9c0d2ad963c`.
Exact-SHA Required CI and Analyze JavaScript and TypeScript checks passed
before the guarded static-only deployment. API, PostgreSQL, Redis and sibling
services were not recreated. Public light/dark browser checks used isolated
preview data and confirmed the disabled button, visible badge, search and
absence of write requests. These are not real MAX device or delivery tests.

A newer documentation-only HEAD does not advance the runtime SHA or require
another deployment.

Pre-existing edits to `apps/api/AGENTS.md` are outside this task and retained.
Actual MAX devices and activation/publication are not claimed as tested.
