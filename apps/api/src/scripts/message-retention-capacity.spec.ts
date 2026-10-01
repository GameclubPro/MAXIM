import {
  readRetentionCapacityOptions,
  retentionTransportCapacityModel,
} from './message-retention-capacity';

describe('local retention capacity command boundary', () => {
  const local = ['--postgres-url', 'postgresql://tester:local@localhost:5432/disposable'];
  it.each([
    'postgresql://tester:local@production.example/disposable',
    'postgresql://tester:local@localhost/disposable?host=production.example',
    'postgresql://tester:local@localhost/disposable?options=-c%20search_path=public',
    'postgresql://tester:local@localhost/disposable#ignored',
    'https://localhost/disposable',
  ])('rejects nonlocal and connection-option bypasses before connecting', (url) => {
    expect(() => readRetentionCapacityOptions(['--postgres-url', url])).toThrow();
  });
  it.each([
    ['--chats', '20001'],
    ['--candidates', '2000001'],
    ['--samples', '201'],
    ['--transport-rps', '31'],
    ['--samples', '0'],
    ['--chats', '1.5'],
    ['--chats', 'Infinity'],
    ['--json-output', '/tmp/nested/file.json'],
    ['--json-output', '/var/tmp/output.json'],
    ['--scenario', 'production'],
  ])('rejects unsafe or unbounded %s=%s', (name, value) => {
    expect(() => readRetentionCapacityOptions([...local, name, value])).toThrow();
  });
  it('requires an explicit database and never uses the runtime environment fallback', () => {
    expect(() => readRetentionCapacityOptions([])).toThrow('--postgres-url is required');
  });
  it('caps even a requested 30 rps at the actual fleet and per-chat retention budgets', () => {
    const model = retentionTransportCapacityModel(1_600_000, 30);
    expect(model.assumptions).toMatchObject({
      requestedRps: 30,
      effectiveRps: 2,
      globalRetentionCeilingRps: 2,
      perChatDeleteCeilingRps: 1,
    });
    expect(model.optimisticDeletesPerSecond).toBe(1.429);
    expect(model.optimisticSingleChatDeletesPerSecond).toBe(1);
    expect(model.kind).toBe('arithmetic_upper_bound_not_runtime_benchmark');
    expect(readRetentionCapacityOptions(local).transportRps).toBe(2);
  });
  it('accepts maximum reviewed bounds and an explicit loopback IPv6 database', () => {
    expect(
      readRetentionCapacityOptions([
        '--postgres-url',
        'postgresql://tester:local@[::1]:5432/disposable',
        '--chats',
        '20000',
        '--candidates',
        '2000000',
        '--samples',
        '200',
        '--scenario',
        'skew',
        '--json-output',
        '/tmp/retention-capacity.json',
      ]),
    ).toMatchObject({ chats: 20_000, candidates: 2_000_000, samples: 200, scenario: 'skew' });
  });
});
