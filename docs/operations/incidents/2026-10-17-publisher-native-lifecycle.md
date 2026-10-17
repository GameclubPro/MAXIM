# Publisher selection native lifecycle failure — 17 October 2026

A `test` selector transition paused webhook processing and Publisher dispatch, then failed because the controller requested sandbox-only OCR attestation while the existing media consumer still ran. This was an internal rollout defect. It does not establish the cause of separate MAX API failures or missing upstream events.

## Exact scope and evidence

- Controller/API source: `a9c3c95db2746f9ab2d90e3e624df792d723368f`; exact Required and CodeQL passed.
- Shared API image: `sha256:d582acbb455246860f710ebc6ca6ed52ad4aabbf98cc32febdb89531e80f3278`.
- Both read-only previews passed. Pre-apply health at 14:05:45 UTC was normal/healthy, DB/Redis ready, waiting zero and lag 0.152–0.171 s; dispatch status showed no pause and a fresh enabled heartbeat.
- Local apply ran 14:07:40.749–14:08:16.577 UTC, exit 1. The remote failed audit ran 14:07:54.122–14:08:16.597; its 20 ms lead over local completion remains explicit. The operator marker was acquired at 14:07:54.509.
- The setter changed the selector dotenv to `test`, paused webhook queues, stopped enqueue and seven moderation roles, and recreated action, Publisher, retention, admin and ingress. OCR attestation then refused the still-running media consumer. It did not authorize an unexpected volume consumer.
- Independent inventory at 14:14:40.668 confirmed six running and eight stopped API roles on the same exact image. Five recreated roles had `test`; the remaining nine retained absent/default `off`. Dispatch remained configured true. Both native auxiliaries, static applications and stores remained running; PostgreSQL/Redis generations were unchanged.

The diagnostic monitor observed all 24 webhook queues paused with an owner from 14:08:05.447. Ready/admin checks were false from 14:08:34.930 while DB/Redis remained available. Fleet visibility was unavailable during the subsequent deployment; unknown observations are gaps, not zero running roles. The monitor recorded maximum sampled raw/operational lag 650.189 s at 14:18:50.845. Queue lag is not request latency or the terminal outcome of a specific operation.

## Restoration

The failed setter was not retried. Source review also found that guarded disable's allow-stopped API inventory still required running native consumers, so simply stopping media before invoking disable would not restore the fleet. The shared deployment path already had the correct consumer-stop/native-start sequence.

An ordinary explicit shared-API deploy of the same exact green source/image adopted the existing owned webhook fence. It ran 14:17:01.878–14:20:38.461 UTC, exit 0, reused the immutable image and committed `release-20261017T141705Z-a9c3c95db274`. Strict API/native smokes passed. The selector dotenv remained `test`; no application or quota change was made. The original failed selection audit was retained.

The monitor first observed the resumed webhook fence at 14:18:50.845, ready/admin true at 14:20:35.245, and all 14 API roles at 14:20:49.959. Independent inventory at 14:22:48.541 confirmed all 20 API/native/static/store containers running, exact shared image/manifest, unchanged stores/static and zero restarts. A later inventory at 14:26:28.603 recorded one OCR restart, started at 14:23:29.435; all API and photo restart counts remained zero. The cause of that OCR restart is not established by inventory. Normal/healthy was first observed at 14:25:35.470.

The deployment did not clear Publisher's separate operator pause. A new, incident-specific read-only proof identified the unique failed off-to-test audit and its persistent operator marker, with no preserved authorization pause and a fresh disabled heartbeat. Preview and apply independently bound that audit, marker digest, current helper, exact source/image/manifest and all 20 container generations from a new 14:33:51.407 inventory. All 14 API roles had `test` and dispatch enabled. That inventory recorded two OCR restarts, with every API/photo restart count still zero.

The new owner-CAS recovery ran 14:37:49.924–14:38:04.320 UTC and returned exit 0. It cleared only the proved marker, confirmed a fresh enabled heartbeat, and retained all 20 generations and the failed audit. It did not change dotenv, queues, SQL, deadlines or external effects. The earlier 12:17 incident authority was not reused. Independent stock status then confirmed exact runtime, no pause and fresh enabled heartbeat. Health at 14:39:01.366/382 was normal/healthy with DB/Redis available, waiting zero and lag 0.092/0.107 s. Those observations prove restoration of the inspected runtime, not successful completion of every operation delayed during the pause.

## Corrective implementation and remaining acceptance

The controller must stop only the exact media consumer, under the existing webhook fence and bounded stop/readback, before sandbox-only OCR attestation. The native sandbox remains running; the normal media replacement and strict with-media attestation follow. Interrupted disable recovery additionally needs explicit stopped-consumer attestation: exact image, service, generation, exited state, native profile and read-only socket mount remain required, while the only running IPC consumer is the sandbox. Ordinary running paths retain their existing requirements.

Focused tests must execute consumer-state transitions and rejected stop/identity/IPC cases. String-presence checks alone did not expose the incompatible preconditions. Exact CI, delivery and production acceptance remain separate from a local pass.

The incident window is not a successful functional acceptance window. After resume, the diagnostic rolling counter briefly reported up to 25 critical failures; it counts overlapping observations and does not identify unique effects. The delayed operations have not been joined to all durable receipts or terminal outcomes. No queue clearing, deadline extension, uncertain-effect replay, removal of holds or fabricated completion is authorized. Test selector exposure and saved marked-scenario receipts remain required before expansion.
