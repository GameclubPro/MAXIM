import {
  publicationVideoUploadStatusSchema,
  type PublicationAsset,
  type PublicationVideoUploadStatus,
} from '@maxim/contracts/publication';
import { preparePublicationVideo } from '../../features/publications/publication-video-preparation';
import type { ApiTransport } from './transport';

export type PublicationVideoUploadProgress = { percent: number; processing: boolean };

function waitForVideoPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 1500);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function uploadVideoBinary(
  file: File,
  urlValue: string,
  signal: AbortSignal,
  onProgress: (value: PublicationVideoUploadProgress) => void,
): Promise<void> {
  const url = new URL(urlValue);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.okcdn.ru') ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    return Promise.reject(new Error('Адрес загрузки видео недоступен. Повторите выбор.'));
  }
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const finish = (error?: Error) => {
      signal.removeEventListener('abort', onAbort);
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
      xhr.upload.onprogress = null;
      if (error) reject(error);
      else resolve();
    };
    xhr.open('POST', url.toString());
    xhr.timeout = 10 * 60_000;
    xhr.withCredentials = false;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress({
          percent: Math.min(100, Math.round((event.loaded / event.total) * 100)),
          processing: false,
        });
    };
    xhr.onload = () =>
      finish(
        xhr.status >= 200 && xhr.status < 300
          ? undefined
          : new Error('MAX не принял видео. Повторите выбор файла.'),
      );
    xhr.onerror = () =>
      finish(new Error('Не удалось загрузить видео в MAX. Проверьте соединение и повторите.'));
    xhr.ontimeout = () =>
      finish(new Error('Загрузка видео заняла слишком много времени. Повторите.'));
    xhr.onabort = () => finish(new DOMException('Загрузка видео отменена.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    const form = new FormData();
    const metadata = preparePublicationVideo(file);
    form.append('data', file.slice(0, file.size, metadata.mimeType), metadata.fileName);
    try {
      xhr.send(form);
    } catch {
      finish(new Error('Не удалось прочитать или отправить видео. Повторите выбор.'));
    }
  });
}

export async function uploadPublicationVideo(
  api: ApiTransport,
  file: File,
  signal: AbortSignal,
  onProgress: (value: PublicationVideoUploadProgress) => void,
  uploadBinary = uploadVideoBinary,
): Promise<PublicationAsset> {
  const metadata = preparePublicationVideo(file);
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const path = `/publications/video-uploads/${requestId}`;
  const request = async (url: string, init = {}): Promise<PublicationVideoUploadStatus> =>
    publicationVideoUploadStatusSchema.parse(await api.request(url, { ...init, signal }));
  const waitUntil = async (
    status: PublicationVideoUploadStatus,
    expected: 'UPLOADING' | 'READY',
    timeoutMs: number,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (status.status !== expected) {
      if (status.status === 'FAILED') throw new Error(status.message);
      if (Date.now() >= deadline)
        throw new Error('MAX пока не подтвердил видео. Повторите выбор позже.');
      await waitForVideoPoll(signal);
      status = await request(path);
    }
    return status;
  };
  onProgress({ percent: 0, processing: false });
  const started = await request('/publications/video-uploads', {
    method: 'POST',
    body: JSON.stringify({ ...metadata, requestId }),
  });
  const session = await waitUntil(started, 'UPLOADING', 60_000);
  if (session.status !== 'UPLOADING') throw new Error('Не удалось начать загрузку видео.');
  await uploadBinary(file, session.url, signal, onProgress);
  signal.throwIfAborted();
  onProgress({ percent: 100, processing: true });
  const completion = await request(`${path}/complete`, { method: 'POST' });
  const ready = await waitUntil(completion, 'READY', 6 * 60_000);
  if (ready.status !== 'READY') throw new Error('Видео пока недоступно.');
  return ready.asset;
}
