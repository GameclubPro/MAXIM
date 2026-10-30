import { HttpException } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { withConnectionAdmissionBudget } from '../prisma/connection-admission-budget';
import { StatsFailure } from './stats-common';

export const STATS_READ_BUDGET_HEADER = 'x-statistics-read-budget-ms';
export const STATS_READ_MAX_MS = 5000;
const requestBudgets = new WeakMap<object, StatsReadBudget>();

export class StatsAnalyticsFailure extends StatsFailure {
  override getResponse(): object {
    const response = super.getResponse();
    return { ...(typeof response === 'object' ? response : {}), analyticsVersion: 1 };
  }
}
export function analyticsFailure(error: unknown): HttpException {
  if (error instanceof StatsAnalyticsFailure) return error;
  if (error instanceof StatsFailure)
    return new HttpException(
      { ...(error.getResponse() as object), analyticsVersion: 1 },
      error.getStatus(),
    );
  return new StatsAnalyticsFailure('UNAVAILABLE', 503);
}

export class StatsReadBudget {
  constructor(
    readonly deadline: number,
    readonly signal: AbortSignal,
    private readonly clock: () => number = () => performance.now(),
  ) {}
  static start(milliseconds = STATS_READ_MAX_MS, signal = new AbortController().signal) {
    return new StatsReadBudget(performance.now() + milliseconds, signal);
  }
  remainingMs() {
    return Math.floor(this.deadline - this.clock());
  }
  check() {
    if (this.signal.aborted || this.remainingMs() < 1)
      throw new StatsAnalyticsFailure('UNAVAILABLE', 503);
  }
  reserve(milliseconds: number) {
    const reserved = new StatsReadBudget(this.deadline - milliseconds, this.signal, this.clock);
    reserved.check();
    return reserved;
  }
  within(milliseconds: number) {
    return new StatsReadBudget(
      Math.min(this.deadline, this.clock() + milliseconds),
      this.signal,
      this.clock,
    );
  }
}

export function beginStatsReadBudget(request: FastifyRequest, reply: FastifyReply) {
  const started = performance.now();
  const header = request.headers[STATS_READ_BUDGET_HEADER];
  const duplicates = request.raw.rawHeaders
    .filter((_, i) => i % 2 === 0)
    .filter((name) => name.toLowerCase() === STATS_READ_BUDGET_HEADER).length;
  if (
    duplicates > 1 ||
    (header !== undefined &&
      (typeof header !== 'string' ||
        !/^[1-9]\d{0,3}$/u.test(header) ||
        Number(header) > STATS_READ_MAX_MS))
  )
    throw new StatsAnalyticsFailure('INVALID_REQUEST', 400);
  const milliseconds = header === undefined ? STATS_READ_MAX_MS : Number(header);
  const controller = new AbortController();
  const budget = new StatsReadBudget(started + milliseconds, controller.signal);
  requestBudgets.set(request, budget);
  const abort = () => controller.abort();
  const close = () => {
    if (!reply.raw.writableEnded) abort();
    cleanup();
  };
  const timer = setTimeout(abort, milliseconds);
  timer.unref();
  const cleanup = () => {
    clearTimeout(timer);
    request.raw.removeListener('aborted', abort);
    reply.raw.removeListener('close', close);
    reply.raw.removeListener('finish', cleanup);
  };
  request.raw.once('aborted', abort);
  reply.raw.once('close', close);
  reply.raw.once('finish', cleanup);
}
export function statsReadBudgetFor(request: object) {
  const budget = requestBudgets.get(request);
  if (!budget) throw new StatsAnalyticsFailure('UNAVAILABLE', 503);
  budget.check();
  return budget;
}

/** Server statement_timeout stops actual SQL. Abort prevents subsequent work; it is not pg cancel. */
export function deadlineTransaction(
  tx: Prisma.TransactionClient,
  budget: StatsReadBudget,
): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, property, receiver) {
      const original: unknown = Reflect.get(target, property, receiver);
      if (property !== '$queryRaw' && property !== '$executeRaw') return original;
      if (typeof original !== 'function') return original;
      return async (...args: unknown[]) => {
        budget.check();
        const statementMs = Math.max(1, Math.min(2500, budget.remainingMs()));
        const lockMs = Math.min(250, statementMs);
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${statementMs}ms`}, true), set_config('lock_timeout', ${`${lockMs}ms`}, true)`;
        budget.check();
        const result: unknown = await Reflect.apply(original, target, args);
        budget.check();
        return result;
      };
    },
  });
}

export async function statsReadTransaction<T>(
  prisma: PrismaService,
  budget: StatsReadBudget,
  read: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  budget.check();
  const maxWait = Math.max(1, Math.min(500, budget.remainingMs()));
  const admission = budget.within(maxWait);
  return withConnectionAdmissionBudget(admission, () =>
    prisma.$transaction(
      async (tx) => {
        budget.check();
        const bounded = deadlineTransaction(tx, budget);
        await bounded.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        const result = await read(bounded);
        budget.check();
        return result;
      },
      { isolationLevel: 'RepeatableRead', maxWait, timeout: Math.max(1, budget.remainingMs()) },
    ),
  );
}
