# Commercial Filter Upgrade Plan

Дата ревизии: 2026-06-13.

Документ описывает практический план дальнейшего апгрейда commercial ad filter после точечных runtime-исправлений по 24h-аудиту. Цель: поднять precision на safe-context сообщениях, сохранить recall по явной коммерции и сделать каждую блокировку объяснимой для аудита.

## Scope

Зона фильтра:

- `apps/api/src/moderation/commercial/`
- `apps/api/src/moderation/commercial-benchmark.spec.ts`
- `apps/api/src/moderation/commercial-corpus-fixture.spec.ts`
- `apps/api/src/scripts/audit-commercial-filter.ts`
- `apps/api/src/scripts/validate-commercial-corpus.ts`
- `apps/api/src/moderation/commercial-corpus.fixture.jsonl`

Ключевые safe-context классы для апгрейда:

- обсуждение рекламы как темы;
- жалобы на спам и мошенников;
- правила чата и модерационные инструкции;
- новости, аналитика, предупреждения, обзоры рынка;
- личные разовые продажи без коммерческого CTA;
- упоминания брендов и маркетплейсов без оффера;
- обычные вакансии, обучение, муниципальная/социальная помощь.

## 24h Audit Loop

1. Выгрузить 24 часа кандидатов на VPS из `api-admin`:

```bash
docker compose -p infra -f infra/docker-compose.yml exec -T api-admin \
  node apps/api/dist/apps/api/src/scripts/audit-commercial-filter.js \
  --since <iso-24h-ago> \
  --until <iso-now> \
  --limit 5000 \
  --sample 0 \
  --export-jsonl /tmp/commercial-audit-24h.jsonl \
  --export-corpus-jsonl /tmp/commercial-corpus-24h.jsonl \
  --export-all-corpus
```

2. Разобрать выборку по `policyCategory`, `segment`, `current.actionBand`, `current.reasonCodes`, `current.matchedSignals`, `current.negativeSignals`.
3. Отдельно разметить buckets:
   - `rules_or_moderation_context`;
   - `spam_complaint_or_fraud_warning`;
   - `news_or_analytics`;
   - `brand_mention_only`;
   - `private_one_off_sale`;
   - `ordinary_recruitment`;
   - `public_training_or_help`;
   - `true_commercial`.
4. Для каждого false-positive кандидата сохранить минимальный sanitized текст, expected action, expected subtype, current signals и желаемый suppressor/threshold.
5. Повторить audit после каждого изменения фильтра на новом 24h окне и на frozen corpus.

## Latest 24h Audit Baseline

Окно `2026-06-14T17:13:57Z..2026-06-15T17:13:57Z`, prod `api-admin`,
`--limit all`, aggregate summary plus sanitized miss extraction:

- candidates: `18655`;
- evaluated after bot/admin/service skips: `13999`;
- stable clear: `11923`;
- stable hit: `910`;
- current only: `1160`;
- historical only: `6`;
- dangerous action counters: `delete_false_positive_candidates=0`,
  `gray_delete_candidates=0`, `campaign_only_delete_candidates=0`.

This slice fixed or pinned regressions for:

- short goods/plant misses: unit-price flowers and herbs are retail candidates,
  while low-quantity private plant giveaways stay allowed;
- new high-risk recall/precision guards: debt-relief leadgen, paid marketplace
  reviews, survey/referral payouts, app directory promo, bulk leadgen, paid
  channel placement, and their discussion/complaint false-positive neighbors;
- historical-only-style misses: bulk material sale, MAX/MAH reply CTA contact,
  service/produce audit cases already covered locally;
- false-positive suppressors: local news subscribe channel, public/library
  master-class signup, currency-rate news;
- private seedling leftovers: small leftover/self-pickup listings stay allowed,
  while structured nursery clearance stock remains commercial;
- second-stage cache key: include sensitivity and rounded strictness.

Second post-deploy audit window
`2026-06-14T17:39:27Z..2026-06-15T17:39:27Z`, prod `api-admin`,
`--limit all --sample 0`, confirmed the main safety gate:

- candidates: `18550`;
- evaluated after skips: `13926`;
- stable clear: `11850`;
- stable hit: `915`;
- current only: `1157`;
- historical only: `4`;
- delete false positives, gray deletes, and campaign-only deletes: all `0`.

