import type { Logger } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import type { NormalizeChannelSuggestionImagesParams } from './admin-channel-dialog-mapping-runtime-context';
import type { ChannelSuggestionImageAsset } from './admin.service.support';

export type AdminChannelSuggestionImageRuntimeContext = {
  readonly logger: Logger;
  readonly prisma: Pick<PrismaService, 'channelSuggestionImageAsset'>;
  normalizeChannelSuggestionImages(
    params: NormalizeChannelSuggestionImagesParams,
  ): ChannelSuggestionImageAsset[];
  readChannelSuggestionImageAssets(value: unknown): ChannelSuggestionImageAsset[];
  readChannelSuggestionMediaType(value: unknown): 'image' | 'video' | null;
  readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null;
  readTrimmedString(value: unknown): string | null;
};

export function createAdminChannelSuggestionImageRuntimeContext(
  dependencies: AdminChannelSuggestionImageRuntimeContext,
): AdminChannelSuggestionImageRuntimeContext {
  return dependencies;
}
