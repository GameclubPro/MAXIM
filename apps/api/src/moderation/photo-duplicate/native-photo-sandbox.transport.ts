import type { Socket } from 'node:net';
import {
  PHOTO_NATIVE_HEADER_BYTES,
  decodePhotoFrame,
  photoFrameLength,
} from './native-photo-sandbox.protocol';

export function readPhotoFrame(socket: Socket, deadlineAtMs: number, maxPayloadBytes: number) {
  return new Promise<ReturnType<typeof decodePhotoFrame>>((resolve, reject) => {
    const header = Buffer.alloc(PHOTO_NATIVE_HEADER_BYTES);
    let size = 0;
    let bytes: Buffer | null = null;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', data);
      socket.off('error', error);
      socket.off('close', closed);
    };
    const error = () => {
      cleanup();
      reject(new Error('Photo sandbox transport failed'));
    };
    const closed = () => {
      cleanup();
      reject(new Error('Photo sandbox transport closed'));
    };
    const data = (chunk: Buffer) => {
      try {
        let offset = 0;
        if (!bytes) {
          const copy = Math.min(PHOTO_NATIVE_HEADER_BYTES - size, chunk.length);
          chunk.copy(header, size, 0, copy);
          size += copy;
          offset += copy;
          if (size < PHOTO_NATIVE_HEADER_BYTES) return;
          // FLAG: Validate declared lengths before allocation, with one bounded buffer
          // independent of attacker-selected packet sizes or byte-at-a-time fragmentation.
          bytes = Buffer.allocUnsafe(photoFrameLength(header, maxPayloadBytes));
          header.copy(bytes);
        }
        if (chunk.length - offset > bytes.length - size)
          throw new Error('Photo frame exceeds bounds');
        chunk.copy(bytes, size, offset);
        size += chunk.length - offset;
        if (size === bytes.length) {
          const frame = decodePhotoFrame(bytes, maxPayloadBytes);
          cleanup();
          resolve(frame);
        }
      } catch {
        error();
        socket.destroy();
      }
    };
    const timer = setTimeout(
      () => {
        error();
        socket.destroy();
      },
      Math.max(1, Math.min(31_000, deadlineAtMs - Date.now())),
    );
    socket.on('data', data).once('error', error).once('close', closed);
  });
}
