# Mini App Unavailable After Docker Restart

## Observed

- The canonical `https://major-maksimov.ru/app/` returned HTTP 502. Local API port
  3001 was unavailable.
- All 13 MAXIM API containers, the OCR sandbox, active static containers, Postgres
  and Redis were stopped. Existing containers and named data volumes were present.
- Container stop times were around 2026-09-17 20:00 UTC, or 23:00 Moscow time.
  Docker's active timestamp was 20:00:54 UTC. The host had not rebooted and the
  inspected containers had `OOMKilled=false`.
- No MAXIM backup/restore job or deployment lock was active during diagnosis.
- The Docker restart is confirmed; its initiator and the reason containers were
  left stopped were not established. Do not infer them from the exit codes alone.

## Recovery

Existing MAXIM containers were started under the repository deployment lock,
without recreating data volumes, running migrations or building images. Every API
role and the sandbox was checked against the active release manifest before startup.
The retained API image was `f201e032f0ce1fe19f6a6e1511bd09129dcabb05`.

Postgres, Redis and the active static services were started first. HTTP/API roles
and the sandbox followed. The checked-in prestart native OCR UDS smoke passed
before media analysis, moderation and enqueue were started. Sibling applications
and retired legacy services were not included in recovery.

The in-progress commercial-filter changes remained local and were not deployed.

## Verification

- Canonical HTML, JavaScript and CSS returned HTTP 200.
- The public API live endpoint returned HTTP 200. Ingress and admin readiness
  recovered with database/Redis checks passing; observed queue lag fell below
  one second. The normal five-minute stabilization window was not bypassed.
- Runtime monitoring confirmed 13 expected API roles on the exact manifest image,
  with no duplicates, unexpected API containers or restarts after recovery.
- The public privacy page rendered in Chromium with no page errors. An unsigned
  request to the chats API correctly returned HTTP 401 after its slash redirect.
  An actual signed MAX user session was not available for an end-to-end login test.
- Read-only PostgreSQL queue/activity reports confirmed existing application data
  and active processing. No raw SQL or manual queue/state repair was performed.

After shared-host Docker maintenance, verify the complete MAXIM fleet, canonical
static delivery and both API readiness endpoints. `unless-stopped` must not be
treated as proof that intentionally stopped containers will return automatically.
Do not blanket-change restart policies: some rollout failure paths deliberately
leave workers stopped until their execution authority is verified.
