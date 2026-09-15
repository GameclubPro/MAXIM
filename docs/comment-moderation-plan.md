# Moderation of Mini App Comments

## Product Scope

Major and Publik offer the same comment moderation workflow, with independent sanctions.
A sanction is scoped to authenticated profile, entity type, community, and participant,
not to one post. It never calls MAX kick/ban or affects membership or suggestions.
Readers retain access. Mute and ban prevent new comments, edits, and reactions; deleting
one's own comment remains possible. Mutes last one hour, one day, or seven days;
bans last until an administrator releases them.

## Workflow

1. Open the comment action menu and select author restrictions.
2. Inspect the current restriction and select the action, duration, and optional reason.
3. Confirm the named participant and scope before applying the change.
4. Open the header's restrictions list to find and release restrictions even after the
   original comment disappears. The list uses bounded keyset pagination.
5. Restricted readers see their status and expiry instead of an enabled composer.

## Security And Consistency

- Reuse authenticated profile and profile-specific dialog token validation.
- Require community admin access; refresh actor and target roles before sanctions.
- Publik uses its existing binding-refresh worker and exact-bot access edges checked within
  30 seconds. The admin API never receives or uses the Publisher token. A pending/failed
  check makes no sanction changes; the moderator can retry the same revision.
- Protect self, owners, administrators, and configured bots; fail closed on lookup errors.
- Resolve new targets and display names from an existing comment in the signed thread.
- Keep current state in a dedicated composite-key table. Expiry is evaluated on reads.
- Serialize sanction changes and comment writes with the same participant advisory lock.
  Uploads and remote access probes remain outside SQL transactions.
- Use expected revisions so duplicate or stale requests cannot extend a mute or overwrite
  another administrator's decision. Persist state and bounded audit metadata atomically.
- Keep the migration additive. An old runtime does not enforce these new restrictions;
  rollback therefore requires explicit assessment of this behavioral limitation.

## Verification And Delivery

Cover role denial, self/admin/bot immunity, profile/community/thread separation, expiry,
revision conflicts, atomic enforcement, deleted source recovery, and pagination.
Exercise mobile action menus, confirmation, restriction list, errors, and restricted
composer on iPhone/Android in light and dark modes. Run contracts, API, Prisma, mini app,
admin and refactor checks, then exact-SHA CI and all affected production components.

Run the dedicated browser suite with the contracts build lock so concurrent generated-output
cleanup cannot invalidate Vite imports:

```sh
node scripts/with-file-lock.mjs contracts-build -- node apps/miniapp/test/comment-moderation.browser.mjs
```

The PostgreSQL serialization tests require a migrated, disposable local database through
`CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL` (database name must contain `race_test`).
