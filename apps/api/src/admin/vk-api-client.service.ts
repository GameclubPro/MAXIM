import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { formatVkParsingError, VkApiRequestError } from './vk-parsing-errors';
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';

const VK_API_RATE_LIMIT_ERROR_CODE = 6;
const VK_API_RETRYABLE_ERROR_CODES = new Set([VK_API_RATE_LIMIT_ERROR_CODE, 9, 10, 29]);
const VK_API_TERMINAL_ERROR_CODES = new Set([5, 14, 15, 18, 19, 30, 100, 203, 210]);
const VK_API_REQUEST_BUDGET_MS = 20_000;

@Injectable()
export class VkApiClientService {
  private readonly vkApiBaseUrl: string;
  private readonly vkApiVersion: string;
  private readonly vkApiTimeoutMs: number;
  private readonly vkApiMaxAttempts: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly vkRateLimitService: VkParsingRateLimitService,
  ) {
    this.vkApiBaseUrl = this.normalizeBaseUrl(
      configService.get<string>('VK_API_BASE_URL') ?? 'https://api.vk.ru',
    );
    this.vkApiVersion = configService.get<string>('VK_API_VERSION') ?? '5.199';
    this.vkApiTimeoutMs = configService.get<number>('VK_API_TIMEOUT_MS') ?? 10_000;
    this.vkApiMaxAttempts = configService.get<number>('VK_API_MAX_ATTEMPTS') ?? 3;
  }

  async request(method: string, params: Record<string, string>): Promise<unknown> {
    const token = this.configService.get<string>('VK_SERVICE_TOKEN')?.trim();
    if (!token) {
      throw new ServiceUnavailableException('VK_SERVICE_TOKEN не настроен.');
    }

    const deadlineAt = Date.now() + VK_API_REQUEST_BUDGET_MS;
    for (let attempt = 1; attempt <= this.vkApiMaxAttempts; attempt += 1) {
      try {
        await this.vkRateLimitService.reserveVkApiSlot(method);
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          throw new VkApiRequestError('VK API не ответил вовремя.', 'timeout', true);
        }
        const payload = await this.fetchVkApi(
          method,
          params,
          token,
          Math.min(this.vkApiTimeoutMs, remainingMs),
        );
        const record = this.asRecord(payload);

        const error = this.asRecord(record?.error);
        if (error) {
          const code = this.readNumber(error.error_code);
          const message =
            code === 14
              ? 'VK требует капчу или токен не подходит для запроса.'
              : this.readString(error.error_msg) || 'VK API отклонил запрос.';
          throw new VkApiRequestError(
            code ? `VK API: ${message} (${code})` : `VK API: ${message}`,
            code ? `vk_${code}` : 'vk_unknown',
            code ? this.isRetryableVkApiErrorCode(code) : false,
          );
        }

        if (!record || record.response === undefined || record.response === null) {
          throw new VkApiRequestError('VK API вернул неполный ответ.', 'invalid_response', true);
        }
        await this.vkRateLimitService.recordVkApiOutcome({ method, outcome: 'success' });
        return record.response;
      } catch (error) {
        const classified = this.classifyVkRequestError(error);
        await this.vkRateLimitService.recordVkApiOutcome({
          method,
          outcome: 'error',
          code: classified.code,
        });
        const retryDelayMs = this.resolveVkRequestRetryDelayMs(attempt, classified.code);
        if (
          !classified.retryable ||
          attempt >= this.vkApiMaxAttempts ||
          Date.now() + retryDelayMs >= deadlineAt
        ) {
          throw classified.error;
        }

        await this.sleep(retryDelayMs);
      }
    }

    throw new VkApiRequestError('VK API временно недоступен.', 'retry_exhausted', true);
  }

  private async fetchVkApi(
    method: string,
    params: Record<string, string>,
    token: string,
    timeoutMs: number,
  ): Promise<unknown> {
    const search = new URLSearchParams({
      ...params,
      v: this.vkApiVersion,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.vkApiBaseUrl}/method/${method}?${search.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new VkApiRequestError(
          `VK API вернул статус ${response.status}.`,
          `http_${response.status}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      return await this.readVkResponsePayload(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new VkApiRequestError('VK API не ответил вовремя.', 'timeout', true);
      }
      if (error instanceof VkApiRequestError) throw error;
      const aborted =
        error instanceof Error &&
        (error.name === 'AbortError' || /abort|timeout/iu.test(error.message));
      throw new VkApiRequestError(
        aborted ? 'VK API не ответил вовремя.' : 'VK API временно недоступен.',
        aborted ? 'timeout' : 'network',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readVkResponsePayload(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new VkApiRequestError('VK API вернул нечитаемый ответ.', 'invalid_json', true);
    }
  }

  private classifyVkRequestError(error: unknown): {
    error: VkApiRequestError;
    code: string;
    retryable: boolean;
  } {
    if (error instanceof VkApiRequestError) {
      return { error, code: error.code, retryable: error.retryable };
    }

    const wrapped = new VkApiRequestError(formatVkParsingError(error), 'unknown', true);
    return { error: wrapped, code: wrapped.code, retryable: wrapped.retryable };
  }

  private isRetryableVkApiErrorCode(code: number): boolean {
    if (VK_API_RETRYABLE_ERROR_CODES.has(code)) {
      return true;
    }
    if (VK_API_TERMINAL_ERROR_CODES.has(code)) {
      return false;
    }

    return false;
  }

  private resolveVkRequestRetryDelayMs(attempt: number, code: string): number {
    const rateLimitDelayMs = code === `vk_${VK_API_RATE_LIMIT_ERROR_CODE}` ? 1_000 : 0;
    const baseMs = Math.max(250, rateLimitDelayMs);
    return Math.min(5_000, baseMs * 2 ** Math.max(0, attempt - 1));
  }

  private normalizeBaseUrl(value: string): string {
    return value.replace(/\/+$/u, '');
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private readNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
