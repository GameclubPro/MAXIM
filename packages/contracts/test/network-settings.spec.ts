import { describe, expect, it } from 'vitest';
import {
  networkSettingsPreviewRequestSchema,
  networkSettingsReadRequestSchema,
  applySettingsSectionSchema,
  networkSettingsRecipientSchema,
} from '../src/network-settings.js';

const request = {
  operationId: '55555555-5555-4555-8555-555555555555',
  entityType: 'chat',
  target: { mode: 'selected', entityIds: ['one'] },
  section: 'limits',
  compositionVersion: 'snapshot',
  recipients: [{ entityId: 'one', title: 'First', revision: '2026-10-22T00:00:00.000Z' }],
  changes: [{ path: 'antiSpamEnabled', op: 'set', value: true }],
};

describe('network settings request boundaries', () => {
  it('adds independent persisted settings without broadening legacy copy or action sections', () => {
    for (const section of [
      'speechStyle',
      'rules',
      'messageRetention',
      'advertising',
      'postSuggestions',
    ]) {
      expect(
        networkSettingsReadRequestSchema.safeParse({
          entityType: section === 'postSuggestions' ? 'channel' : 'chat',
          target: request.target,
          section,
        }).success,
      ).toBe(true);
      expect(applySettingsSectionSchema.safeParse(section).success).toBe(false);
    }
    for (const section of ['publishRules', 'polls', 'giveaway', 'sendAdvertising'])
      expect(
        networkSettingsReadRequestSchema.safeParse({
          entityType: 'chat',
          target: request.target,
          section,
        }).success,
      ).toBe(false);
    expect(
      networkSettingsRecipientSchema.parse({
        ...request.recipients[0],
        rulesRevision: null,
        messageRetentionRevision: 0,
        advertisingRevision: 5,
      }),
    ).toMatchObject({ rulesRevision: null, messageRetentionRevision: 0, advertisingRevision: 5 });
  });
  it('never defaults an absent or empty target to the whole network', () => {
    expect(
      networkSettingsReadRequestSchema.safeParse({ entityType: 'chat', section: 'limits' }).success,
    ).toBe(false);
    expect(
      networkSettingsReadRequestSchema.safeParse({
        entityType: 'chat',
        section: 'limits',
        target: { mode: 'selected', entityIds: [] },
      }).success,
    ).toBe(false);
  });
  it('rejects overlapping dirty paths and duplicate recipient fences', () => {
    expect(
      networkSettingsPreviewRequestSchema.safeParse({
        ...request,
        changes: [request.changes[0], request.changes[0]],
      }).success,
    ).toBe(false);
    expect(
      networkSettingsPreviewRequestSchema.safeParse({
        ...request,
        recipients: [...request.recipients, ...request.recipients],
      }).success,
    ).toBe(false);
  });
  it('requires explicit replace for list values at the domain boundary and keeps its contents intact', () => {
    const parsed = networkSettingsPreviewRequestSchema.parse({
      ...request,
      changes: [{ path: 'reportsAliases', op: 'replace', value: ['first', 'second'] }],
    });
    expect(parsed.changes[0]).toEqual({
      path: 'reportsAliases',
      op: 'replace',
      value: ['first', 'second'],
    });
  });
});
