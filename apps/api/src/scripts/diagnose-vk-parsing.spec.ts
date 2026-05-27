import { readCliOptions, renderTextDiagnostics } from './diagnose-vk-parsing';

describe('diagnose-vk-parsing script helpers', () => {
  it('parses CLI options with environment fallback', () => {
    expect(
      readCliOptions(['--json', '--limit', '5', '--window-hours', '12'], {
        REDIS_URL: 'redis://localhost:6379/0',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      json: true,
      limit: 5,
      windowHours: 12,
      redisUrl: 'redis://localhost:6379/0',
    });
  });

  it('renders a compact operational summary', () => {
    const rendered = renderTextDiagnostics({
      generatedAt: '2026-05-27T22:55:03.204Z',
      windowHours: 6,
      sourceStatus: [{ syncStatus: 'IDLE', lastErrorCode: '', count: 59 }],
      sourceHealth: {
        sourceCount: 59,
        healthySources: 59,
        errorSources: 0,
        inFlightSources: 0,
      },
      noisySources: [],
      syncPerformance: {
        fetchedPosts: 300,
        importedPosts: 12,
        p95SyncDurationMs: 1250,
      },
      publishBacklog: {
        queuedPosts: 2,
        staleLockedPosts: 0,
        oldestQueuedAgeSec: 45,
      },
      stuckPublishPosts: [],
      recentPublishFailures: [],
      mediaStatus: [{ status: 'READY', count: 100, withIdentity: 80 }],
      mediaIdentityConflicts: [],
      recentMediaFailures: [],
      queues: {
        available: true,
        error: null,
        sync: { name: 'vk-parsing-sync', counts: { waiting: 0 }, jobs: [] },
        publish: { name: 'vk-parsing-publish', counts: { waiting: 2 }, jobs: [] },
      },
    });

    expect(rendered).toContain('Sources: 59/59 healthy');
    expect(rendered).toContain('Publish backlog: 2 queued');
    expect(rendered).toContain('sync={"waiting":0}');
  });
});
