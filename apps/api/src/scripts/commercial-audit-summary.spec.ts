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
          evidenceTier: 'DIRECT',
          matchedSignals: ['contact:phone'],
          negativeSignals: ['context:public-fraud-warning'],
          reasonCodes: ['action:DELETE'],
          featureVector: {
            dealEvidence: 1,
            contactEvidence: 1,
          },
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
          evidenceTier: 'DIRECT',
          matchedSignals: ['recruitment:ваканси'],
          reasonCodes: ['action:DELETE'],
          featureVector: {
            dealEvidence: 1,
            contactEvidence: 1,
          },
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
    expect(summary.alerts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'campaign_only_enforcement' })]),
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

  it('treats WARN as message-removal enforcement in safety alerts', () => {
    const summary = summarizeCommercialAuditRecords([
      {
        label: 'negative_candidate',
        policyCategory: 'campaign_only',
        segment: 'GOODS',
        safeContextBucket: 'news_or_analytics',
        current: {
          hit: true,
          actionBand: 'WARN',
          primarySubtype: 'GOODS',
          matchedSignals: ['campaign:cross-chat-text'],
          negativeSignals: ['context:currency-rate-news'],
          reasonCodes: ['action:WARN'],
        },
      },
    ]);

    expect(summary.deleteFalsePositiveCandidates).toBe(0);
    expect(summary.enforcementFalsePositiveCandidates).toBe(1);
    expect(summary.grayEnforcements).toBe(0);
    expect(summary.campaignOnlyEnforcements).toBe(1);
    expect(summary.safeContextEnforcements).toEqual({ news_or_analytics: 1 });
    expect(summary.alerts).toEqual(
      expect.arrayContaining([
        { code: 'enforcement_false_positive_candidate', severity: 'critical', count: 1 },
        { code: 'safe_context_enforcement', severity: 'critical', count: 1 },
      ]),
    );
  });

  it('does not alert when a gray WARN exactly matches expectedAction', () => {
    const summary = summarizeCommercialAuditRecords([
      {
        label: 'gray_candidate',
        expectedAction: 'WARN',
        policyCategory: 'gray_zone',
        segment: 'SERVICES',
        safeContextBucket: 'none',
        current: {
          hit: true,
          actionBand: 'WARN',
          primarySubtype: 'SERVICES',
        },
      },
      {
        label: 'gray_candidate',
        expectedAction: 'WARN',
        policyCategory: 'gray_zone',
        segment: 'SERVICES',
        safeContextBucket: 'none',
        current: {
          hit: true,
          actionBand: 'DELETE',
          primarySubtype: 'SERVICES',
        },
      },
    ]);

    expect(summary.grayEnforcements).toBe(1);
    expect(summary.grayDeletes).toBe(1);
    expect(summary.alerts).toEqual(
      expect.arrayContaining([
        { code: 'gray_candidate_enforcement', severity: 'critical', count: 1 },
        { code: 'gray_candidate_delete', severity: 'critical', count: 1 },
      ]),
    );
  });

  it('keeps structured goods and recruitment deletes out of weak-delete warnings', () => {
    const summary = summarizeCommercialAuditRecords([
      {
        label: 'positive_candidate',
        policyCategory: 'hard_delete',
        segment: 'GOODS',
        safeContextBucket: 'none',
        current: {
          hit: true,
          actionBand: 'DELETE',
          campaignStrength: 'STRONG',
          evidenceTier: 'DIRECT',
          primarySubtype: 'GOODS',
          matchedSignals: ['campaign:cross-chat-phone', 'contact:phone', 'transaction:price'],
          reasonCodes: ['action:DELETE', 'evidence:action-direct', 'evidence:direct:price-contact'],
          featureVector: {
            dealEvidence: 1,
            contactEvidence: 1,
            massDistribution: 1,
            priceStructure: 1,
          },
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
          campaignStrength: 'STANDARD',
          evidenceTier: 'DIRECT',
          primarySubtype: 'RECRUITMENT',
          matchedSignals: ['recruitment:вахт', 'contact:phone', 'transaction:price'],
          reasonCodes: ['action:DELETE', 'evidence:action-direct', 'evidence:direct:price-contact'],
          featureVector: {
            dealEvidence: 1,
            contactEvidence: 1,
            businessContext: 1,
            priceStructure: 1,
          },
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
          campaignStrength: 'NONE',
          evidenceTier: 'DIRECT',
          primarySubtype: 'RECRUITMENT',
          matchedSignals: ['recruitment:требуется', 'contact:phone', 'transaction:price'],
          reasonCodes: ['action:DELETE', 'evidence:action-direct', 'evidence:direct:price-contact'],
          featureVector: {
            dealEvidence: 1,
            contactEvidence: 1,
            priceStructure: 1,
          },
        },
      },
    ]);

    expect(summary.genericGoodsDeletes).toBe(0);
    expect(summary.recruitmentDeleteWithoutRisk).toBe(0);
    expect(summary.alerts).toEqual([]);
  });
});
