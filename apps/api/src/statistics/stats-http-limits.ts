import type { FastifyInstance } from 'fastify';
import { STATS_HTTP_PREFIX } from '@maxim/contracts/statistics-central';
/** Fastify enforces bytes while streaming, including chunked/whitespace bodies before JSON parsing. */
export function registerStatsHttpLimits(fastify: FastifyInstance) {
  fastify.addHook('onRoute', (route) => {
    if (!route.url.startsWith(`${STATS_HTTP_PREFIX}/`)) return;
    route.bodyLimit = route.url.endsWith('/authorities:batch') ? 131_072 : 65_536;
  });
}
