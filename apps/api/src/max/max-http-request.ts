import { markMaxMessageSendAttempted } from './max-mutation-outcome.util';
import { beginMaxSendHttpObservation } from './max-send-observation';

export async function performMaxHttpRequest<T>(options: {
  method: string;
  path: string;
  sendAttempted: boolean;
  request(): Promise<{ status: number; data: T }>;
  assertResponse(status: number, data: T): void;
}): Promise<T> {
  const observation = beginMaxSendHttpObservation(options.method, options.path);
  let responseReceived = false;
  try {
    // FLAG: Called synchronously after the existing final guard, with no new
    // authority await before transport. Observation cannot retry this operation.
    const response = await options.request();
    const observeResponse = observation.received();
    responseReceived = true;
    try {
      options.assertResponse(response.status, response.data);
    } catch (error: unknown) {
      observeResponse(false);
      throw error;
    }
    observeResponse(true);
    return response.data;
  } catch (error: unknown) {
    if (!responseReceived) observation.failed();
    // FLAG: Only this exact request passed all guards and reached HTTP. Preserve
    // uncertain SEND evidence through raw helpers and queued dispatch alike.
    throw options.sendAttempted ? markMaxMessageSendAttempted(error) : error;
  }
}
