import {
  buildPublisherRuntimeHeartbeatKey,
  parsePublisherRuntimeHeartbeat,
  PUBLISHER_RUNTIME_HEARTBEAT_TTL_SEC,
  resolvePublisherHeartbeatDispatchEnabled,
} from './publisher-runtime-heartbeat.service';

describe('publisher runtime heartbeat contract', () => {
  const nowMs = Date.parse('2026-08-26T12:00:00.000Z');

  it('uses a bot-scoped Redis key and accepts a fresh disabled heartbeat', () => {
    expect(buildPublisherRuntimeHeartbeatKey('se14088825_bot')).toBe(
      'publisher:runtime:v1:se14088825_bot',
    );
    expect(
      parsePublisherRuntimeHeartbeat(
        JSON.stringify({
          version: 1,
          botId: 'se14088825_bot',
          dispatchEnabled: false,
          observedAt: new Date(nowMs).toISOString(),
          instanceId: 'instance-1',
        }),
        'se14088825_bot',
        nowMs,
      ),
    ).toMatchObject({ dispatchEnabled: false });
  });

  it('fails closed for stale, mismatched, and malformed heartbeats', () => {
    const staleAt = new Date(nowMs - PUBLISHER_RUNTIME_HEARTBEAT_TTL_SEC * 1_000 - 1).toISOString();
    const build = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        version: 1,
        botId: 'se14088825_bot',
        dispatchEnabled: true,
        observedAt: staleAt,
        instanceId: 'instance-1',
        ...overrides,
      });

    expect(parsePublisherRuntimeHeartbeat(build(), 'se14088825_bot', nowMs)).toBeNull();
    expect(
      parsePublisherRuntimeHeartbeat(
        build({ observedAt: new Date(nowMs).toISOString(), botId: 'main-bot' }),
        'se14088825_bot',
        nowMs,
      ),
    ).toBeNull();
    expect(parsePublisherRuntimeHeartbeat('{', 'se14088825_bot', nowMs)).toBeNull();
  });

  it('publishes dispatch disabled while the exact-token authorization pause is active', () => {
    expect(resolvePublisherHeartbeatDispatchEnabled(true, true, true)).toBe(false);
    expect(resolvePublisherHeartbeatDispatchEnabled(true, false, true)).toBe(true);
    expect(resolvePublisherHeartbeatDispatchEnabled(false, false, true)).toBe(false);
    expect(resolvePublisherHeartbeatDispatchEnabled(true, false, false)).toBe(false);
  });
});
