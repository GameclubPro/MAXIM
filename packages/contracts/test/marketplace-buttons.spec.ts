import { describe, it, expect } from 'vitest';
import {
  marketplaceButtonCaptionSchema,
  marketplaceButtonPolicyMutationSchema,
} from '../src/marketplace-integration.js';
const requestId = '00000000-0000-4000-8000-000000000001';
describe('advertising button inputs', () => {
  it('accepts one concise custom label and rejects empty/multiline/control/oversize values', () => {
    expect(marketplaceButtonCaptionSchema.parse('  Заказать рекламу  ')).toBe('Заказать рекламу');
    expect(marketplaceButtonCaptionSchema.parse('🧑‍💻 Заказать рекламу')).toBe('🧑‍💻 Заказать рекламу');
    for (const value of ['', '   ', 'Реклама\nздесь', 'a'.repeat(49), 'Реклама\u0000'])
      expect(marketplaceButtonCaptionSchema.safeParse(value).success).toBe(false);
  });
  it('requires the correct module group and independent caption revision', () => {
    const base = { requestId, expectedRevision: 2, context: 'MODERATION_NOTICES', enabled: false };
    expect(
      marketplaceButtonPolicyMutationSchema.safeParse({ ...base, module: 'DUPLICATES' }).success,
    ).toBe(true);
    expect(
      marketplaceButtonPolicyMutationSchema.safeParse({ ...base, module: 'VK_IMPORT' }).success,
    ).toBe(false);
    expect(
      marketplaceButtonPolicyMutationSchema.safeParse({
        requestId,
        expectedCaptionRevision: 2,
        caption: 'Реклама',
      }).success,
    ).toBe(true);
    expect(
      marketplaceButtonPolicyMutationSchema.safeParse({ ...base, caption: 'Реклама' }).success,
    ).toBe(false);
  });
});
