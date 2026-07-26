import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { ManagedAutopostService } from './managed-autopost.service';

@Injectable()
export class ManagedAutopostRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly retirementOwner = roleRunsAction(getAppRole());

  constructor(private readonly managedAutopostService: ManagedAutopostService) {}

  async onModuleInit(): Promise<void> {
    // FLAG: The action role owns this idempotent retirement transition. Existing materialized
    // broadcasts keep their independent schedule, but no legacy rule may remain apparently active.
    if (this.retirementOwner) {
      await this.managedAutopostService.pauseRetiredLegacyRules();
    }
  }

  onModuleDestroy(): void {
    return;
  }
}
