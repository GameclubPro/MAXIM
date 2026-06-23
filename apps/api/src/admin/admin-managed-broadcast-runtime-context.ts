import type { Logger } from '@nestjs/common';

import type { MaxClientService } from '../max/max-client.service';
import type { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import type { SystemModeSnapshot } from '../system/system-mode.service';

export type AdminManagedBroadcastRuntimeContext = {
  readonly prisma: PrismaService;
  readonly maxClient: MaxClientService;
  readonly logger: Logger;
  readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService;
  readonly managedEntityAccessLossService?: ManagedEntityAccessLossService;
  managedBroadcastDegradePauseLogAtMs: number;
  resolveSystemModeSnapshot(): Promise<SystemModeSnapshot>;
  read(prop: PropertyKey): unknown;
  write(prop: PropertyKey, value: unknown): void;
};

type AdminManagedBroadcastRuntimeContextTarget = {
  prisma: PrismaService;
  maxClient: MaxClientService;
  logger: Logger;
  backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService;
  managedEntityAccessLossService?: ManagedEntityAccessLossService;
  managedBroadcastDegradePauseLogAtMs: number;
  resolveSystemModeSnapshot(): Promise<SystemModeSnapshot>;
};

export function createAdminManagedBroadcastRuntimeContext(
  target: object,
): AdminManagedBroadcastRuntimeContext {
  const targetRecord = target as Record<PropertyKey, unknown>;
  const typedTarget = target as AdminManagedBroadcastRuntimeContextTarget;

  return {
    get prisma(): PrismaService {
      return typedTarget.prisma;
    },
    get maxClient(): MaxClientService {
      return typedTarget.maxClient;
    },
    get logger(): Logger {
      return typedTarget.logger;
    },
    get backgroundRuntimeGovernorService(): BackgroundRuntimeGovernorService | undefined {
      return typedTarget.backgroundRuntimeGovernorService;
    },
    get managedEntityAccessLossService(): ManagedEntityAccessLossService | undefined {
      return typedTarget.managedEntityAccessLossService;
    },
    get managedBroadcastDegradePauseLogAtMs(): number {
      return typedTarget.managedBroadcastDegradePauseLogAtMs;
    },
    set managedBroadcastDegradePauseLogAtMs(value: number) {
      typedTarget.managedBroadcastDegradePauseLogAtMs = value;
    },
    resolveSystemModeSnapshot(): Promise<SystemModeSnapshot> {
      return typedTarget.resolveSystemModeSnapshot();
    },
    read(prop: PropertyKey): unknown {
      return targetRecord[prop];
    },
    write(prop: PropertyKey, value: unknown): void {
      targetRecord[prop] = value;
    },
  };
}
