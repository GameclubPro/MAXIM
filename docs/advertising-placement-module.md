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
  checks passed. Final scoped verification and deployment remain pending.

## Delivery

- [x] Implemented locally as an unavailable announcement.
- [ ] Scoped validation and reviewed commit.
- [ ] Released in `miniapp-major-static` only.
- [ ] Verified against the public loaded frontend.

Pre-existing edits to `apps/api/AGENTS.md` are outside this task and retained.
Actual MAX devices and activation/publication are not claimed as tested.
