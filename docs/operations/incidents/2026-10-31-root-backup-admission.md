# Root backup admission refusal — 2026-10-31

A production bot audit found no verified independent-copy or restore receipt for the main
database under its actual systemd configuration. Its timers were disabled. The separate
Lastik profile had fresh verified evidence; it does not cover the main database.

At `2026-10-31T09:16:48Z`, after strict readiness and capacity preflight passed, the normal
main backup unit refused before product admission. The production tooling source was
`895cc0cbe10bae80a3379348fc98a355699d20d2`; all application components retained the committed
`7cddcd5678dbb744f36cbd021c580b3fddfd02d9` release. No dump started.

The new shared admission created its owner as root but required operator ownership when
asserting it. The failed acquisition left an unresolved owner after its kernel lock closed.
The backup unit accepted exit 75 as success and later cleared its transient process metadata.
The trusted journal retained the pre-admission refusal. Root systemd Git reads also returned
missing checkout identities because the process had no `SUDO_UID`; the old snapshot's two
missing fields explain its different hash without implying manifest or configuration drift.

The correction assigns operator ownership before publishing the owner and uses command-local
trust for the two fixed Git source reads. Two real cross-UID regressions fail on the old source
(owner assertion exit 70 and missing source SHA) and pass with the correction. A separate
recovery controller requires the original owner, sources, unit and trusted refusal journal,
stable product state, absence of actors and all three fixed kernel locks before durably
archiving the unchanged owner with its proof.

The preceding six-minute read-only baseline had 13 complete samples: all 14 exact API roles
running, no new restarts, all 24 sampled queues unpaused, ingress/admin ready and automatic
normal mode. Queue lag was 0.107–3.128 seconds. All six configured moderation bots had recent
remotely confirmed event rows in individual bounded samples. Some samples were capped, and
rolling action windows included isolated critical failures. These observations do not prove
every feature, input or remote effect. Historical quarantines and publication access blockers
remain distinct from new failures and grant no replay authority.

At the time this record was written, exact CI, the dedicated refusal recovery, paired tooling
installation and the main backup/copy/restore acceptance sequence were still pending. No
backup, full fleet acceptance or corrective application deployment is claimed by this record.
