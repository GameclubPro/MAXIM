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

export function validateQuestion(value) {
  return (
    value?.type === 'question' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 200 &&
    typeof value.text === 'string' &&
    value.text.length <= 1200 &&
    Number.isFinite(value.deadline) &&
    value.deadline > Date.now() &&
    value.deadline <= Date.now() + 180_000 &&
    Array.isArray(value.history) &&
    value.history.length <= 6 &&
    value.history.every(
      (item) =>
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
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  const knowledgeSha = createHash('sha256')
    .update(readFileSync(new URL('./support-llm-knowledge.json', import.meta.url)))
    .digest('hex');
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
      failure = new Error('support_ssh_unavailable');
      controller.abort();
      resolve();
    });
    child.once('close', (code) => {
      if (code !== 0) failure = new Error('support_ssh_unavailable');
      controller.abort();
      resolve();
    });
  });
  send({ type: 'hello', modelSha256: SUPPORT_MODEL.sha256, knowledgeSha256: knowledgeSha });
  const heartbeat = setInterval(() => {
    if (Date.now() - lastServerHeartbeat > 25000) {
      failure = new Error('support_server_heartbeat_stale');
      stop();
    } else if (hello) send({ type: 'heartbeat' });
  }, 5000);
  const handshake = setTimeout(() => {
    if (!hello) {
      failure = new Error('support_handshake_deadline');
      stop();
    }
  }, 15_000);
  try {
    for await (const chunk of child.stdout) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 32768) throw new Error('support_frame_limit');
      let n;
      while ((n = pending.indexOf(10)) >= 0) {
        const value = JSON.parse(pending.subarray(0, n).toString('utf8'));
        pending = pending.subarray(n + 1);
        if (value.type === 'hello' && value.chatId === '-78271094414679' && !hello) {
          hello = true;
          lastServerHeartbeat = Date.now();
          onStatus('connected');
        } else if (
          hello &&
          value.type === 'heartbeat' &&
          (value.sampleAt === null ||
            (Number.isFinite(value.sampleAt) && value.sampleAt <= Date.now() + 5000))
        ) {
          lastServerHeartbeat = Date.now();
          onStatus('observation', { sampleAt: value.sampleAt });
        } else if (hello && validateQuestion(value) && !inference) {
          onStatus('answering');
          inference = (async () => {
            try {
              const answer = await invoke({
                text: value.text,
                history: value.history,
                key,
                signal: AbortSignal.any([
                  combined,
                  AbortSignal.timeout(Math.min(120_000, value.deadline - Date.now())),
                ]),
              });
              if (!combined.aborted && Date.now() < value.deadline)
                send({
                  type: 'answer',
                  id: value.id,
                  reply: answer.action === 'reply',
                  text: answer.text,
                });
              onStatus(answer.action === 'reply' ? 'answered' : 'skipped');
            } catch {
              if (!combined.aborted) {
                send({ type: 'answer', id: value.id, reply: false, text: '' });
                onStatus('inference_failed');
              }
            }
          })().finally(() => {
            inference = null;
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
    if (failure) throw failure;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(handshake);
    stop();
    signal.removeEventListener('abort', stop);
    await inference?.catch(() => undefined);
    await Promise.race([closed, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
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
  let phase = 'starting',
    lastSuccessAt = null,
    replies = 0,
    errors = 0,
    reconnects = 0,
    lastSampleAt = null,
    remoteHeartbeatAt = null;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const status = (next = phase, details = {}) => {
    if (next === 'observation') {
      remoteHeartbeatAt = new Date().toISOString();
      lastSampleAt = details.sampleAt ? new Date(details.sampleAt).toISOString() : null;
      next = phase;
    }
    phase = next;
    if (next === 'sent') {
      replies++;
      lastSuccessAt = new Date().toISOString();
      phase = 'connected';
    }
    if (next === 'inference_failed' || next === 'unknown' || next === 'refused') errors++;
    if (next === 'skipped' || next === 'answered') phase = 'connected';
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
      try {
        status('connecting');
        await supportChatSession({ key, signal: controller.signal, onStatus: status });
      } catch {
        errors++;
      }
      if (!controller.signal.aborted) {
        reconnects++;
        status('reconnecting');
        await pause(Math.min(30_000, 2000 * reconnects), undefined, {
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
