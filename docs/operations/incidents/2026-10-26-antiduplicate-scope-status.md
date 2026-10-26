# Anti-duplicate image scope status

## Complaint and finding

The reported screen selected «Всех участников» while the fixed fact below still read
«Счётчик повторов: Отдельно для каждого участника». That fact described individual
allowances and escalation, so it could not confirm whether image comparison scope changed.

`duplicatePhotoScope: CHAT` shares exact-image matching across authors. A duplicate posted
by another author counts toward that author's own allowance and reaction ladder. It does not
inherit another participant's warnings or restrictions. This is the existing
[scope invariant](../../antiduplicate-repair-plan-2026-09-30.md), not a new moderation policy.
API writes preserve the selected scope; the audit found no scope reset in settings normalization.

The supplied chat search lists calendar dates without exact times or original image fingerprints.
It cannot establish whether posts fell within the configured 36-hour window or contained the
same images. Neither incident source/image identity nor a specific missed moderation action was
established from those screenshots. Local regressions do not establish production acceptance
for those particular messages.

## Correction and regression scope

- Show «Поиск повторов» from the actual draft scope, including neutral mixed network values.
- Label individual warnings/restrictions separately and explain cross-author matching and
  per-author allowances. Keep action-preview wording consistent with the selected scope.
- Browser coverage switches both ways, checks visible status, preserves the choice after failed
  saving, then reloads saved settings through the API and checks the restored selection.
- Existing Redis history and full-flow cases verify cross-author detection, individual escalation
  and fixed window expiry. They use local stores and a simulated MAX transport.

Focused UI coverage is in `settings-duplicate-photo-options.test.ts` and
`settings-antiduplicate.browser.mjs` under `apps/miniapp/test`. Native coverage is in
`message-duplicate-history.redis-integration.spec.ts` and
`message-duplicate-flow.redis-integration.spec.ts` under the API moderation module.