Remaining hard cases should stay narrow:

- `400р.кг + phone` must not become a generic unit-price-plus-phone rule until
  a product noun or repeated product context is available.
- Short cargo service and channel self-promo coverage should be pinned with
  regressions before adding duplicate rules.
- Beauty/hair salon ads should require a procedure plus contact/address anchor,
  not a bare `salon` marker.

Do not interpret every `safeContextBucket` hit as a false positive. The 24h
audit showed wide buckets such as `news_or_analytics` and
`private_one_off_sale` can contain true ads because the bucket classifier is a
triage heuristic, not a labeler. Use sanitized samples plus matched signals and
action evidence before adding broad suppressors.

Локальные команды:

```bash
npm run moderation:audit-commercial --workspace @maxim/api -- \
  --since <iso> --until <iso> --limit 5000 \
  --export-corpus-jsonl src/moderation/commercial-corpus.next.jsonl \
  --export-all-corpus

npm run moderation:validate-commercial-corpus --workspace @maxim/api -- \
  --input src/moderation/commercial-corpus.next.jsonl
```

## Corpus Gates

Базовые gates уже заданы в `validate-commercial-corpus.ts`:

- positive candidates >= 1000;
- negative candidates >= 5000;
- gray candidates >= 500;
- hard recall >= 0.98;
- false-positive rate <= 0.001;
- subtype accuracy >= 0.93.

Добавить целевые gates для апгрейда:

- delete false positives: `0`;
- hard-negative action must be `ALLOW`, not only non-delete;
- safe-context FP rate by bucket <= `0.001`, and `rules_or_moderation_context` must be `0`;
- campaign-only detections cannot escalate to delete without non-campaign direct-deal evidence;
- `REVIEW_ONLY` is acceptable only for explicitly gray samples, not hard negatives;
- every `DELETE` / `DELETE_AND_ESCALATE` must include direct deal, high-risk, or escalation-grade evidence in reason codes.

Regression coverage:

- Add safe-context cases to `commercial-patterns.regression.spec.ts`.
- Keep broad confusion matrix in `commercial-benchmark.spec.ts`.
- Keep JSONL structure and metric validation in `commercial-corpus-fixture.spec.ts`.
- Snapshot top false-positive signals so new broad patterns are visible in review.

## Suppressor And Threshold Work

Implement suppressors as explicit negative contexts before changing global weights.

P0 suppressors:

- `chat-rules-commercial-ban`: rules copy that enumerates banned ads, prices, phones, casino, jobs, links. Hard-negative when wording includes `правила`, `запрещено`, `удаляем`, `бан`, `модерация`, `жалобы`.
- `spam-complaint`: user complaint about spam, scammers, casino, links, or repeated ads. Hard-negative when speaker asks admins/bot to remove or warns others.
- `news-marketplace-brand`: news or analytics about marketplace discounts, banks, apps, brands, crypto, real estate, jobs, without CTA. Suppress high-risk marketplace/bonus patterns unless there is direct offer language.
- `public-warning`: official/public warning about fraud, benefits, loans, crypto, gambling links. Existing civic/fraud patterns should be widened and tested.
- `public-help-training`: employment center, school, municipal course, free training/help announcements without contact-for-sale or leadgen.
- `ordinary-recruitment-softener`: ordinary local jobs should not delete by default. Keep detection if enabled, but cap to `WARN` unless there is high-risk remote-income, referral, paid-review, registration, deposit, or multi-chat campaign evidence.
- `brand-mention-only`: brand or marketplace mention with complaint/review/question language should not create commercial context by itself.

Threshold ideas:

- Raise delete threshold for `RECRUITMENT` unless evidence includes phone/link plus strong offer marker or high-risk pattern.
- Cap `GOODS` generic subtype to `WARN` / `REVIEW_ONLY` when fpRisk is elevated by `context:*`.
- Require two independent direct-deal anchors for high-risk generic delete when text also matches news/rules/warning context.
- Keep private one-off goods/property suppressors as hard exits unless business, inventory, campaign, or channel-placement evidence overrides them.

## Explainability

Every commercial hit should expose:

