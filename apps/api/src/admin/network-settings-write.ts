import type { Prisma } from '../prisma/prisma-client';
import type { ChannelSettings, ChatSettings } from '@maxim/contracts';

export type NetworkSettingsWriteOptions = {
  authoredKeys?: readonly (keyof ChatSettings)[];
  authoredChannelKeys?: readonly (keyof ChannelSettings)[];
  validateOnly?: boolean;
  beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void>;
  deferFollowup?: boolean;
  onCommitted?: (tx: Prisma.TransactionClient, revision: string) => Promise<void>;
};
