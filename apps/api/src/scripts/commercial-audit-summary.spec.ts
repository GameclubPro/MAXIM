import { summarizeCommercialAuditRecords } from './commercial-audit-summary';

describe('commercial-audit-summary', () => {
  it('builds metadata-only alerts for unsafe delete categories', () => {
    const summary = summarizeCommercialAuditRecords([
      {
        label: 'negative_candidate',
        policyCategory: 'none',
        segment: 'OTHER',
        safeContextBucket: 'news_or_analytics',
        current: {
          hit: true,
          actionBand: 'DELETE',
          primarySubtype: 'GOODS',
          matchedSignals: ['risk:betting-gambling'],
          negativeSignals: ['context:public-fraud-warning'],
          reasonCodes: ['action:DELETE'],
        },
      },
      {
        label: 'gray_candidate',
        policyCategory: 'campaign_only',
        segment: 'SERVICES',
        safeContextBucket: 'none',
        current: {
          hit: true,
          actionBand: 'DELETE',
          primarySubtype: 'SERVICES',
          matchedSignals: ['campaign:cross-chat-text'],
          reasonCodes: ['action:DELETE'],
        },
      },
      {
        label: 'positive_candidate',
        policyCategory: 'hard_delete',
        segment: 'RECRUITMENT',
        safeContextBucket: 'none',
        current: {
          hit: true,
          actionBand: 'DELETE',
          primarySubtype: 'RECRUITMENT',
          matchedSignals: ['recruitment:ваканси'],
          reasonCodes: ['action:DELETE'],
        },
      },
    ]);

    expect(summary.records).toBe(3);
    expect(summary.alerts).toEqual(
      expect.arrayContaining([
        { code: 'delete_false_positive_candidate', severity: 'critical', count: 1 },
        { code: 'gray_candidate_delete', severity: 'critical', count: 1 },
        { code: 'campaign_only_delete', severity: 'critical', count: 1 },
        { code: 'safe_context_delete', severity: 'critical', count: 1 },
        { code: 'generic_goods_delete', severity: 'warning', count: 1 },
        { code: 'recruitment_delete_without_risk', severity: 'warning', count: 1 },
        { code: 'risky_rules_or_news_context', severity: 'warning', count: 1 },
      ]),
    );
  });

  it('counts suppressed deletes without raising unsafe-delete alerts', () => {
    const summary = summarizeCommercialAuditRecords([
      {
        label: 'gray_candidate',
        policyCategory: 'gray_zone',
        segment: 'GOODS',
        safeContextBucket: 'private_one_off_sale',
        current: {
          hit: true,
          actionBand: 'REVIEW_ONLY',
          primarySubtype: 'GOODS_RETAIL',
          deleteSuppressed: true,
          suppressionReasons: ['safe-context:private_one_off_sale'],
          matchedSignals: ['transaction:price', 'contact:phone'],
          reasonCodes: ['suppressed:safe-context:private_one_off_sale'],
        },
      },
    ]);

    expect(summary.deleteSuppressed).toBe(1);
    expect(summary.alerts).toEqual([]);
  });
});