- `decisionVersion`;
- `score` and raw `confidenceScore`;
- `actionBand`;
- `primarySubtype` and supporting subtypes;
- `evidenceTier`;
- `fpRisk`;
- `matchedSignals`;
- `negativeSignals`;
- `reasonCodes`;
- classifier probabilities and review reasons when second stage ran.

Upgrade requirements:

- Add reason codes for suppressor classes, even when final action is allow in audit output.
- Split explainability into commercial evidence, safe-context evidence, and action policy.
- In audit JSONL, include `suppressedBy` / `suppressionClass` for current-only false-positive analysis.
- Make docs and admin diagnostics distinguish `commercial candidate`, `review-only`, `warnable`, and `deletable`.

## Rollout And Deploy

Recommended rollout:

1. Land corpus-only additions and benchmark expectations first.
2. Add suppressors and threshold caps behind deterministic tests.
3. Run local validation:

```bash
npm test --workspace @maxim/api -- commercial-patterns.regression.spec.ts
npm test --workspace @maxim/api -- commercial-benchmark.spec.ts
npm test --workspace @maxim/api -- commercial-corpus-fixture.spec.ts
npm run typecheck --workspace @maxim/api
```

4. Export a fresh 24h corpus from prod and validate locally.
5. Deploy API roles only after gates pass.
6. Recreate all shared API image roles because moderation runtime uses the shared API image:
   `api-ingress`, `api-admin`, `api-enqueue`, moderation roles, and `api-action`.
7. After deploy, check live/ready health and run a read-only 24h audit window.

Rollback:

- If delete false positives appear, rollback runtime to the last good git ref.
- If only warn/review drift appears, disable strict settings per affected chat while preparing a follow-up patch.

## Monitoring

Track daily:

- total commercial hits;
- action distribution: `ALLOW`, `REVIEW_ONLY`, `WARN`, `DELETE`, `DELETE_AND_ESCALATE`;
- subtype distribution;
- top matched signals;
- top negative signals;
- top reason codes;
- delete count by subtype and chat;
- false-positive samples by safe-context bucket;
- hard-negative hit rate;
- campaign-only hit/delete rate;
- second-stage probability bands.
- audit detect-time p95/p99 and top slow sanitized records;
- duplicate-precheck timing, because it can run a second commercial spam scan.

Alerts:

- any hard-negative sample with delete action;
- spike in `GOODS` generic delete;
- spike in `RECRUITMENT` delete without high-risk reason;
- spike in `risk:marketplace-seller`, `risk:betting-gambling`, or `transaction:high-risk-offer` paired with rules/news context;
- sudden drop in recall on hard positives.

## Next Architecture

Move from one monolithic deterministic score to a staged decision pipeline:

1. `Normalizer`: text, URLs, phones, handles, markdown/markup.
2. `CommercialSignalExtractor`: positive commercial evidence only.
3. `SafeContextExtractor`: rules, complaints, news, public warnings, private sale, search/help/job-seeking contexts.
4. `SubtypeClassifier`: subtype and required anchors.
5. `EvidenceResolver`: direct deal, campaign, high-risk, structured, safe-context evidence.
6. `ActionPolicy`: action cap/delete decision from explicit evidence tiers and fpRisk.
7. `Explainer`: stable reason codes and audit metadata.

Extraction boundaries should keep current facades:

- public detector entry: `commercial-ad.detector.ts`;
- patterns: `commercial-patterns.ts`;
- suppressor classification: `commercial-suppressors.ts`;
- scoring and second stage: `commercial-scorer.ts`;
- action decision: `commercial-action-policy.ts`;
- explanation metadata: `commercial-explain.ts`.

Longer-term options:

- maintain a small curated safe-context corpus separate from broad production JSONL;
- add perf guards for near-misses around the widest commercial regex patterns;
- add per-chat calibration profiles only after global suppressors stabilize;
- add offline benchmark reports to CI artifacts;
- consider a learned second-stage model only after deterministic explainability is stable and corpus labels are high quality.

## Done Criteria

- 24h audit loop is repeatable locally and on VPS.
- Corpus gates pass with no delete false positives.
- Safe-context buckets are represented in regression tests.
- Every delete action has understandable direct/high-risk evidence.
- Monitoring can show which pattern or suppressor caused a decision.
- Rollback path is documented and tested through existing runtime rollback wrapper.
