import { markMaxMessageSendAttempted } from './max-mutation-outcome.util';
import { beginMaxSendHttpObservation } from './max-send-observation';
import {
  maxHttpFailureOutcome,
  maxHttpValueOutcome,
  type MaxHttpFailureRequest,
  type MaxHttpOutcome,
} from './max-http-failure-association';

type MaxHttpRequestOptions<T> = {
  method: string;
  path: string;
  sendAttempted: boolean;
  request(): Promise<{ status: number; data: T }>;
  assertResponse(status: number, data: T): void;
};

export function performMaxHttpRequest<T>(
  options: MaxHttpRequestOptions<T> & { association: MaxHttpFailureRequest | null },
): Promise<MaxHttpOutcome<T>>;
export function performMaxHttpRequest<T>(
  options: MaxHttpRequestOptions<T> & { association?: undefined },
): Promise<T>;
export function performMaxHttpRequest<T>(
  options: MaxHttpRequestOptions<T> & {
    association: MaxHttpFailureRequest | null | undefined;
  },
): Promise<T | MaxHttpOutcome<T>>;
export async function performMaxHttpRequest<T>(
  options: MaxHttpRequestOptions<T> & { association?: MaxHttpFailureRequest | null },
): Promise<T | MaxHttpOutcome<T>> {
  const observation = beginMaxSendHttpObservation(options.method, options.path);
  let responseReceived = false;
  let receivedStatusCode: number | undefined;
  try {
    // FLAG: Called synchronously after the existing final guard, with no new
    // authority await before transport. Observation cannot retry this operation.
    const response = await options.request();
    const observeResponse = observation.received();
    responseReceived = true;
    receivedStatusCode = response.status;
    try {
      options.assertResponse(receivedStatusCode, response.data);
    } catch (error: unknown) {
      observeResponse(false);
      throw error;
    }
    observeResponse(true);
    return options.association !== undefined
      ? maxHttpValueOutcome(options.association ?? null, response.data, receivedStatusCode)
      : response.data;
  } catch (error: unknown) {
    if (!responseReceived) observation.failed();
    // FLAG: Only this exact request passed all guards and reached HTTP. Preserve
    // uncertain SEND evidence through raw helpers and queued dispatch alike.
    const failure = options.sendAttempted ? markMaxMessageSendAttempted(error) : error;
    if (options.association !== undefined) {
      return maxHttpFailureOutcome(
        options.association ?? null,
        failure,
        responseReceived ? 'response_rejection' : 'adapter_rejection',
        receivedStatusCode,
      );
    }
    throw failure;
  }
}
