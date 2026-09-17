# Allowed Domains And Links Audit

Scope: shared normalization, allowlist administration, link and stop-word matching,
and the Major settings editor. This is a bounded code audit, not a claim that every
possible defect in link moderation has been eliminated.

## Findings And Implementation

1. **Domain parsing accepted unrelated text and custom-scheme URLs.** Typed domain
   rules now parse the entire credential-free HTTP(S) URL or bare host. Backslashes
   and invisible controls are rejected. The existing stop-word domain validator
   also rejects malformed DNS labels and normalizes a final DNS root dot.
   Legacy stored records remain readable.
2. **The shared URL matcher shortened exact targets.** Encoded whitespace and
   parenthesized suffixes could match a shorter allowed URL. Matching now uses the
   strict parser, including for stop-word domain exceptions.
3. **GET mutated the policy.** Reading legacy rows could upsert or delete rules,
   race with an administrator, and invalidate recovery baselines. Canonicalization
   is now an in-memory read operation only.
4. **Duplicate expiry was shortened.** Equivalent active records now retain their
   union: permanent permission wins; otherwise the latest expiry wins.
5. **Repeated POST removed an existing timer.** Adding an active rule preserves its
   expiry, including when normalizing a legacy alias. Explicit timer cancellation
   remains a separate operation. Adding an expired rule starts a new permission.
6. **Policy and audit writes were not atomic.** Add, delete, and scheduling now
   write audit records in the same transaction. All allowlist writers, including
   settings fanout, serialize on the parent chat row. Cache invalidation happens
   only after commit and never while holding the database lock.
7. **Legacy domain GET identifiers could not be deleted or scheduled correctly.**
   Bare hosts now address domain rules; full URLs retain exact-rule identity.
8. **Expired rules could be revived by a stale timer editor.** Scheduling requires
   an active rule and revalidates the requested deadline after acquiring the lock.
   Fanout excludes expired source entries and duplicate target chat IDs.
9. **Subdomain matching scanned every rule for every URL.** Set lookups now walk
   the hostname's label boundaries, independent of the number of allowed domains.
10. **Editor submission and error states were incomplete.** Enter respects pending
    writes, input/type selection is disabled during submission and list refresh,
    and network failures retain the draft and show inline errors.
11. **Policy copy contradicted MAX mention handling.** Descriptions no longer say
    ordinary profile mentions are deleted. Existing typed profile records remain
    readable for compatibility; mention immunity is unchanged.
12. **Open lists retained expired entries.** The active links panel refreshes at the
    nearest scheduled expiry and on focus. Permanent-only lists do not poll, and
    far-future schedules are capped to the browser timer range.
13. **Narrow timer controls crowded the time label against its icon.** The schedule
    grid now wraps according to available width; browser checks assert that both
    the label and time fit their tracks.

## Delivery Plan

1. Preserve storage formats and public response shapes; no Prisma migration.
2. Cover normalization, exact/domain isolation, legacy identifiers, expiry, access,
   transactional error handling, and read-only GET with focused regression tests.
3. Run contracts, API, mini app, Safety Desk, Prisma, and refactor checks. Run
   `node apps/miniapp/test/settings-link-allowlist.browser.mjs` for desktop, iPhone,
   Android, light/dark themes, and the narrow iPhone SE layout.
4. Commit only owned files, require green exact-SHA CI, then deploy the shared API
   and both contract consumers through the guarded VPS wrapper. Do not bypass CI,
   disk, release-manifest, or queue-fence checks.

## Boundaries

- No production data repair or bulk cleanup is performed by GET.
- Automatic deletion is still checked against fresh settings and active rules.
- The local environment needs a disposable PostgreSQL instance for real concurrent
  transaction/rollback tests; mocks alone do not prove database lock behavior.
- Pagination, rule quotas, and removing legacy profile choices are separate product
  decisions, not silently introduced API changes.
