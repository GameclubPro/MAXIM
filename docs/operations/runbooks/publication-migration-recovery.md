# Publication Migration Recovery

The fixed `publication-schema` audit diagnoses the additive schema introduced by
`20260909130000_add_publication_post_actions`. It is not a migration repair command.

1. Check `vps-connect.sh health` and the deployed image inventory. Do not restart healthy
   stateful services or repeat a failed migration blindly.
2. Synchronize reviewed tooling, then run
   `./infra/scripts/vps-connect.sh postgres-audit publication-schema`.
3. The bounded audit reports only the two parent tables' presence, the post-action enum,
   eleven expected columns with their types/defaults, and the due index's validity and definition.
   It uses the existing audit role and never reads messages, content, credentials, or delivery rows.
4. Absent, partial, and complete schema states require different recovery actions. This report
   alone cannot establish the state of `_prisma_migrations`, and is not permission to mark a
   migration applied or rolled back. Use a separately reviewed recovery procedure that proves
   the exact migration record and verifies every required object before resolving it.
5. Do not edit a committed migration, drop existing columns, or hand-write `current.json`.
   Resume a reviewed interrupted deployment only with the typed transition journal and the
   normal queue-fence adoption flow documented in `infra/AGENTS.md`.

The `all` audit deliberately excludes this specialized schema probe. No extra database table
grants, SQL parameters, schema names, or file paths are accepted by the public command.
