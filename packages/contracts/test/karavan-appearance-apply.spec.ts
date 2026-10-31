import { describe, expect, it } from 'vitest';
import {
  marketplaceManagementRequestSchema,
  marketplaceManagementResponseSchema,
} from '../src/karavan-marketplace-management.js';

const commandId = '11111111-1111-4111-8111-111111111111';
const appearance = {
  name: 'Магазин соседей',
  description: null,
  logoImageUrl: null,
  coverImageUrl: null,
  accent: 'blue',
  blocks: [
    { id: 'categories', visible: true },
    { id: 'pinned', visible: true },
    { id: 'sellers', visible: true },
  ],
};
const request = {
  commandId,
  chatId: '-9007199254740993',
  marketplaceId: '22222222-2222-4222-8222-222222222222',
  expectedBindingGeneration: 7,
  command: {
    operation: 'appearance_apply',
    input: { commandId, expectedRevision: 3, appearance },
  },
};

describe('atomic chat shop appearance protocol', () => {
  it('carries the current form and returns the applied draft and published appearance', () => {
    expect(marketplaceManagementRequestSchema.parse(request)).toEqual(request);
    const response = {
      operation: 'appearance_apply',
      data: { draft: appearance, published: appearance, revision: 4, hasChanges: false },
    };
    expect(marketplaceManagementResponseSchema.parse(response)).toEqual(response);
  });

  it('keeps save/publish compatibility and rejects substituted identities and unbounded input', () => {
    for (const operation of ['appearance_save', 'appearance_publish']) {
      expect(
        marketplaceManagementRequestSchema.safeParse({
          ...request,
          command: {
            operation,
            input:
              operation === 'appearance_save'
                ? request.command.input
                : { commandId, expectedRevision: 3 },
          },
        }).success,
      ).toBe(true);
    }
    for (const input of [
      { ...request.command.input, commandId: 'another-command' },
      { ...request.command.input, expectedRevision: 0 },
      { ...request.command.input, path: '/operator/stores' },
      { commandId, expectedRevision: 3 },
    ]) {
      expect(
        marketplaceManagementRequestSchema.safeParse({
          ...request,
          command: { operation: 'appearance_apply', input },
        }).success,
      ).toBe(false);
    }
  });
});
