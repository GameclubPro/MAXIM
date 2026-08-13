import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP } from 'node:net';

const DEFAULT_ALLOWED_HOSTS = ['i.oneme.ru', 'fd.oneme.ru'];
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 16_777_216;
const DEFAULT_MAX_REDIRECTS = 2;
const DEFAULT_MAX_CONCURRENCY = 4;

type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

type PhotoDownloadResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  close: () => void;
};

export type DownloadedPhoto = {
  bytes: Buffer;
  format: 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'heif' | 'tiff';
};

export type SecurePhotoDownloadOptions = Readonly<{
  deadlineAtMs?: number;
}>;

export class PhotoDownloadHttpError extends Error {
  constructor(readonly statusCode: number) {
    super(`Photo host returned HTTP ${statusCode}`);
    this.name = 'PhotoDownloadHttpError';
  }
}

@Injectable()
export class SecurePhotoDownloader {
  private readonly allowedHosts: string[];
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly maxConcurrency: number;
  private activeDownloads = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(configService: ConfigService) {
    this.allowedHosts = parseAllowedHosts(
      configService.get<string>('PHOTO_DUPLICATE_ALLOWED_HOSTS'),
    );
    this.timeoutMs = parsePositiveConfig(
      configService.get<string | number>('PHOTO_DUPLICATE_DOWNLOAD_TIMEOUT_MS'),
      DEFAULT_TIMEOUT_MS,
    );
    this.maxBytes = parsePositiveConfig(
      configService.get<string | number>('PHOTO_DUPLICATE_MAX_BYTES'),
      DEFAULT_MAX_BYTES,
    );
    this.maxRedirects = DEFAULT_MAX_REDIRECTS;
    this.maxConcurrency = DEFAULT_MAX_CONCURRENCY;
  }

  async download(
    rawUrl: string,
    options: SecurePhotoDownloadOptions = {},
  ): Promise<DownloadedPhoto> {
    const configuredDeadlineAtMs = Date.now() + this.timeoutMs;
    const deadlineAtMs =
      options.deadlineAtMs === undefined
        ? configuredDeadlineAtMs
        : Math.min(configuredDeadlineAtMs, validateExternalDeadline(options.deadlineAtMs));
    const release = await this.acquireSlot(deadlineAtMs);
    try {
      return await this.downloadWithin(rawUrl, 0, deadlineAtMs);
    } finally {
      release();
    }
  }

  protected async resolveHost(hostname: string): Promise<ResolvedAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4,
    }));
  }

  protected request(
    url: URL,
    resolved: ResolvedAddress,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PhotoDownloadResponse> {
    return new Promise((resolve, reject) => {
      const request = requestHttps(
        url,
        {
          method: 'GET',
          agent: false,
          headers: {
            accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/tiff',
            'accept-encoding': 'identity',
            'user-agent': 'MAXIM-photo-duplicate/1',
          },
          lookup: (_hostname, options, callback) => {
            if (typeof options === 'object' && options.all) {
              callback(null, [resolved]);
              return;
            }
            callback(null, resolved.address, resolved.family);
          },
          servername: url.hostname,
          signal,
        },
        (response) => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: response,
            close: () => response.destroy(),
          });
        },
      );
      request.setTimeout(timeoutMs, () => request.destroy(new Error('Photo download timed out')));
      request.once('error', reject);
      request.end();
    });
  }

  private async downloadWithin(
    rawUrl: string,
    redirectCount: number,
    deadlineAtMs: number,
  ): Promise<DownloadedPhoto> {
    const url = parseAndValidateUrl(rawUrl, this.allowedHosts);
    const addresses = await withDeadline(this.resolveHost(url.hostname), deadlineAtMs);
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => !isPublicInternetAddress(address))
    ) {
      throw new Error('Photo host did not resolve exclusively to public addresses');
    }

    const response = await this.requestWithValidatedAddressFallback(url, addresses, deadlineAtMs);
    let responseClosed = false;
    const closeResponse = () => {
      if (responseClosed) {
        return;
      }
      responseClosed = true;
      response.close();
    };

    try {
      const redirectLocation = readRedirectLocation(response.statusCode, response.headers);
      if (redirectLocation !== null) {
        if (redirectCount >= this.maxRedirects) {
          throw new Error('Photo download exceeded the redirect limit');
        }
        const nextUrl = new URL(redirectLocation, url);
        closeResponse();
        return this.downloadWithin(nextUrl.toString(), redirectCount + 1, deadlineAtMs);
      }

      if (response.statusCode !== 200) {
        throw new PhotoDownloadHttpError(response.statusCode);
      }
      validateResponseContentType(response.headers['content-type']);
      const contentLength = parseContentLength(response.headers['content-length']);
      if (contentLength !== null && contentLength > this.maxBytes) {
        throw new Error('Photo response exceeds the byte limit');
      }

      const body = await withDeadline(readResponseBody(response.body, this.maxBytes), deadlineAtMs);
      closeResponse();
      if (body.byteLength === 0) {
        throw new Error('Photo response is empty');
      }

      const bytes = Buffer.concat(body.chunks, body.byteLength);
      const magicFormat = detectImageMagic(bytes);
      if (!magicFormat) {
        throw new Error('Photo response has an unsupported image signature');
      }
      return {
        bytes,
        format: magicFormat,
      };
    } finally {
      closeResponse();
    }
  }

  private async requestWithValidatedAddressFallback(
    url: URL,
    addresses: readonly ResolvedAddress[],
    deadlineAtMs: number,
  ): Promise<PhotoDownloadResponse> {
    let lastError: unknown;
    for (let index = 0; index < addresses.length; index += 1) {
      const attemptsLeft = addresses.length - index;
      const attemptBudgetMs = Math.max(1, Math.floor(remainingMs(deadlineAtMs) / attemptsLeft));
      const attemptDeadlineAtMs = Math.min(deadlineAtMs, Date.now() + attemptBudgetMs);
      const abortController = new AbortController();
      try {
        return await withDeadline(
          this.request(
            url,
            addresses[index],
            remainingMs(attemptDeadlineAtMs),
            abortController.signal,
          ),
          attemptDeadlineAtMs,
        );
      } catch (error: unknown) {
        abortController.abort();
        lastError = error;
        if (index + 1 < addresses.length) {
          remainingMs(deadlineAtMs);
        }
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error('Photo host could not be reached at any validated address');
  }

  private async acquireSlot(deadlineAtMs: number): Promise<() => void> {
    if (this.activeDownloads >= this.maxConcurrency) {
      let waiter: (() => void) | null = null;
      const waitForSlot = new Promise<void>((resolve) => {
        waiter = resolve;
        this.waiters.push(resolve);
      });
      try {
        await withDeadline(waitForSlot, deadlineAtMs);
      } catch (error: unknown) {
        const index = waiter ? this.waiters.indexOf(waiter) : -1;
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        throw error;
      }
    }
    this.activeDownloads += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeDownloads -= 1;
      this.waiters.shift()?.();
    };
  }
}

