import { HttpStatus, UnauthorizedException } from '@nestjs/common';

export const MINIAPP_AUTH_FAILURE_KINDS = ['missing', 'invalid', 'expired', 'future'] as const;

export type MiniappAuthFailureKind = (typeof MINIAPP_AUTH_FAILURE_KINDS)[number];
export type MiniappAuthErrorCode =
  | 'MINIAPP_AUTH_MISSING'
  | 'MINIAPP_AUTH_INVALID'
  | 'MINIAPP_AUTH_EXPIRED'
  | 'MINIAPP_AUTH_FUTURE';
export type MiniappAuthRecovery = 'check_clock_and_relaunch' | 'relaunch_miniapp';

type MiniappAuthFailureDefinition = {
  code: MiniappAuthErrorCode;
  recovery: MiniappAuthRecovery;
  retryable: false;
};

const MINIAPP_AUTH_FAILURE_DEFINITIONS: Record<
  MiniappAuthFailureKind,
  MiniappAuthFailureDefinition
> = {
  missing: {
    code: 'MINIAPP_AUTH_MISSING',
    retryable: false,
    recovery: 'relaunch_miniapp',
  },
  invalid: {
    code: 'MINIAPP_AUTH_INVALID',
    retryable: false,
    recovery: 'relaunch_miniapp',
  },
  expired: {
    code: 'MINIAPP_AUTH_EXPIRED',
    retryable: false,
    recovery: 'relaunch_miniapp',
  },
  future: {
    code: 'MINIAPP_AUTH_FUTURE',
    retryable: false,
    recovery: 'check_clock_and_relaunch',
  },
};

export class MiniappAuthException extends UnauthorizedException {
  readonly kind: MiniappAuthFailureKind;
  readonly code: MiniappAuthErrorCode;
  readonly retryable: false;
  readonly recovery: MiniappAuthRecovery;

  constructor(kind: MiniappAuthFailureKind, message: string) {
    const definition = MINIAPP_AUTH_FAILURE_DEFINITIONS[kind];
    super({
      statusCode: HttpStatus.UNAUTHORIZED,
      error: 'Unauthorized',
      message,
      code: definition.code,
      retryable: definition.retryable,
      recovery: definition.recovery,
    });
    this.name = 'MiniappAuthException';
    this.kind = kind;
    this.code = definition.code;
    this.retryable = definition.retryable;
    this.recovery = definition.recovery;
  }
}

export function isMiniappAuthException(error: unknown): error is MiniappAuthException {
  return error instanceof MiniappAuthException;
}
