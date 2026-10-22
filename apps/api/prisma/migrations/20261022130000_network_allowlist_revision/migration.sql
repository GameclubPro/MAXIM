-- FLAG: The additive revision covers legacy writers too; one statement advances each affected Chat once.
ALTER TABLE "chats" ADD COLUMN "navigation_allowlist_revision" INTEGER NOT NULL DEFAULT 0;

CREATE FUNCTION bump_navigation_allowlist_revision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE chats SET navigation_allowlist_revision = navigation_allowlist_revision + 1
  WHERE id IN (SELECT DISTINCT chat_id FROM new_allowlist_rows);
  RETURN NULL;
END $$;

CREATE FUNCTION bump_navigation_allowlist_revision_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE chats SET navigation_allowlist_revision = navigation_allowlist_revision + 1
  WHERE id IN (SELECT DISTINCT chat_id FROM old_allowlist_rows);
  RETURN NULL;
END $$;

CREATE FUNCTION bump_navigation_allowlist_revision_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE chats SET navigation_allowlist_revision = navigation_allowlist_revision + 1
  WHERE id IN (
    SELECT chat_id FROM (
      (SELECT chat_id, domain, remove_after_at FROM new_allowlist_rows
       EXCEPT SELECT chat_id, domain, remove_after_at FROM old_allowlist_rows)
      UNION
      (SELECT chat_id, domain, remove_after_at FROM old_allowlist_rows
       EXCEPT SELECT chat_id, domain, remove_after_at FROM new_allowlist_rows)
    ) changed
  );
  RETURN NULL;
END $$;

CREATE TRIGGER navigation_allowlist_revision_insert AFTER INSERT ON domain_allowlist
  REFERENCING NEW TABLE AS new_allowlist_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_navigation_allowlist_revision_insert();
CREATE TRIGGER navigation_allowlist_revision_delete AFTER DELETE ON domain_allowlist
  REFERENCING OLD TABLE AS old_allowlist_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_navigation_allowlist_revision_delete();
CREATE TRIGGER navigation_allowlist_revision_update AFTER UPDATE ON domain_allowlist
  REFERENCING OLD TABLE AS old_allowlist_rows NEW TABLE AS new_allowlist_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_navigation_allowlist_revision_update();