async function readResponseBody(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ chunks: Buffer[]; byteLength: number }> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    const buffer = Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maxBytes) {
      throw new Error('Photo response exceeds the byte limit');
    }
    chunks.push(buffer);
  }
  return { chunks, byteLength };
}

function parseAndValidateUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  if (rawUrl.length === 0 || rawUrl.length > 2_048) {
    throw new Error('Photo URL length is invalid');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Photo URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !hostMatchesAllowlist(url.hostname, allowedHosts)
  ) {
    throw new Error('Photo URL is not permitted');
  }
  return url;
}

function hostMatchesAllowlist(hostname: string, allowedHosts: readonly string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some((entry) => {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      return normalized.endsWith(suffix) && normalized.length > suffix.length;
    }
    return normalized === entry;
  });
}

function parseAllowedHosts(raw: string | undefined): string[] {
  const values = (raw ?? DEFAULT_ALLOWED_HOSTS.join(','))
    .split(',')
    .map((value) => value.trim().toLowerCase().replace(/\.$/, ''))
    .filter((value) => /^(?:\*\.)?[a-z0-9.-]+$/.test(value));
  if (values.length === 0) {
    throw new Error('PHOTO_DUPLICATE_ALLOWED_HOSTS must contain at least one valid hostname');
  }
  return [...new Set(values)];
}

function parsePositiveConfig(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  const normalized = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  return normalized;
}

function validateExternalDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Photo download deadline is invalid');
  }
  return value;
}

function readRedirectLocation(statusCode: number, headers: IncomingHttpHeaders): string | null {
  if (![301, 302, 303, 307, 308].includes(statusCode)) {
    return null;
  }
  const location = Array.isArray(headers.location) ? headers.location[0] : headers.location;
  if (!location || location.length > 2_048) {
    throw new Error('Photo redirect location is invalid');
  }
  return location;
}

function validateResponseContentType(value: string | string[] | undefined): void {
  const contentType = (Array.isArray(value) ? value[0] : value)
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType &&
    contentType !== 'application/octet-stream' &&
    !contentType.startsWith('image/')
  ) {
    throw new Error('Photo response content type is not an image');
  }
}

function parseContentLength(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Photo response content length is invalid');
  }
  return parsed;
}

function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && octets[2] === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && octets[2] === 100) ||
      (a === 203 && b === 0 && octets[2] === 113) ||
      a >= 224
    );
  }
  if (family !== 6) {
    return false;
  }

  const normalized = address.toLowerCase().split('%', 1)[0];
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('::ffff:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:') ||
    !/^[23]/.test(normalized)
  );
}

function detectImageMagic(bytes: Buffer): DownloadedPhoto['format'] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'png';
  }
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) {
    return 'gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  if (
    bytes.length >= 4 &&
    (bytes.subarray(0, 4).equals(Buffer.from('49492a00', 'hex')) ||
      bytes.subarray(0, 4).equals(Buffer.from('4d4d002a', 'hex')))
  ) {
    return 'tiff';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand === 'avif' || brand === 'avis') {
      return 'avif';
    }
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return 'heif';
    }
  }
  return null;
}

async function withDeadline<T>(operation: Promise<T>, deadlineAtMs: number): Promise<T> {
  const timeoutMs = remainingMs(deadlineAtMs);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Photo download timed out')), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function remainingMs(deadlineAtMs: number): number {
  const remaining = Math.trunc(deadlineAtMs - Date.now());
  if (remaining <= 0) {
    throw new Error('Photo download timed out');
  }
  return remaining;
}
