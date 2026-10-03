import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

import type { AdminSuggestionDeliveryJob } from './admin-suggestion-delivery.queue';

export type AdminSuggestionDeliveryRuntimeContext = {
  readonly logger: Logger;
  readonly adminSuggestionDeliveryQueue?: Queue<AdminSuggestionDeliveryJob>;
  processChannelSuggestionDeliveryJobWithinTimeout(auditLogId: string): Promise<void>;
};

export function createAdminSuggestionDeliveryRuntimeContext(
  dependencies: AdminSuggestionDeliveryRuntimeContext,
): AdminSuggestionDeliveryRuntimeContext {
  return dependencies;
}
