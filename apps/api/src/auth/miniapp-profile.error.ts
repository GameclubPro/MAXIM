import { ForbiddenException, HttpStatus } from '@nestjs/common';

export class MiniappProfileForbiddenException extends ForbiddenException {
  readonly code = 'MINIAPP_PROFILE_FORBIDDEN';
  readonly retryable = false;
  readonly recovery = 'launch_supported_bot';

  constructor(message = 'This mini app profile cannot access the requested feature') {
    super({
      statusCode: HttpStatus.FORBIDDEN,
      error: 'Forbidden',
      message,
      code: 'MINIAPP_PROFILE_FORBIDDEN',
      retryable: false,
      recovery: 'launch_supported_bot',
    });
    this.name = 'MiniappProfileForbiddenException';
  }
}
