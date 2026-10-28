import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: Enrollment and queued scoped SENDs outlive feature flags. An older
// dispatcher must never interpret their metadata as permission for a legacy send.
export const KARAVAN_MARKETPLACE_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/src/max/max-action-dispatch.service.ts',
    [
      'attemptJob.ledgerContext?.karavanMarketplacePublication !== undefined',
      'Karavan marketplace dispatch guard unavailable',
      'await this.karavanMarketplaces.assertDispatch(attemptJob, candidateBotId ?? null)',
    ],
  ],
  [
    'apps/api/src/integrations/karavan-marketplace/karavan-marketplace-resolver.service.ts',
    [
      'this.prisma.karavanMarketplaceChatEnrollment.findUnique(',
      'const raw = job.ledgerContext?.karavanMarketplacePublication;',
      'karavanScopedPublicationSchema.parse(raw)',
      "this.config.get<boolean>('KARAVAN_STOREFRONT_RELAY_ENABLED') !== true",
      'candidateBotId !== publication.botId',
      'job.routing?.requiredBotId !== publication.botId',
      'await this.resolve(publication, publication)',
      'expected.bindingGeneration !== publication.bindingGeneration',
      'expected.sourceFingerprint !== issued.sourceFingerprint',
    ],
  ],
  [
    'apps/api/src/integrations/karavan-storefront/karavan-storefront-relay.service.ts',
    ['shouldUseScopedRelay(', 'karavanMarketplacePublication: params.scopedPublication'],
  ],
  [
    'apps/api/prisma/schema.prisma',
    [
      'model KaravanMarketplaceChatEnrollment {',
      'model KaravanMarketplaceBindingWitness {',
      'commerceRevocationEpoch',
    ],
  ],
]);

export function assertKaravanMarketplaceSource(sha, readSource) {
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('Exact source SHA required');
  for (const [path, markers] of KARAVAN_MARKETPLACE_SOURCE_CHECKS) {
    const source = readSource(path);
    if (
      typeof source !== 'string' ||
      source.length > 4 * 1024 * 1024 ||
      markers.some((marker) => !source.includes(marker))
    )
      throw new Error(
        `Rollback source lacks permanent Karavan enrollment/publication guards: ${path}`,
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = process.argv[2];
  try {
    assertKaravanMarketplaceSource(sha, (path) =>
      execFileSync('git', ['show', `${sha}:${path}`], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Karavan rollback source unavailable'}\n`,
    );
    process.exitCode = 1;
  }
}
