import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { answerSupport } from './support-llm-client.mjs';
import { SUPPORT_MODEL } from './support-llm-profile.mjs';

const root = join(homedir(), '.local/share/maxim-support-llm');
const state = join(root, 'service');
const bundle = dirname(fileURLToPath(import.meta.url));
const sshArgs = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ConnectTimeout=8',
  '-o',
  'ServerAliveInterval=5',
  '-o',
  'ServerAliveCountMax=2',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  '-o',
  'ClearAllForwardings=yes',
  'maxim-vps',
  'cd /var/www/Chat_bot && exec node infra/scripts/support-chat-remote.mjs bridge',
];

const failureCodes = new Set([
  'support_ssh_unavailable',
  'support_server_heartbeat_stale',
  'support_handshake_deadline',
  'support_frame_limit',
  'support_frame_refused',
  'support_frame_invalid',
  'support_question_refused',
  'support_question_overlap',
  'support_clock_skew',
]);
export const supportChatFailureCode = (error) =>
  error instanceof Error && failureCodes.has(error.message)
    ? error.message
    : 'support_session_failed';

export class SupportReconnectPolicy {
  consecutive = 0;
  connectedAt = null;
  connected(now = Date.now()) {
    this.connectedAt = now;
  }
  observed(sampleAt, now = Date.now()) {
    // FLAG: Hello alone or stale polling cannot erase a failing reconnect history.
    if (
      this.connectedAt !== null &&
      now - this.connectedAt >= 30_000 &&
      Number.isSafeInteger(sampleAt) &&
      sampleAt >= 0 &&
      sampleAt <= now + 5000 &&
      now - sampleAt <= 30_000
    )
      this.consecutive = 0;
  }
  disconnected() {
    this.connectedAt = null;
    this.consecutive = Math.min(15, this.consecutive + 1);
    return 2000 * this.consecutive;
  }
}

export function validateQuestion(value) {
  const now = Date.now();
  return (
    value?.type === 'question' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 200 &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0 &&
    value.text.length <= 1200 &&
    Number.isSafeInteger(value.issuedAt) &&
    value.issuedAt >= 0 &&
    value.issuedAt <= now + 5000 &&
    Number.isFinite(value.deadline) &&
    value.deadline > now &&
    value.deadline > value.issuedAt &&
    // FLAG: Source timestamps may lead bridge time by five seconds; bridge time may
    // lead this host by five seconds. Keep the original source+180s absolute deadline.
    value.deadline <= value.issuedAt + 180_000 + 5000 &&
    Array.isArray(value.history) &&
    value.history.length <= 6 &&
    value.history.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        ['user', 'assistant'].includes(item.role) &&
        typeof item.text === 'string' &&
        item.text.length <= 300,
    )
  );
}

