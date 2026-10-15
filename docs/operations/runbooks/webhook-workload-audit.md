# Measuring the webhook workload

Use the opt-in `postgres-audit webhook-workload` report before choosing a representative
load fixture. An all-delete fixture measures a deliberately expensive case: separate source,
author and final-effect checks can exhaust the MAX token budget before local worker capacity.
Keep that overload test, and measure the observed event mix separately. Never remove authority
checks or raise MAX quotas just to satisfy a synthetic throughput target.

Review the plan before executing the bounded report, sequentially:

```bash
./infra/scripts/vps-connect.sh postgres-audit webhook-workload --explain
./infra/scripts/vps-connect.sh postgres-audit webhook-workload
```

The report uses the closed five-second receipt-created interval ending 30 seconds before the
query. It selects at most 513 covered heads per status through the attested status/time/id index,
then at most 512 total primary-key payload reads. Selection precedes JSON inspection; only
payloads at most 64 KiB after serialization are classified. Attachment inspection is limited to
16 entries. Existing audit-role, one-session, read-only, query/wall-time and cleanup guards apply.
Serialization still has a cost for an oversized stored value; a timeout fails without a report.
No new table grants, MAX requests, application changes or writes are required.

Output contains finite event/entity/status classes, direct body attachment classes and counts.
Names, content, links, identities, saved semantic keys and raw errors never leave SQL. Linked,
alternative, malformed, oversized and mixed/unknown shapes remain explicit. Direct file/image
classes describe the stored transport shape, not the full runtime media classifier or an OCR job.
`classifications_complete` concerns only this deliberately narrow direct-shape classifier.

Require `nonempty`, `sample_complete` and the relevant classification coverage before deriving
proportions. A saturated sample is the bounded earliest prefix, not a random population sample.
Preserve failed/incomplete reports and compare multiple complete windows across actual peak and
quiet traffic. A single five-second window cannot establish the daily workload.

`receipts_per_saved_key` groups only valid stored keys inside the sampled window. It is not an
execution or deletion count, and mirrors arriving outside the window are absent. Publisher and
moderation namespaces stay distinct. Missing keys are reported independently. Never infer
semantic authority, successful moderation or permission to replay from these counts.

Combine this evidence with the ingress peak collector, closed latency cohorts and separate
function/action outcomes. Features enabled in each chat, benign/violating fractions, native media
costs and remote outcomes require their own evidence. Keep synthetic assumptions explicit when
those measurements are unavailable; do not call an assumed mix a verified production workload.
