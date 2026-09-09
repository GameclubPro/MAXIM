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
4. When every column and enum matches and only the existing due index is invalid, use the fixed
   `./infra/scripts/vps-connect.sh recover-publication-post-actions-migration` preview. It also
   verifies the exact active Prisma record and checksum under the shared deploy lock. No record
   is marked successful from the catalog report alone.
5. After reviewing a `reindex`/`failed` result, the same command with `--apply` requires green
   exact-SHA CI and a healthy runtime. It runs `REINDEX INDEX CONCURRENTLY` for that index only,
   confirms the complete schema, resolves the verified migration with the retained immutable
   Prisma image, and verifies both schema and record again. Column drift, a missing index,
   leftover concurrent-reindex artifacts, a different checksum, and non-lock failures abort.
   The reindex has a two-minute server deadline, a 30-second lock deadline, and exact-backend
   cleanup; its isolated Prisma container is labeled and removed on interruption.
   Online recovery is limited to a delivery table of at most 512 MiB, disables parallel index
   workers, caps maintenance memory at 32 MiB, and caps temporary files at 256 MiB. Larger
   tables require a separately reviewed maintenance plan rather than raising these limits.
6. Do not edit a committed migration, drop existing columns, or hand-write `current.json`.
   Resume a reviewed interrupted deployment only with the typed transition journal and the
   normal queue-fence adoption flow documented in `infra/AGENTS.md`.

The `all` audit deliberately excludes this specialized schema probe. No extra database table
grants, SQL parameters, schema names, or file paths are accepted by the public command.