export async function supportChatSession({
  key,
  signal,
  onStatus = () => {},
  invoke = answerSupport,
  command = 'ssh',
  args = sshArgs,
}) {
  signal.throwIfAborted();
  const knowledgeSha = createHash('sha256')
    .update(readFileSync(new URL('./support-llm-knowledge.json', import.meta.url)))
    .digest('hex');
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  let hello = false,
    pending = Buffer.alloc(0),
    inference = null,
    failure = null,
    lastServerHeartbeat = Date.now();
  const send = (value) => {
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n');
  };
  const stop = () => {
    controller.abort();
    child.kill('SIGTERM');
  };
  signal.addEventListener('abort', stop, { once: true });
  child.stdin.on('error', stop);
  child.stderr.on('data', () => {});
  const closed = new Promise((resolve) => {
    child.once('error', () => {
      failure ??= new Error('support_ssh_unavailable');
      controller.abort();
      resolve();
    });
    child.once('close', (code) => {
      if (code !== 0) failure ??= new Error('support_ssh_unavailable');
      controller.abort();
      resolve();
    });
  });
  send({ type: 'hello', modelSha256: SUPPORT_MODEL.sha256, knowledgeSha256: knowledgeSha });
  const heartbeat = setInterval(() => {
    if (Date.now() - lastServerHeartbeat > 25000) {
      failure ??= new Error('support_server_heartbeat_stale');
      stop();
    } else if (hello) send({ type: 'heartbeat' });
  }, 5000);
  const handshake = setTimeout(() => {
    if (!hello) {
      failure ??= new Error('support_handshake_deadline');
      stop();
    }
  }, 15_000);
  try {
    for await (const chunk of child.stdout) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 32768) throw new Error('support_frame_limit');
      let n;
      while ((n = pending.indexOf(10)) >= 0) {
        let value;
        try {
          value = JSON.parse(pending.subarray(0, n).toString('utf8'));
        } catch {
          throw new Error('support_frame_invalid');
        }
        pending = pending.subarray(n + 1);
        if (!value || typeof value !== 'object') throw new Error('support_frame_refused');
        if (
          hello &&
          ((value.type === 'heartbeat' &&
            Number.isFinite(value.sampleAt) &&
            value.sampleAt > Date.now() + 5000) ||
            (value.type === 'question' &&
              Number.isFinite(value.issuedAt) &&
              value.issuedAt > Date.now() + 5000))
        )
          throw new Error('support_clock_skew');
        if (value.type === 'hello' && value.chatId === '-78271094414679' && !hello) {
          hello = true;
          lastServerHeartbeat = Date.now();
          onStatus('connected');
        } else if (
          hello &&
          value.type === 'heartbeat' &&
          (value.sampleAt === null ||
            (Number.isSafeInteger(value.sampleAt) &&
              value.sampleAt >= 0 &&
              value.sampleAt <= Date.now() + 5000))
        ) {
          lastServerHeartbeat = Date.now();
          onStatus('observation', { sampleAt: value.sampleAt });
        } else if (hello && value.type === 'question') {
          if (!validateQuestion(value)) throw new Error('support_question_refused');
          const previous = inference;
          if (previous) {
            if (
              previous.waiting ||
              previous.id === value.id ||
              (Date.now() < previous.deadline && value.issuedAt < previous.deadline)
            )
              throw new Error('support_question_overlap');
            // FLAG: A server-expired question loses all output authority immediately.
            // Admit one successor, but never start it before the prior invocation settles.
            previous.superseded = true;
            previous.controller.abort();
          }
          const current = {
            id: value.id,
            deadline: value.deadline,
            controller: new AbortController(),
            superseded: false,
            waiting: Boolean(previous),
            promise: null,
          };
          inference = current;
          current.promise = (async () => {
            try {
              if (previous) await previous.promise;
              current.waiting = false;
              if (combined.aborted) return;
              if (Date.now() >= value.deadline) {
                onStatus('inference_failed');
                return;
              }
              onStatus('answering');
              const answer = await invoke({
                text: value.text,
                history: value.history,
                key,
                signal: AbortSignal.any([
                  combined,
                  current.controller.signal,
                  AbortSignal.timeout(Math.min(120_000, value.deadline - Date.now())),
                ]),
              });
              if (!combined.aborted && !current.superseded) {
                if (Date.now() < value.deadline) {
                  send({
                    type: 'answer',
                    id: value.id,
                    reply: answer.action === 'reply',
                    text: answer.text,
                  });
                  onStatus(answer.action === 'reply' ? 'answered' : 'skipped');
                } else onStatus('inference_failed');
              }
            } catch {
              if (!combined.aborted && !current.superseded) {
                if (Date.now() < value.deadline)
                  send({ type: 'answer', id: value.id, reply: false, text: '' });
                onStatus('inference_failed');
              }
            }
          })().finally(() => {
            if (inference === current) inference = null;
          });
        } else if (
          hello &&
          value.type === 'settled' &&
          ['sent', 'unknown', 'refused'].includes(value.outcome)
        )
          onStatus(value.outcome);
        else throw new Error('support_frame_refused');
      }
    }
  } catch (error) {
    failure ??= error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(handshake);
    stop();
    signal.removeEventListener('abort', stop);
    // FLAG: Abort requests cancellation; only raw invocation settlement releases ownership.
    // Reconnecting before cleanup settles can start a second inference in the same process.
    await inference?.promise?.catch(() => undefined);
    await Promise.race([closed, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  // FLAG: A nonzero exit may arrive after stdout EOF. Preserve the first cause through cleanup.
  if (failure && !signal.aborted) throw failure;
}

async function run() {
  if (!existsSync(join(state, 'chat-enabled'))) return;
  const install = JSON.parse(readFileSync(join(state, 'installation.json'), 'utf8'));
  if (install.bundle !== bundle) throw new Error('support_installed_source_required');
  const key = readFileSync(join(state, 'api-key'), 'utf8').trim();
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const startTicks = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
    .split(') ')[1]
    .split(' ')[19];
  const reconnectPolicy = new SupportReconnectPolicy();
  let phase = 'starting',
    lastSuccessAt = null,
    replies = 0,
    errors = 0,
    reconnects = 0,
    lastSampleAt = null,
    remoteHeartbeatAt = null,
    lastFailureCode = null,
    lastFailureAt = null,
    lastDisconnectCode = null,
    lastDisconnectAt = null,
    reconnectDelayMs = 0;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const status = (next, details = {}) => {
    const event = next;
    if (next === 'connected') reconnectPolicy.connected();
    next ??= phase;
    if (next === 'observation') {
      remoteHeartbeatAt = new Date().toISOString();
      lastSampleAt = details.sampleAt === null ? null : new Date(details.sampleAt).toISOString();
      reconnectPolicy.observed(details.sampleAt);
      next = phase;
    }
    phase = next;
    if (event === 'sent') {
      replies++;
      lastSuccessAt = new Date().toISOString();
      phase = 'connected';
    }
    // FLAG: Heartbeat/observation writes must not count the previous outcome a second time.
    if (event === 'inference_failed' || event === 'unknown' || event === 'refused') errors++;
    if (event === 'skipped' || event === 'answered') phase = 'connected';
    const value = {
      pid: process.pid,
      startTicks,
      bundle,
      phase,
      heartbeatAt: new Date().toISOString(),
      lastSuccessAt,
      lastSampleAt,
      remoteHeartbeatAt,
      replies,
      errors,
      reconnects,
      consecutiveReconnects: reconnectPolicy.consecutive,
      reconnectDelayMs,
      lastFailureCode,
      lastFailureAt,
      lastDisconnectCode,
      lastDisconnectAt,
      model: SUPPORT_MODEL.alias,
      chatId: '-78271094414679',
    };
    const temporary = join(state, `chat-status.${process.pid}.tmp`);
    writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
    renameSync(temporary, join(state, 'chat-status.json'));
  };
  const heartbeat = setInterval(status, 5000);
  try {
    while (!controller.signal.aborted && existsSync(join(state, 'chat-enabled'))) {
      let sessionFailure = null;
      try {
        reconnectDelayMs = 0;
        status('connecting');
        await supportChatSession({ key, signal: controller.signal, onStatus: status });
      } catch (error) {
        if (!controller.signal.aborted) {
          errors++;
          sessionFailure = supportChatFailureCode(error);
          lastFailureCode = sessionFailure;
          lastFailureAt = new Date().toISOString();
        }
      }
      if (!controller.signal.aborted) {
        reconnects++;
        lastDisconnectCode = sessionFailure ?? 'support_session_closed';
        lastDisconnectAt = new Date().toISOString();
        reconnectDelayMs = reconnectPolicy.disconnected();
        status('reconnecting');
        await pause(reconnectDelayMs, undefined, {
          signal: controller.signal,
        }).catch(() => undefined);
      }
    }
  } finally {
    clearInterval(heartbeat);
    status('stopped');
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[2] === 'run'
)
  run().catch(() => {
    process.stderr.write('support_chat_unavailable\n');
    process.exitCode = 1;
  });
