# Explicit bot activation

The six moderation bots (two Majors, two Majorshas and two Rexes) share moderation ownership. Publik is a separate Publisher and can operate beside an eligible moderator in the same chat.

A known loss of rights, confirmed ordinary membership, removal, or a new pending activation prevents that exact bot from serving the chat or passively probing itself back into service. Expired cache entries, lifecycle observations, cabinet refresh and scheduled discovery cannot clear this state. Unknown transient MAX responses do not manufacture a permanent denial for an existing active bot.

An administrator can activate the receiving bot by sending `Старт` in the group or forwarding a message from the destination into that bot's private dialog. Activation requires a fresh authenticated webhook receipt, matching destination and bot, independent explicit human admin/owner evidence, and the exact bot's required capabilities. Group Start can silently activate each receiving bot while shared command authority allows at most one successful public confirmation. Forward activation cannot select another bot. Callback navigation does not activate a bot.

Moderators require their baseline read/delete capabilities; optional member, edit and send rights cannot grow through a passive refresh after known loss. Publisher uses its separate publication permission policy. Bot rights denial in one scope does not revoke another bot's independently verified rights.

Night-mode scheduling and its close-notice audit use the same activation and send-capability
limits. An active membership alone cannot make a known denied bot eligible. Exact current
jobs defer before entering the sender while ordinary reconciliation removes obsolete schedules;
unknown legacy permissions remain eligible for a guarded refresh. An independently eligible
peer keeps the chat runnable. Only fresh explicit activation can restore a retained capability
ceiling, and it does not authorize announcements for expired sessions or replay uncertain sends.

A legacy connection callback can receive `ManagedEntityActivationRequiredError` from its initial bot-access check. The handshake records `BOT_DENIED` with `explicit_activation_required` and returns a silent denial, allowing normal webhook preparation to finish without activating the bot or retrying this permanent refusal indefinitely. Preserve the callback cooldown. Errors with copied text, failures after the initial probe, and failed outcome persistence remain failures; this narrow path grants no replay or mutation authority.

Unclaimed ordinary observations with no eligible moderator are durably settled with `DORMANT_BOT_OBSERVATION_V1`, without creating or completing shared execution authority. First observations create only a context Chat shell to serialize against simultaneous initial activation. The validated activation source time remains in the membership snapshot across passive refreshes; a later activation cannot authorize an older observation, even when activation commits before preparation starts. A peer already eligible for that observation may still process the source. Settled observations never replay after activation; existing owned claims, unknown mutation outcomes and permanent source holds remain intact.

## Delivery and rollback

Deploy the shared API image to every production API role using the normal queue-fenced exact-SHA path. There is no bulk rights reset, database backfill or permission probe requirement. Validate native PostgreSQL/Redis coverage for activation races, peer routing and receipt settlement, then inspect fresh natural traffic without test messages in user chats.

Both `rollback-runtime` and the API component of `rollback-release` enforce `assert-managed-entity-activation-source.mjs` before runtime mutation. Reader version 1 covers the durable receipt marker, activation source boundary, negative/pending state, capability ceiling, final route and transport readers, and Publisher activation consumers. Retain the guard even when no affected bot is currently active; old rows and queued jobs survive image changes. A schema-compatible image predating these readers is not a valid API rollback target. Static-only rollback is unchanged.
