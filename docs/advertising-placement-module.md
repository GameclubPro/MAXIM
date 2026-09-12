# Advertising Placement Module

Date: 2026-09-13. Target: the Major mini app at
`https://major-maksimov.ru/app/`.

## Current Scope

This release is an unavailable announcement, not a working Svyazka integration.
Chat settings show `Рекламная площадка` with the visible `Скоро` badge next to
the other content/service modules. The native button is disabled and has no
click handler, link, switch, settings panel or writable field. It is unavailable
to every user and is searchable by the Svyazka/advertising/barter aliases.

No API, Prisma migration, integration credentials, scheduler or MAX send path
is introduced. Existing settings and the Svyazka marketplace are unchanged.
Future activation requires a separate reviewed implementation: verified chat-to-
listing binding, a Svyazka listing deep link and an explicitly enabled delivery
policy. A future module switch must not stand in for advertisement consent.

## Verification

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

## Delivery

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
