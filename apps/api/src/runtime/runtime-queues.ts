import { BullModule } from '@nestjs/bullmq';
import type { DynamicModule } from '@nestjs/common';

const registrations = new Map<string, DynamicModule>();

/**
 * FLAG: Only name-only registrations using the inherited Bull root connection/prefix belong here.
 * Keep custom connection policies separate: Nest workers inherit their Queue's options.
 * Cache metadata, never Queue instances or clients, so separate Nest contexts retain ownership.
 */
export function registerRuntimeQueues(...names: readonly string[]): DynamicModule[] {
  return [...new Set(names)].map((name) => {
    let registration = registrations.get(name);
    if (!registration) {
      registration = BullModule.registerQueue({ name });
      registrations.set(name, registration);
    }
    return registration;
  });
}
