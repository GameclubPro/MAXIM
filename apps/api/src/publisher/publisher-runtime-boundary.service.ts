import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherActionCredentialService } from './publisher-action-credential.service';

export class PublisherDispatchDisabledError extends Error {
  constructor() {
    super('MAX publisher dispatch is disabled');
    this.name = 'PublisherDispatchDisabledError';
  }
}

@Injectable()
export class PublisherRuntimeBoundaryService {
  readonly dispatchEnabled: boolean;

  constructor(configService: ConfigService, credentials: PublisherActionCredentialService) {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher runtime boundary loaded outside api-publisher');
    }
    credentials.getRequiredActionToken(credentials.getBotId());
    this.dispatchEnabled = configService.get<boolean>('MAX_PUBLISHER_DISPATCH_ENABLED', false);
  }

  assertDispatchEnabled(): void {
    if (!this.dispatchEnabled) {
      throw new PublisherDispatchDisabledError();
    }
  }
}
