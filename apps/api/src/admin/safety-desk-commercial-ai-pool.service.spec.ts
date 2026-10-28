import { randomUUID } from 'node:crypto';
import { projectCommercialAiPool } from './safety-desk-commercial-ai-pool.service';
const now = Date.parse('2026-10-28T12:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const config = { workersEnabled: true, routingEnabled: true, policy: 'confirm-positive' as const };
function value() {
  const nodes = ['server-9b', 'pc-a-4b', 'pc-b-9b'].map((nodeId) => ({
    nodeId,
    state: 'READY',
    ttlMs: 5000,
  }));
  const status = {
    stage: 'commercial-ai',
    schemaVersion: 2,
    mode: 'ENFORCE',
    heartbeatAt: iso(),
    lastSuccessAt: iso(-10),
    active: 0,
    outcomeBasis: 'process_cumulative',
    outcomes: {},
    pendingDiscardBasis: 'redis_namespace_cumulative',
    pendingDiscards: {},
    observationProcessId: randomUUID(),
    observationStartedAt: iso(-60000),
    poolDiagnostics: {
      schemaVersion: 1,
      nodes: nodes.map(({ nodeId }) => ({
        nodeId,
        completedAttempts: 1,
        failedAttempts: 0,
        lastCompletedAt: iso(-1000),
        lastFailureAt: null,
        ewmaDurationMs: 1000,
      })),
      consultations: { completed: 2, noCapacity: 3, budgetExhausted: 1 },
    },
  };
  return { nodes, status };
}
const read = (v = value()) => ({
  kind: 'value' as const,
  at: now,
  raw: JSON.stringify({ nodes: v.nodes, status: ['value', JSON.stringify(v.status), 30000] }),
});
describe('pool observation projection', () => {
  it('binds metrics to process time while keeping node readiness independent', () => {
    expect(projectCommercialAiPool(config, read(), now)).toMatchObject({
      availability: 'FRESH',
      metrics: {
        availability: 'FRESH',
        basis: 'PROCESS_MODEL_ATTEMPTS',
        diagnostics: { consultations: { noCapacity: 3 } },
      },
    });
    expect(projectCommercialAiPool(config, read(), now + 30000)).toMatchObject({
      availability: 'STALE',
      metrics: { availability: 'STALE' },
    });
    expect(
      projectCommercialAiPool({ ...config, routingEnabled: false }, read(), now).metrics,
    ).toBeNull();
  });
  it('rejects missing generation, future metrics and unknown diagnostic fields without claiming zero', () => {
    for (const patch of [
      { poolDiagnostics: undefined },
      { observationProcessId: undefined },
      { poolDiagnostics: { ...value().status.poolDiagnostics, privateToken: 'secret' } },
    ]) {
      const v = value();
      Object.assign(v.status, patch);
      expect(projectCommercialAiPool(config, read(v), now).metrics).toBeNull();
    }
    const v = value();
    v.status.poolDiagnostics.nodes[0]!.lastCompletedAt = iso(1);
    expect(projectCommercialAiPool(config, read(v), now).metrics).toBeNull();
  });
  it('rejects swapped/duplicate nodes, malformed data and a future observation', () => {
    const v = value();
    v.nodes[1] = v.nodes[0]!;
    expect(projectCommercialAiPool(config, read(v), now).availability).toBe('INVALID');
    expect(
      projectCommercialAiPool(config, { kind: 'value', at: now, raw: 'invalid' }, now).availability,
    ).toBe('INVALID');
    expect(projectCommercialAiPool(config, { ...read(), at: now + 1 }, now).availability).toBe(
      'INVALID',
    );
    expect(
      projectCommercialAiPool({ ...config, workersEnabled: false }, null, now).availability,
    ).toBe('DISABLED');
  });
});
