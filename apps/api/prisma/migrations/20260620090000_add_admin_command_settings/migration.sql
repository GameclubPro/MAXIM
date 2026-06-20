ALTER TABLE "chat_settings"
ADD COLUMN IF NOT EXISTS "admin_mute_command_aliases" TEXT NOT NULL DEFAULT 'мут, мьют, мью, mute',
ADD COLUMN IF NOT EXISTS "admin_rules_command_aliases" TEXT NOT NULL DEFAULT 'правило, правила, rule, rules';
