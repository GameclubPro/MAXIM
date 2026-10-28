import { describe, expect, it } from 'vitest';
import { safetyDeskCommercialAiPoolResponseSchema } from '../src/safety-desk';
const snapshot = {
  schemaVersion: 1,
  generatedAt: '2026-10-28T12:00:00.000Z',
  observedAt: null,
  workersEnabled: true,
  routingEnabled: true,
  policy: 'confirm-positive',
  availability: 'UNAVAILABLE',
  nodes: null,
  metrics: null,
  trafficCoverage: 'NOT_ESTABLISHED',
  confirmedDeletes: null,
};
describe('pool diagnostic contract', () => {
  it('preserves unavailable observations without invented counts or deletions', () => {
    expect(safetyDeskCommercialAiPoolResponseSchema.parse(snapshot)).toEqual(snapshot);
  });
  it.each([
    { confirmedDeletes: 1 },
    { token: 'secret' },
    { policy: 'automatic' },
    { nodes: [] },
    { trafficCoverage: 'COMPLETE' },
  ])('rejects unsupported evidence %j', (patch) => {
    expect(
      safetyDeskCommercialAiPoolResponseSchema.safeParse({ ...snapshot, ...patch }).success,
    ).toBe(false);
  });
  it('refuses duplicated nodes and extra ownership fields', () => {
    const node = { nodeId: 'pc-a-4b', state: 'READY', validUntil: null };
    expect(
      safetyDeskCommercialAiPoolResponseSchema.safeParse({ ...snapshot, nodes: [node, node, node] })
        .success,
    ).toBe(false);
    const nodes = ['server-9b', 'pc-a-4b', 'pc-b-9b'].map((nodeId) => ({ ...node, nodeId }));
    expect(safetyDeskCommercialAiPoolResponseSchema.safeParse({ ...snapshot, nodes }).success).toBe(
      true,
    );
    expect(
      safetyDeskCommercialAiPoolResponseSchema.safeParse({
        ...snapshot,
        nodes: nodes.map((n) => ({ ...n, session: 'private' })),
      }).success,
    ).toBe(false);
  });
});
