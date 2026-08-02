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

type AdminChannelSuggestionImageRuntimeContextTarget = AdminChannelSuggestionImageRuntimeContext;

export function createAdminChannelSuggestionImageRuntimeContext(
  target: object,
): AdminChannelSuggestionImageRuntimeContext {
  const typedTarget = target as AdminChannelSuggestionImageRuntimeContextTarget;

  return {
    get logger(): Logger {
      return typedTarget.logger;
    },
    get prisma(): Pick<PrismaService, 'channelSuggestionImageAsset'> {
      return typedTarget.prisma;
    },
    normalizeChannelSuggestionImages(
      params: NormalizeChannelSuggestionImagesParams,
    ): ChannelSuggestionImageAsset[] {
      return typedTarget.normalizeChannelSuggestionImages(params);
    },
    readChannelSuggestionImageAssets(value: unknown): ChannelSuggestionImageAsset[] {
      return typedTarget.readChannelSuggestionImageAssets(value);
    },
    readChannelSuggestionMediaType(value: unknown): 'image' | 'video' | null {
      return typedTarget.readChannelSuggestionMediaType(value);
    },
    readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null {
      return typedTarget.readObjectPayloadOrNull(value);
    },
    readTrimmedString(value: unknown): string | null {
      return typedTarget.readTrimmedString(value);
    },
  };
}
