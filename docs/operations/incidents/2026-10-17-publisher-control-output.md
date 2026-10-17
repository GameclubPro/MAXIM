# Publisher control response failure — 17 October 2026

The `test` temporal-selector apply failed after acquiring a Publisher operator pause. The resulting interruption was internal to the rollout command. It does not establish the cause of separate MAX API delays or missing upstream events.

## Source and observed interval

- Controller and shared API source: `cb6ea769596ee245acd5c932f477429509fc61ff` (PR #204), with exact Required and CodeQL success.
- Shared image: `sha256:9b3f5d69c3ab3e0d1b94ef87abfff2d3f83f597b5ff1109f03751c97308a33ae`.
- Release manifest: `release-20261017T120744Z-cb6ea769596e`; ordinary deploy completed at 12:10:36 UTC.
- Failed selection audit: started 12:17:31.379 UTC, marker acquired at 12:17:31.883, terminal failure at 12:17:32.126. The local command returned exit 1 at 12:17:32.085; the 41 ms clock difference is retained.
- Owner recovery ran 12:34:39.081–12:34:50.981 UTC and returned exit 0. This interval bounds completion; no exact external publication-delivery time is inferred.

## Cause and restoration

The control helper was invoked through `docker compose run`. Compose volume-configuration warnings appeared on stdout before the helper JSON. Redis had acquired the persistent operator marker, but the caller failed JSON parsing before setting its cleanup state. No volume recreation was accepted. Independent readback proved that the selector remained absent/default `off`, dispatch remained enabled, and all 20 API/native/static/store container generations matched the pre-attempt inventory.

A private, reviewed one-incident recovery required the existing deploy lock and ordinary effect authority, exact clean source/image/full manifest, the unique failed audit in the fixed incident interval, unchanged runtime/env, current health and Publisher identity. It required an operator marker created within that audit, with no preserved authorization pause, and bound preview/apply to the same evidence digest. The only operational mutation used the existing owner-CAS to clear that marker through the already running exact admin container. Original audit, queues, SQL, deadlines, images and containers were retained. No SEND was issued by the recovery.

Initial read-only recovery previews refused before mutation. One comparison incorrectly hashed a six-field inventory projection as a complete manifest; the independently read full manifest retained every baseline field and additionally contained its recorded creation time and null emergency reason. Another comparison incorrectly used the local completion clock as an upper bound for the remote audit. Both were corrected within the original 12:17:18–12:17:33 incident envelope; marker admission remained bounded by the exact remote audit times. Rejected previews and original evidence were preserved.

Independent status after recovery confirmed dispatch enabled, no pause, and a fresh enabled heartbeat. At 12:35:05 UTC, ingress/admin reported normal/healthy, PostgreSQL/Redis ready, queue lag 0.403–0.425 s and zero readiness-waiting entries. All 20 generations and the failed audit remained unchanged. A mixed diagnostic monitor ended at 12:30:53; the gap before the next collector is explicit and cannot count as acceptance.

A separately attested read-only Safety Desk probe at 12:40:12 UTC returned five successful requests. Its complete 12:24:42–12:39:42 recipient-created cohort contained 395 SENT rows with saved receipts, 393 awaiting verification and two automated-stable. One exact delivery proof agreed with its confirmed action journal; client visibility remained unobserved. The independent occurrence cohort contained five future scheduled and eleven in-progress occurrences, without a joined proof of why each remained active. These windows do not cover the full pause or establish delivery latency for all affected work. The later 30-second webhook cohort contained 378 PROCESSED, 184 DUPLICATE and nine QUARANTINED, with no FAILED. The DELETE cohort was incomplete at its 512-SUCCEEDED cap and retained 132 acknowledged receipt-settlement waits and two terminal failures.

## Corrective change and acceptance

The controller correction uses an inspected exact running admin container for control operations and a bounded framed response tied to a fresh nonce and action. Stopped-fleet disable/clear recovery retains its supported one-off path with closed stdin. Missing, malformed or lost mutation acknowledgements remain explicitly uncertain; the command must not retry automatically or report that no pause exists. Existing read-only monitoring remains compatible. Focused tests cover contaminated output, lost acknowledgements, wrong identity, ownership races and stopped-fleet recovery.

Implementation, checks, exact CI and deployment are separate gates. The incident does not close publication acceptance: delayed/expired operations during the pause have not been joined to durable outcomes, historical quarantine and unknown effects remain, and a healthy heartbeat does not prove delivery or MAX client visibility. No deadline extension, uncertain SEND replay or artificial completion is authorized. Selector expansion still requires the designated live scenarios and the full observation windows in the [rollout runbook](../runbooks/publisher-temporal-selection-rollout.md).
