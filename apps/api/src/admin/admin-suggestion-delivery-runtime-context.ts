import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

import type { AdminSuggestionDeliveryJob } from './admin-suggestion-delivery.queue';

export type AdminSuggestionDeliveryRuntimeContext = {
  readonly logger: Logger;
  readonly adminSuggestionDeliveryQueue?: Queue<AdminSuggestionDeliveryJob>;
  processChannelSuggestionDeliveryJobWithinTimeout(auditLogId: string): Promise<void>;
};

type AdminSuggestionDeliveryRuntimeContextTarget = {
  logger: Logger;
  adminSuggestionDeliveryQueue?: Queue<AdminSuggestionDeliveryJob>;
  processChannelSuggestionDeliveryJobWithinTimeout(auditLogId: string): Promise<void>;
};

export function createAdminSuggestionDeliveryRuntimeContext(
  target: object,
): AdminSuggestionDeliveryRuntimeContext {
  const typedTarget = target as AdminSuggestionDeliveryRuntimeContextTarget;

  return {
    get logger(): Logger {
      return typedTarget.logger;
    },
    get adminSuggestionDeliveryQueue(): Queue<AdminSuggestionDeliveryJob> | undefined {
      return typedTarget.adminSuggestionDeliveryQueue;
    },
    processChannelSuggestionDeliveryJobWithinTimeout(auditLogId: string): Promise<void> {
      return typedTarget.processChannelSuggestionDeliveryJobWithinTimeout(auditLogId);
    },
  };
}
