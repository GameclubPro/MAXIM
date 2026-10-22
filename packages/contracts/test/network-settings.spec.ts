import { describe, expect, it } from 'vitest';
import {
  networkSettingsPreviewRequestSchema,
  networkSettingsReadRequestSchema,
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
