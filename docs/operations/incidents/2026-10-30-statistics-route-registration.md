# Statistics route registration failure — 2026-10-30

The normal shared API release of `1603afff33d2f18f63b5cf91471de127646332ca`
failed HTTP readiness with `FST_ERR_DUPLICATED_ROUTE` for
`/api/v1/internal/statistics/authorities:resolve`. Fastify interpreted the
unescaped action suffixes as parameter names, so `authorities:batch` and
`authorities:resolve` registered the same route. The deployment retained its
global webhook pause after the failed transition.

The existing tests exercised services and a manually registered ingest route;
they did not bootstrap the real statistics controller through Nest's Fastify
adapter. The added controller regression reproduced the duplicate-route failure
before the correction. The statistics HTTP registration hook now escapes only
the four exact contract action paths after determining their byte limits.
Controller declarations, wire URLs, authentication and the installed lifecycle
source checks remain compatible.

Focused local validation passed 26 tests through the public API test wrapper:
actual controller bootstrap, distinct handler dispatch, authentication, schema
rejection, unknown suffix refusal, exact 64/128 KiB request limits and existing
chunked-body protection. These checks establish the local correction; they do
not establish CI, successful deployment, queue resumption or production
acceptance. Recovery must preserve applied migrations, compatibility floors,
the shared deployment lock and the recorded queue pause until all roles are
verified on one reviewed image.
