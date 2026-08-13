import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';

const ROLLING_SAMPLE_CAPACITY = 512;
const CGROUP_V2_CPU_STAT_PATH = '/sys/fs/cgroup/cpu.stat';
const CGROUP_V1_CPU_USAGE_PATH = '/sys/fs/cgroup/cpuacct/cpuacct.usage';

type TimedSample = Readonly<{
  value: number;
  recordedAtMs: number;
}>;

export type CommercialOcrRollingMetricSnapshot = Readonly<{
  observed: number;
  sampled: number;
  capacity: number;
  oldestSampleAt: string | null;
  newestSampleAt: string | null;
  last: number | null;
  average: number | null;
  p95: number | null;
  p99: number | null;
  maximum: number | null;
}>;

export type CommercialOcrRolloutMetricsSnapshot = Readonly<{
  processStartedAt: string;
  queueWaitMs: CommercialOcrRollingMetricSnapshot;
  nativePassDurationMs: CommercialOcrRollingMetricSnapshot;
  cpuSecondsPerImage: CommercialOcrRollingMetricSnapshot &
    Readonly<{
      unavailable: number;
      source: 'cgroup';
    }>;
}>;

export type CommercialOcrImageCpuSample = {
  startedUsageMicros: bigint | null;
  nativePasses: number;
  finished: boolean;
};

class BoundedRollingMetric {
  private readonly samples: Array<TimedSample | undefined>;
  private nextIndex = 0;
  private sampleCount = 0;
  private observedCount = 0;

  constructor(private readonly capacity: number) {
    this.samples = new Array<TimedSample | undefined>(capacity);
  }

  record(value: number, recordedAtMs = Date.now()): void {
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(recordedAtMs)) {
      return;
    }
    this.samples[this.nextIndex] = { value, recordedAtMs };
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.sampleCount = Math.min(this.capacity, this.sampleCount + 1);
    this.observedCount += 1;
  }

  snapshot(): CommercialOcrRollingMetricSnapshot {
    const samples = this.orderedSamples();
    if (samples.length === 0) {
      return {
        observed: this.observedCount,
        sampled: 0,
        capacity: this.capacity,
        oldestSampleAt: null,
        newestSampleAt: null,
        last: null,
        average: null,
        p95: null,
        p99: null,
        maximum: null,
      };
    }

    const values = samples.map((sample) => sample.value).sort((left, right) => left - right);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      observed: this.observedCount,
      sampled: samples.length,
      capacity: this.capacity,
      oldestSampleAt: new Date(samples[0]!.recordedAtMs).toISOString(),
      newestSampleAt: new Date(samples[samples.length - 1]!.recordedAtMs).toISOString(),
      last: roundMetric(samples[samples.length - 1]!.value),
      average: roundMetric(total / values.length),
      p95: roundMetric(nearestRank(values, 0.95)),
      p99: roundMetric(nearestRank(values, 0.99)),
      maximum: roundMetric(values[values.length - 1]!),
    };
  }

  private orderedSamples(): TimedSample[] {
    if (this.sampleCount < this.capacity) {
      return this.samples.slice(0, this.sampleCount) as TimedSample[];
    }
    return [
      ...(this.samples.slice(this.nextIndex) as TimedSample[]),
      ...(this.samples.slice(0, this.nextIndex) as TimedSample[]),
    ];
  }
}

@Injectable()
export class CommercialOcrMetricsService {
  private readonly processStartedAt = new Date().toISOString();
  private readonly queueWaitMs = new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY);
  private readonly nativePassDurationMs = new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY);
  private readonly cpuSecondsPerImage = new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY);
  private unavailableCpuSamples = 0;

  recordQueueWait(waitMs: number, recordedAtMs = Date.now()): void {
    this.queueWaitMs.record(waitMs, recordedAtMs);
  }

  startImageCpuSample(): CommercialOcrImageCpuSample {
    return {
      startedUsageMicros: this.readCgroupCpuUsageMicros(),
      nativePasses: 0,
      finished: false,
    };
  }

  recordNativePass(
    sample: CommercialOcrImageCpuSample,
    durationMs: number,
    recordedAtMs = Date.now(),
  ): void {
    if (sample.finished) {
      return;
    }
    sample.nativePasses += 1;
    this.nativePassDurationMs.record(durationMs, recordedAtMs);
  }

  finishImageCpuSample(sample: CommercialOcrImageCpuSample, recordedAtMs = Date.now()): void {
    if (sample.finished) {
      return;
    }
    sample.finished = true;
    if (sample.nativePasses === 0) {
      return;
    }

    const finishedUsageMicros = this.readCgroupCpuUsageMicros();
    if (
      sample.startedUsageMicros === null ||
      finishedUsageMicros === null ||
      finishedUsageMicros < sample.startedUsageMicros
    ) {
      this.unavailableCpuSamples += 1;
      return;
    }
    const usedMicros = finishedUsageMicros - sample.startedUsageMicros;
    const cpuSeconds = Number(usedMicros) / 1_000_000;
    this.cpuSecondsPerImage.record(cpuSeconds, recordedAtMs);
  }

  getSnapshot(): CommercialOcrRolloutMetricsSnapshot {
    return {
      processStartedAt: this.processStartedAt,
      queueWaitMs: this.queueWaitMs.snapshot(),
      nativePassDurationMs: this.nativePassDurationMs.snapshot(),
      cpuSecondsPerImage: {
        ...this.cpuSecondsPerImage.snapshot(),
        unavailable: this.unavailableCpuSamples,
        source: 'cgroup',
      },
    };
  }

  protected readCgroupCpuUsageMicros(): bigint | null {
    try {
      const cpuStat = readFileSync(CGROUP_V2_CPU_STAT_PATH, 'utf8');
      const match = /^usage_usec\s+(\d+)$/mu.exec(cpuStat);
      if (match?.[1]) {
        return BigInt(match[1]);
      }
    } catch {
      // Fall through to cgroup v1.
    }

    try {
      const usageNanoseconds = readFileSync(CGROUP_V1_CPU_USAGE_PATH, 'utf8').trim();
      if (/^\d+$/u.test(usageNanoseconds)) {
        return BigInt(usageNanoseconds) / 1_000n;
      }
    } catch {
      return null;
    }
    return null;
  }
}

function nearestRank(sortedValues: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[index]!;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
