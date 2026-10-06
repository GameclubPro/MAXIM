-- FLAG: Operational abandonment is not execution success. Commit the enum addition
-- separately before any constraint or guarded writer can use the new value.
ALTER TYPE "WebhookStatus" ADD VALUE 'NO_REPLAY_HELD';
