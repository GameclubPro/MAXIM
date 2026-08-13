import { CommercialOcrMetricsService } from './commercial-ocr-metrics.service';

class TestCommercialOcrMetricsService extends CommercialOcrMetricsService {
  private readonly cpuReadings: Array<bigint | null> = [];

  queueCpuReadings(...readings: Array<bigint | null>): void {
    this.cpuReadings.push(...readings);
  }

  protected override readCgroupCpuUsageMicros(): bigint | null {
    return this.cpuReadings.shift() ?? null;
  }
}

describe('CommercialOcrMetricsService', () => {
  it('reports nearest-rank percentiles from a bounded rolling window', () => {
    const service = new TestCommercialOcrMetricsService();
    const startedAtMs = Date.parse('2026-08-13T10:00:00.000Z');

    for (let value = 1; value <= 600; value += 1) {
      service.recordQueueWait(value, startedAtMs + value);
    }

    expect(service.getSnapshot().queueWaitMs).toEqual({
      observed: 600,
      sampled: 512,
      capacity: 512,
      oldestSampleAt: new Date(startedAtMs + 89).toISOString(),
      newestSampleAt: new Date(startedAtMs + 600).toISOString(),
      last: 600,
      average: 344.5,
      p95: 575,
      p99: 595,
      maximum: 600,
    });
  });

  it('records native pass duration and cgroup CPU once per attempted image', () => {
    const service = new TestCommercialOcrMetricsService();
    service.queueCpuReadings(1_000_000n, 3_250_000n);
    const image = service.startImageCpuSample();

    service.recordNativePass(image, 125.1236, 1_000);
    service.recordNativePass(image, 250, 2_000);
    service.finishImageCpuSample(image, 3_000);
    service.finishImageCpuSample(image, 4_000);

    const snapshot = service.getSnapshot();
    expect(snapshot.nativePassDurationMs).toMatchObject({
      observed: 2,
      sampled: 2,
      last: 250,
      average: 187.562,
      p95: 250,
      p99: 250,
    });
    expect(snapshot.cpuSecondsPerImage).toMatchObject({
      observed: 1,
      sampled: 1,
      last: 2.25,
      average: 2.25,
      p95: 2.25,
      p99: 2.25,
      unavailable: 0,
      source: 'cgroup',
    });
  });

  it('does not count cache-only images and exposes unsupported cgroup samples', () => {
    const service = new TestCommercialOcrMetricsService();
    service.queueCpuReadings(null, 10n, null);

    const cacheOnly = service.startImageCpuSample();
    service.finishImageCpuSample(cacheOnly);
    const attempted = service.startImageCpuSample();
    service.recordNativePass(attempted, 10);
    service.finishImageCpuSample(attempted);

    expect(service.getSnapshot().cpuSecondsPerImage).toMatchObject({
      observed: 0,
      sampled: 0,
      unavailable: 1,
    });
  });
});
