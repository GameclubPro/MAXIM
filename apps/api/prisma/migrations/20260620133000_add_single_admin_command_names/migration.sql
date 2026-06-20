ALTER TABLE "chat_settings"
ADD COLUMN IF NOT EXISTS "admin_ban_command_name" TEXT NOT NULL DEFAULT 'бан',
ADD COLUMN IF NOT EXISTS "admin_mute_command_name" TEXT NOT NULL DEFAULT 'мут',
ADD COLUMN IF NOT EXISTS "admin_permanent_mute_command_name" TEXT NOT NULL DEFAULT 'мут 88',
ADD COLUMN IF NOT EXISTS "admin_rules_command_name" TEXT NOT NULL DEFAULT 'правило';

UPDATE "chat_settings"
SET
  "admin_mute_command_name" = COALESCE(
    NULLIF(trim(regexp_replace(split_part("admin_mute_command_aliases", ',', 1), '\s+', ' ', 'g')), ''),
    'мут'
  ),
  "admin_rules_command_name" = COALESCE(
    NULLIF(trim(regexp_replace(split_part("admin_rules_command_aliases", ',', 1), '\s+', ' ', 'g')), ''),
    'правило'
  )
WHERE
  "admin_mute_command_aliases" IS NOT NULL
  OR "admin_rules_command_aliases" IS NOT NULL;
