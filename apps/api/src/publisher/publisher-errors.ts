import { ConflictException, HttpStatus } from '@nestjs/common';

export class PublisherSetupRequiredException extends ConflictException {
  constructor(
    readonly chatIds: readonly string[],
    readonly blockerCode: string,
  ) {
    super({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: 'Publik setup is required for the selected target',
      code: 'PUBLISHER_SETUP_REQUIRED',
      blockerCode,
      chatIds: [...chatIds],
    });
    this.name = 'PublisherSetupRequiredException';
  }
}

export class PublisherFeatureV2RequiredException extends ConflictException {
  constructor() {
    super({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: 'This action must be opened through a main bot',
      code: 'PUBLISHER_FEATURE_V2_REQUIRED',
    });
    this.name = 'PublisherFeatureV2RequiredException';
  }
}
