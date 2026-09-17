# Commercial Text Delete Guard

Commercial text uses the existing `COMMERCIAL_AD_DELETE` durable reason. New
decisions carry a version-1 `commercialTextBinding` with source-text SHA-256,
relevant settings fingerprint, detector source identity, event timestamp and a
five-minute absolute deadline. Raw text is not added to the binding or the guard's
logs. The event timestamp, not processing time, defines the deadline.

## Dispatch Contract

- Each edit has a distinct reason key. The latest event revision wins regardless
  of insertion order; conflicting sources at one timestamp fail closed.
- At every transport attempt, the guard checks current chat settings, local and
  remote author access, configured-bot immunity, one exact MAX message and
  participant immunity. It rechecks settings and deadline after remote work.
- A successful membership lookup that confirms the author has left does not
  exempt an extant, exactly bound ad. Local/admin and participant immunity still
  apply. Transport or malformed membership results remain unknown and cannot
  authorize deletion.
- Bound campaign counters are usable only with their exact original text,
  settings, detector identity and unexpired deadline. Legacy reasons receive a
  fresh classification without unbound campaign counters.
- The guard inspects at most 65 reasons and refuses commercial-only fanout above 64. Independent non-commercial reasons keep their own authorization and guards.
- A concurrent new reason cannot inherit an old guard rejection: the terminal
  transition locks the intent and compares the current reason fingerprint before
  cancelling; a later committed reason can reopen a pre-dispatch rejection.
- Only fresh confirmed deletion with proof for the requested reason can advance
  the commercial sanction ladder or reputation evidence. Exact absence, queued
  work, another revision's deletion and recovered success cannot create a strike.
- Deletion event attribution is limited to the proven reason keys. Late reasons
  and unverified recovered successes are not retroactively credited as commercial
  deletions. Existing historical events are preserved.

## Deploy And Rollback

Run the scoped API, infrastructure and benchmark checks, then require green
`Required` and `Analyze JavaScript and TypeScript` checks for the exact commit.
Deploy through `./infra/scripts/vps-connect.sh deploy main api-admin`; the wrapper
expands this to all shared API roles and the OCR sandbox. No schema migration or
Postgres/Redis recreation is required by this feature.

Both rollback wrappers reject images predating binding v1 and the commercial
pre-dispatch guard. The first compatible release becomes the rollback floor;
older retained manifests are not compatible API rollback targets. A rollback
must retain the guard and reason-scoped proof, including in legacy/off compatibility.
For recovery from the first guard-compatible release, ship a compatible fix-forward
image; do not lower the rollback floor. Delayed legacy action jobs are rejected
because they cannot preserve an in-memory pre-dispatch callback.

Turning off the commercial filter through the existing chat settings prevents
pending commercial-only deletes at dispatch. This is not a global text-policy
rollout control. Do not add or activate a new classifier's canary authority until
its independent evaluation, shared runtime control and promotion review exist.
Commercial OCR remains under its separate shadow/certification policy.

## Verification

- Test source edits, out-of-order revisions, malformed/expired bindings, settings
  and sanction changes, author/admin immunity and exact absence.
- Test terminal guard cancellation versus concurrent/later independent reasons,
  transient retries, recovered success and proof for another requested revision.
- Check all API roles have one exact image with no unexpected replicas/restarts.
  Allow the normal post-deploy queue stabilization window; never shorten it to
  make a smoke pass.
- Observe fresh queue lag and MAX action health. Each commercial-only dispatch
  attempt adds at most two targeted MAX reads; other rules do not gain those reads.
