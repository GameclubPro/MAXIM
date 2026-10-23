# Zod security update and browser bundle baseline

The Zod 4.6.6 update fixes the high-severity
[GHSA-mrhx-c7xc-m3w5 advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
API, contracts and mini app use this patched dependency together. Fastify is also
patched to 5.12.6. Neither retaining the vulnerable version nor removing input
validation is an acceptable bundle optimization.

Zod's retained classic schema runtime grows from approximately 18.88 kB gzip
(rounded output from the previous build) to 25,939 bytes. The previous exact byte
count is unavailable; the shared-chunk increase is approximately 6.9 KiB. Its
per-instance JSON Schema and Standard Schema support remains reachable through
the schemas used by the application. No accidentally retained locales, compiler
or unnecessary runtime contract imports were found. Changing the import to
`zod/v4` selects the same implementation; Zod Mini has a different API.

An in-memory tree-shaking experiment marking every top-level side-effect-free
contract schema constructor pure saved less than 1 KiB per route and left the
affected gates failing. Standard Terser compression saved only 352 bytes on the
shared chunk. Neither experiment is shipped. Migrating all shared schemas to a
different API is a separate behavior change requiring its own validation.

The following nine JavaScript budgets explicitly accept the security update's
download cost. New caps round each measured closure up to the next 256 bytes;
they add no discretionary growth allowance. Passing route limits, startup
allowances, CSS limits, the 320-byte measurement tolerance, manifest closures and
baseline subtraction retain their existing definitions. These are gzip byte
measurements, not real-device latency claims.

| Route budget | Previous cap (B) | Patched build (B) | New cap (B) |
| --- | ---: | ---: | ---: |
| Chat settings | 157,696 | 165,024 | 165,120 |
| Shared network settings | 168,960 | 175,820 | 175,872 |
| Complete network editing | 219,136 | 225,635 | 225,792 |
| Network cold recovery | 196,608 | 198,544 | 198,656 |
| Comments dialog | 68,608 | 72,730 | 72,960 |
| Comments cold launch | 176,128 | 180,740 | 180,992 |
| Publisher entities | 45,312 | 49,741 | 49,920 |
| Publisher entity modules | 51,200 | 56,102 | 56,320 |
| VK parsing card | 88,064 | 88,440 | 88,576 |

The measurement uses the unchanged production build configuration and includes
transitive static dependencies. The canonical absolute API origin must also pass
`npm run build:miniapp:production`; no validator is moved out of the measured
closure. Current executable caps live in
[`route-budgets.json`](../../apps/miniapp/route-budgets.json).
