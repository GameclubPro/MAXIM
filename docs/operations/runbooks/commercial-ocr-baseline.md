# Strict Commercial OCR Baseline

Commercial OCR baseline actively deletes strongly confirmed photo advertisements
in chats with `commercialAdsFilterEnabled`. It does not apply OCR-driven warnings,
mutes or bans. Two consistent OCR passes, critical-evidence confidence at least
900/1000, commercial score at least 90, complete album identity, safe-caption/script
vetoes and the immutable source/deadline checks remain mandatory.

## Release

Run local impact checks, real disposable PostgreSQL/Redis checks and exact-SHA CI.
For initial activation use the normal guarded deploy:

```bash
MAXIM_COMMERCIAL_OCR_BASELINE=1 ./infra/scripts/vps-connect.sh deploy main --auto
```

The wrapper verifies the target's v5-capable worker and dispatch guard. The normal
shared-image transition acquires its release journal and globally quiesces webhook
producers, then stops old media analysis before atomically persisting only
`COMMERCIAL_OCR_ROLLOUT_MODE=baseline` and empty canary IDs in production `.env`.
All 14 effective and running API roles must match that authority and source version.
The native sandbox remains isolated, without network or secrets. Exact image and
native identity, language recognition, UDS raster, internal readiness and ordinary
API/static smokes must pass before the release manifest is recorded.

Baseline is an image-owned `BASELINE` authority, not a certificate or a made-up
Redis control. It binds release behavior, attested live native behavior and current
settings. `CERTIFIED` expansion keeps the independent temporal-corpus, trusted
signature and fresh exact-chat control gates. Native health or synthetic examples
cannot be represented as measured population precision.

## Read-only verification

Inside `api-media-analysis`, run the built
`apps/api/dist/apps/api/src/scripts/audit-commercial-ocr-images.js` with an explicit
`--lookback-hours 1..24`. It uses the bounded indexed production receipt scan,
at most 500 receipts and three unique photos, actual opted-in settings and the
native UDS client. Output is aggregate counts/status/latency and native identity;
it sends/deletes nothing and stores no photo URLs, contacts or OCR text.

## Disable and recovery

The existing per-chat commercial-filter switch immediately removes both text and
photo authority, including pending commercial-only deletes. For an environment
emergency, `commercial-ocr-recover-shadow [--apply]` remains the guarded bounded
operator recovery. Its applied path stops producers/action before lowering the
environment authority and proves the exact release fence before restarting.

Both API rollback paths reject a target without the strict v5 baseline dispatch,
baseline-capable durable intent executor and live-native worker checks. Only the
commercial OCR intent mode maps `baseline` to execution; other rule modes retain
their own rollout controls. Earlier pending v4 commercial bindings are rejected
without deletion. Use a compatible fix-forward or reviewed compatible manifest;
do not weaken the rollback floor or bypass the webhook fence. Postgres and Redis
remain running throughout application transitions.
