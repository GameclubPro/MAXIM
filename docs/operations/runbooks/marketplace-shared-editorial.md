# Shared marketplace description editing

A current administrator can edit the description of an existing «Биржик» card
without becoming its commercial owner. The separate editor displays the
responsible person. Commercial fields, publication state, owner binding,
statistics consent and button enablement are absent from its mutation contract.
The existing owner workspace remains available to the responsible user.

## Version 1 routes and data

The signed mini app calls GET/PATCH
`/api/v1/marketplace/entities/:kind/:entityId/editorial?profile=...`.
The server derives actor and profile from the authenticated launch. PATCH accepts
only `requestId`, `listingId`, `ownershipKey`, `expectedRevision`, and `description`.
The relay uses GET/PATCH
`/market/api/integrations/maxim/v1/editorial` on the fixed marketplace host and
adds the exact actor, entity, kind, profile and actor-specific binding ID.
It never calls the old profile mutation or writes its cached owner snapshot.

The Market owns the card revision and immutable owner identity. It applies CAS
and request idempotency under its database lock, changes only the description
and its profile revision, and returns conflict on a stale card or owner. Text is
trimmed and limited to 1,500 UTF-16 units; ordinary marketplace cards require at
least 30 units, while profile-only cards allow one. The read contract retains
existing shorter descriptions. Native owner forms also need the current CAS.

A missing card returns 404; it never becomes a create request. The relay validates
entity, kind, card, owner key, revision, expiry and the public deep link before
returning a response. Routes send `Cache-Control: no-store`. Old strict `/entry`,
`/profile?view=2` and `/button-policy?version=2` contracts remain compatible.

## Separate access proof

The authenticated integration callback is
POST `/api/v1/integrations/svyazka/v1/editorial-access`. Its strict request and
response repeat version 1, scope `PROFILE_DESCRIPTION`, request ID and exact
actor/entity/kind/profile/binding identity. The response adds ACTIVE, REVOKED or
UNKNOWN, binding revision, observation time and expiry; it exposes no statistics
or commercial grant.

The callback uses the existing interactive exact-bot MAX attestation, then
checks known removal, bot state, current SQL access and the final binding
revision. ACTIVE evidence is at most 30 seconds old and expires no later than
30 seconds after its actual observation. A failed fresh attempt stays UNKNOWN;
an older successful proof does not conceal it. Known denial is REVOKED.
Publisher's existing five-second job coalescing remains in place. This is bounded
freshness, not atomic revocation across two services. The Market records issued,
finished and denied request sequences so a late positive reply cannot override
its later known denial.

The old Publisher queue admitted legacy requests only for its pilot actor, which
blocked a second administrator even with valid MAX rights. The narrow
`PROFILE_DESCRIPTION` and `BUTTON_POLICY` queue scopes admit current administrators
without a statistics grant or statistics allowlist. Existing unscoped and
statistics admission remains unchanged. Description proof is interactive only;
button background refresh still uses its governor, limits and durable consent.
Enabling a button retains exact actor/bot checks, a public card, per-module opt-in,
caption revision and the confirming administrator. It neither changes the card
owner nor revives a module after a known removal without fresh confirmation.

## Regression evidence and release boundary

The focused PostgreSQL/Redis/HTTP suite passed 100 tests locally on 2026-10-30,
covering two administrators, concurrent removal, the final revocation fence,
unknown fresh reads, unchanged consent, relay identity, queue scopes, background
admission and existing button policy. The earlier independent profile/relay
compatibility run passed 84 tests. The shared 31-case wire fixture is identical
in both repositories and checks strict fields, UTF-16 limits, roles and proof
lifetimes. Peer contract tests include
`marketplace-editorial-wire.spec.ts`; Market consumes the same JSON in
`listing-editorial-wire.test.ts`.

The UI retains drafts on conflict, expired access and lost replies. It requires
an authorized read before rebasing and never uses an editorial 404 to create a
card. Its focused 16-case browser matrix covers chats/channels, both profiles,
320/390 px, both themes, keyboard, Back, conflicts and expiry; screenshots were
inspected without replacing baselines.

Deploy the compatible Market endpoint/CAS first, then the peer API and mini app.
During that interval the new editor can remain unavailable. Local tests and
browser fixtures do not establish real MAX/device acceptance; verify the deployed
routes and the authorized administrator scenario after both releases.
