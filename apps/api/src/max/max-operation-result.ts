import type { MaxApiTrafficClass } from './max-client.service';

export type MaxOperationFailure = {
  ok: false;
  operation: string;
  trafficClass?: MaxApiTrafficClass;
  sourceTag?: string;
  status?: number;
  retryable: boolean;
  error: unknown;
};

export type MaxOperationSuccess<TValue = void> = {
  ok: true;
  operation: string;
  trafficClass?: MaxApiTrafficClass;
  sourceTag?: string;
  status?: number;
  value: TValue;
};

export type MaxOperationResult<TValue = void> =
  | MaxOperationSuccess<TValue>
  | MaxOperationFailure;
