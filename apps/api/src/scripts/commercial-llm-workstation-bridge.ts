import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { once } from 'node:events';
import { createCommercialLlmRedis } from '../moderation/commercial/commercial-llm-shadow.lease';
import { CommercialLlmWorkstationMailbox } from '../moderation/commercial/commercial-llm-workstation.mailbox';
import {
  COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES,
  COMMERCIAL_LLM_WORKSTATION_HEARTBEAT_MS,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY,
  commercialLlmWorkstationIdentityMatches,
} from '../moderation/commercial/commercial-llm-workstation.protocol';

// FLAG: SSH stdio carries sanitized, expiring observations only; no DB or MAX client is loaded.
export async function commercialLlmWorkstationBridge(): Promise<void> {
  if (
    process.env.APP_SERVICE_NAME !== 'api-moderation-background' ||
    process.env.COMMERCIAL_LLM_SHADOW_ENABLED !== 'true' ||
    !process.env.REDIS_URL
  )
    throw new Error('workstation_role_refused');
  const redis = createCommercialLlmRedis(process.env.REDIS_URL);
  const mailbox = new CommercialLlmWorkstationMailbox(redis);
  const owner = randomUUID(),
    controller = new AbortController();
  let hello = false,
    ready = false,
    lastReadyAt = 0,
    sentId: string | null = null;
  let receivedInWindow = 0,
    windowAt = Date.now();
  const sessionEnd = Date.now() + 30 * 60_000;
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  process.stdout.on('error', abort);
  const send = async (value: unknown) => {
    const frame = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(frame) > COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES)
      throw new Error('workstation_frame_refused');
    if (!process.stdout.write(frame))
      await once(process.stdout, 'drain', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
      });
  };
  let receive: Promise<void> | null = null;
  try {
    await redis.connect();
    if (!(await mailbox.acquireWorker(owner))) throw new Error('workstation_already_connected');
    receive = (async () => {
      let pending = Buffer.alloc(0);
      for await (const chunk of process.stdin) {
        pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (pending.length > COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES)
          throw new Error('workstation_frame_refused');
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (Date.now() - windowAt >= 60_000) {
            windowAt = Date.now();
            receivedInWindow = 0;
          }
          if (++receivedInWindow > 120) throw new Error('workstation_rate_refused');
          const message: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(line),
          );
          if (!message || typeof message !== 'object' || Array.isArray(message))
            throw new Error('workstation_frame_refused');
          const value = message as Record<string, unknown>;
          if (!hello) {
            if (
              value.type !== 'hello' ||
              Object.keys(value).length !== 2 ||
              !commercialLlmWorkstationIdentityMatches(value.identity)
            )
              throw new Error('workstation_identity_refused');
            hello = true;
            await send({ type: 'hello', identity: COMMERCIAL_LLM_WORKSTATION_IDENTITY });
          } else if (
            value.type === 'ready' &&
            typeof value.ready === 'boolean' &&
            Object.keys(value).length === 2
          ) {
            ready = value.ready;
            lastReadyAt = Date.now();
          } else if (
            value.type === 'response' &&
            typeof value.id === 'string' &&
            /^[a-f0-9-]{36}$/u.test(value.id) &&
            typeof value.body === 'string' &&
            Object.keys(value).length === 3
          ) {
            await mailbox.respond(owner, value.id, value.body);
          } else if (
            value.type === 'failed' &&
            typeof value.id === 'string' &&
            /^[a-f0-9-]{36}$/u.test(value.id) &&
            Object.keys(value).length === 2
          ) {
            if (value.id === sentId) {
              ready = false;
              lastReadyAt = Date.now();
            }
            await mailbox.respond(owner, value.id, 'null');
          } else throw new Error('workstation_frame_refused');
        }
      }
      if (pending.length) throw new Error('workstation_frame_refused');
    })();
    // FLAG: Consume receiver failure immediately; the session and its private lease end together.
    void receive.then(abort, abort);
    const handshakeDeadline = Date.now() + 10_000;
    while (!controller.signal.aborted && Date.now() < sessionEnd) {
      if (!hello && Date.now() > handshakeDeadline)
        throw new Error('workstation_handshake_deadline');
      if (hello && Date.now() - (lastReadyAt || handshakeDeadline - 10_000) > 10_000)
        throw new Error('workstation_heartbeat_deadline');
      const healthy =
        hello && ready && Date.now() - lastReadyAt < COMMERCIAL_LLM_WORKSTATION_HEARTBEAT_MS;
      const request = await mailbox.refreshWorker(owner, healthy);
      if (request && request.id !== sentId) {
        sentId = request.id;
        await send({
          type: 'request',
          id: request.id,
          body: request.body,
          timeoutMs: request.remainingMs,
        });
      }
      await pause(250, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  } finally {
    controller.abort();
    process.stdin.destroy();
    await receive?.catch(() => undefined);
    await mailbox.releaseWorker(owner).catch(() => undefined);
    redis.disconnect();
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    process.stdout.removeListener('error', abort);
  }
}

if (require.main === module) {
  commercialLlmWorkstationBridge().catch(() => {
    process.stderr.write('workstation_bridge_unavailable\n');
    process.exitCode = 1;
  });
}
