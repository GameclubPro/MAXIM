import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from './photo-fingerprint-version';
import { PhotoNativeContainmentError, runNativePhotoWorker } from './native-photo-runner';
import {
  encodePhotoFrame,
  PHOTO_NATIVE_MAX_BYTES,
  PHOTO_NATIVE_MAX_PIXELS,
  PHOTO_NATIVE_MAX_EXECUTION_MS,
  PHOTO_NATIVE_PROTOCOL_VERSION,
  PHOTO_NATIVE_SOCKET_PATH,
  PHOTO_NATIVE_TEARDOWN_GRACE_MS,
  parsePhotoRequest,
} from './native-photo-sandbox.protocol';
import { readPhotoFrame } from './native-photo-sandbox.transport';

export const PHOTO_NATIVE_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'NODE_ENV',
  'VIPS_CONCURRENCY',
  'PHOTO_NATIVE_SANDBOX_SOCKET_PATH',
  'PHOTO_DUPLICATE_MAX_BYTES',
  'PHOTO_DUPLICATE_MAX_PIXELS',
] as const;

export async function startNativePhotoSandbox(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    networkInterfaces?: typeof networkInterfaces;
    runWorker?: typeof runNativePhotoWorker;
    fatalExit?: () => void;
    allowTestSocketPath?: boolean;
  } = {},
) {
  const allowed = new Set<string>(PHOTO_NATIVE_ENV_ALLOWLIST);
  for (const name of Object.keys(environment)) if (!allowed.has(name)) delete environment[name];
  environment.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  environment.HOME = '/home/node';
  environment.LANG = 'C.UTF-8';
  environment.NODE_ENV = 'production';
  environment.VIPS_CONCURRENCY = '1';
  if (
    process.platform === 'win32' ||
    Object.values((dependencies.networkInterfaces ?? networkInterfaces)()).some((entries) =>
      entries?.some((entry) => !entry.internal),
    )
  )
    throw new Error('Photo sandbox requires a network-isolated POSIX runtime');
  if (
    Number(environment.PHOTO_DUPLICATE_MAX_BYTES ?? PHOTO_NATIVE_MAX_BYTES) !==
      PHOTO_NATIVE_MAX_BYTES ||
    Number(environment.PHOTO_DUPLICATE_MAX_PIXELS ?? PHOTO_NATIVE_MAX_PIXELS) !==
      PHOTO_NATIVE_MAX_PIXELS
  )
    throw new Error('Unexpected photo sandbox resource limit');
  const socketPath = environment.PHOTO_NATIVE_SANDBOX_SOCKET_PATH ?? PHOTO_NATIVE_SOCKET_PATH;
  if (!dependencies.allowTestSocketPath && socketPath !== PHOTO_NATIVE_SOCKET_PATH)
    throw new Error('Invalid photo sandbox runtime socket');
  const directory = await lstat(dirname(socketPath));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error('Photo socket directory must be owner-private');
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket() || existing.uid !== process.getuid?.())
      throw new Error('Invalid photo socket file');
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const runWorker = dependencies.runWorker ?? runNativePhotoWorker;
  const fatalExit = dependencies.fatalExit ?? (() => process.exit(70));
  const instanceId = randomUUID();
  const sockets = new Set<Socket>();
  let active: AbortController | null = null;
  let activeWork: Promise<void> | null = null;
  let poisoned = false;
  let closing = false;
  const server = createServer((socket) => {
    if (sockets.size >= 3 || poisoned || closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const controller = new AbortController();
    socket.on('error', () => controller.abort());
    socket.once('close', () => {
      sockets.delete(socket);
      controller.abort();
    });
    void (async () => {
      const frame = await readPhotoFrame(socket, Date.now() + 5_000, PHOTO_NATIVE_MAX_BYTES);
      if (controller.signal.aborted || closing) {
        socket.destroy();
        return;
      }
      if (frame.metadata.operation === 'probe' && frame.payload.length === 0) {
        socket.end(
          encodePhotoFrame({
            protocolVersion: PHOTO_NATIVE_PROTOCOL_VERSION,
            algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
            network: 'none',
            environment: 'allowlist',
            processGroupTeardown: 'verified_or_cgroup_recycle',
            instanceId,
          }),
        );
        return;
      }
      const request = parsePhotoRequest(frame.metadata);
      if (active || poisoned) {
        socket.end(encodePhotoFrame({ kind: 'rejected', reason: 'decode_capacity_exceeded' }));
        return;
      }
      const remaining = request.deadlineAtMs - Date.now();
      if (
        remaining <= PHOTO_NATIVE_TEARDOWN_GRACE_MS ||
        remaining > PHOTO_NATIVE_MAX_EXECUTION_MS
      ) {
        socket.end(encodePhotoFrame({ kind: 'rejected', reason: 'decode_deadline_exceeded' }));
        return;
      }
      active = controller;
      activeWork = (async () => {
        try {
          const result = await runWorker(
            { ...request, deadlineAtMs: request.deadlineAtMs - PHOTO_NATIVE_TEARDOWN_GRACE_MS },
            frame.payload,
            controller.signal,
          );
          if (!socket.destroyed) socket.end(encodePhotoFrame(result));
          // FLAG: Abandoned/timed-out native work recycles the whole sandbox cgroup,
          // including descendants that could escape a compromised child's process group.
          if (
            result.kind === 'rejected' &&
            (result.reason === 'decode_deadline_exceeded' || result.reason === 'native_unavailable')
          ) {
            poisoned = true;
            setImmediate(fatalExit);
          }
        } catch (error) {
          if (error instanceof PhotoNativeContainmentError) {
            poisoned = true;
            fatalExit();
          }
          socket.destroy();
        } finally {
          if (!poisoned) active = null;
        }
      })();
      await activeWork;
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    close: async () => {
      closing = true;
      active?.abort();
      for (const socket of sockets) socket.destroy();
      await activeWork;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}
