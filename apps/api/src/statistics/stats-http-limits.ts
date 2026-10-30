import type { FastifyInstance } from 'fastify';
import { STATS_HTTP_PREFIX, STATS_ROUTES } from '@maxim/contracts/statistics-central';
import { STATS_ANALYTICS_ROUTE } from '@maxim/contracts/statistics-analytics';
import { analyticsFailure, beginStatsReadBudget } from './stats-read-budget';
const literalActions = new Set<string>(
  [
    STATS_ROUTES.authorities,
    STATS_ROUTES.authorityResolve,
    STATS_ROUTES.summaries,
    STATS_ROUTES.history,
    STATS_ANALYTICS_ROUTE,
  ].map((path) => `${STATS_HTTP_PREFIX}${path}`),
);
/** Fastify enforces bytes while streaming, including chunked/whitespace bodies before JSON parsing. */
export function registerStatsHttpLimits(fastify: FastifyInstance) {
  fastify.addHook('onRoute', (route) => {
    if (!route.url.startsWith(`${STATS_HTTP_PREFIX}/`)) return;
    route.bodyLimit = route.url.endsWith('/authorities:batch') ? 131_072 : 65_536;
    if (route.url === `${STATS_HTTP_PREFIX}${STATS_ANALYTICS_ROUTE}`) {
      const previous = route.onRequest
        ? Array.isArray(route.onRequest)
          ? route.onRequest
          : [route.onRequest]
        : [];
      route.onRequest = [
        async (request, reply) => {
          try {
            beginStatsReadBudget(request, reply);
          } catch (error) {
            const failure = analyticsFailure(error);
            await reply.code(failure.getStatus()).send(failure.getResponse());
          }
        },
        ...previous,
      ];
    }
    // FLAG: These exact wire actions contain literal colons, not route parameters.
    // Escape only at Fastify registration, after classifying the original byte limit.
    if (literalActions.has(route.url)) route.url = route.url.replaceAll(':', '::');
  });
}
