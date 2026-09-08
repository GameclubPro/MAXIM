# Participants Review And Delivery Plan

Scope: Major mini app, chat statistics, Participants tab and participant action sheet.
The API's sanctions, authorization boundary and shared contracts remain unchanged.

## Findings And Implementation

| Area                  | Verified defect or limitation                                                                                             | Implemented change                                                                                                                               | Verification                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Request identity      | The feed did not include the chat ID in its request dependencies; old rows could be exposed on chat navigation.           | Bind state to chat, period, role, search and page size; mask mismatched state synchronously and abort obsolete requests.                         | Browser tests switch chats and resolve responses out of order.        |
| Pagination cache      | A merged list was truncated to 100 rows but persisted with its final cursor, skipping intermediate pages on reuse.        | Persist the actual first server page and its cursor; use a new participant snapshot namespace to discard incompatible snapshots.                 | Browser test preserves the first-page cursor after loading more.      |
| Concurrent requests   | Rapid continuation requests could overlap; unmount cleanup did not consistently own manual requests.                      | A synchronous controller lock protects continuation; one lifecycle owns cancellation for all requests.                                           | Duplicate-click and unmount browser tests.                            |
| Continuation failures | Retry restarted the list; cached initial data could satisfy an explicit refresh without a request.                        | Separate refresh from retrying a failed continuation. Explicit refresh always requests the server.                                               | Browser tests assert the retry cursor and cache bypass.               |
| Pagination integrity  | Repeated cursors could produce a request loop; duplicate rows retained obsolete participant data.                         | Reject missing and visited continuation cursors; merge by participant ID while updating row data and retaining order.                            | Unit and browser tests.                                               |
| Search                | Debounce could present old rows as current results; text could exceed the API's 100-character limit.                      | Immediate pending state, disabled stale actions, bounded input, clear/reset controls and accurate result labels.                                 | Unit tests and search/empty visual scenarios.                         |
| Scan load             | Sparse filtered pages could trigger an unrestricted automatic scan or continue after failure.                             | Stop on error; allow up to three automatic continuation pages without additional matches, then require manual continuation.                      | Browser tests exercise the real roster and observer.                  |
| Counters              | Chat size and filtered result counts were not presented separately; identity metadata could outlive a participant action. | Separate chat total, visible result count, violation period and refresh time; prefer fresh feed totals and refresh identity after actions.       | Visual scenarios and request checks.                                  |
| Layout                | Repeated nested frames, variable badge widths and legacy CSS reduced usable space on small screens.                       | Unframed rows, stable violation column, identity-local protection labels, semantic colors and full-width period controls.                        | Strict iPhone/Android layout, contrast and accessibility checks.      |
| Actions               | Management menu lacked consistent dismissal; profile handoff did not block the sheet; refreshed items reset drafts.       | Outside-click, Escape and native Back dismissal; pending profile state; busy close guard; draft reset only when opening or changing participant. | Menu and participant-sheet visual scenarios; typecheck and UI guards. |

Participant UI is loaded on demand: the roster on its tab and the action sheet when opened.
Both use the shared recoverable lazy loader and loading states; feed requests start independently.
This keeps the events route within its existing JavaScript budget without raising the limit.

## Validation Commands

- `npm run check:miniapp`
- `npm run build:miniapp:production`
- With the local Vite server running: `node apps/miniapp/test/participants-feed.browser.mjs`.
  `MINIAPP_TEST_BASE_URL` selects another local server.
- `MINIAPP_SCREENSHOT_PRESET=moderation npm run screenshots:miniapp`.
  Focused scenarios: `events-participants`, `events-participants-search`,
  `events-participants-empty`, `events-participants-bots`, `events-participants-menu`,
  `events-participant-sheet`, `events-participant-controls`.
- Run strict visual checks at iPhone SE and Android sizes in both themes, plus desktop.
- The standard visual smoke preset checks the participant list and empty/reset flow during
  the moderation scenario's tab navigation, without expanding the short scenario budget.

## Delivery Boundary

Stage only this feature's files. Use the repository commit/push wrapper, require green
exact-SHA CI, then deploy only `miniapp-major-static` through the guarded VPS wrapper.
No API recreation, database migration, stateful-service recreation or nginx change is needed.

## Product Boundaries

- `totalCount` is the chat's audience size, not a count of search matches or a role subtotal.
- The selected period changes violation counts, not historical chat membership.
- The MAX roster can be unavailable even when a chat total is known; an empty accessible
  roster must not be labelled as proof that the chat contains no participants.
- Search and role filtering remain server-driven and cursor-bound. The loaded subset is not
  sufficient for global risk sorting, role totals or a complete participant violation history.
- Sanctions and unavailable-account cleanup retain server-side validation and confirmation.
