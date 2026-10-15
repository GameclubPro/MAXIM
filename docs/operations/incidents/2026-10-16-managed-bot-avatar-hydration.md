# Historical bot profile hydration

At `2026-10-15T21:50:40Z` and `21:51:03Z`, the `api-admin` role on
`b2062a302fd0fedb134ed744c5e171ffa9a532e8` logged managed-bot avatar failures
classified as `bot_not_configured`. The bounded `21:44–21:54Z` log observation
was complete for that role, with no truncated or unparsed lines. This explains
those failed bot-profile reads, not every missing community avatar.

The navigation catalog deliberately preserves historical bot bindings that no
longer exist in the runtime registry. Its compatibility predicate accepts such
IDs. Header enrichment reused that predicate to attempt `GET /me`, but the MAX
client correctly refuses a bot without its exact configured credentials.

Profile enrichment now reads existing and cached photos first, then requires
the exact configured bot before a remote profile request. It does not remove
historical cards, replace assignments, grant access, or use a different bot's
profile. The shared visibility predicate and MAX credential boundary remain
unchanged. Ordinary configured bots still hydrate and cache their own profiles;
dormant bots retain their existing remote-read exclusion.

Regression coverage uses the real admin-service compatibility predicate with
saved, cached and missing historical photos. It verifies retained assignments,
no MAX lookup or replacement cache write, and no chat mutation. Existing
configured/dormant profile tests and the focused runtime tests also pass:
415 tests across three focused suites. Deployment and production observations must be
recorded separately; a passing local check is not a release claim.
