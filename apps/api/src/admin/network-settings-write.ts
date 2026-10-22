import type { Prisma } from '../prisma/prisma-client';
import type { ChannelSettings, ChatSettings } from '@maxim/contracts';

export type NetworkSettingsWriteOptions = {
  authoredKeys?: readonly (keyof ChatSettings)[];
  authoredChannelKeys?: readonly (keyof ChannelSettings)[];
  validateOnly?: boolean;
  deferFollowup?: boolean;
  onCommitted?: (tx: Prisma.TransactionClient, revision: string) => Promise<void>;
};
