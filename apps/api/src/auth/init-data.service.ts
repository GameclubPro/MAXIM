import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';

const INIT_DATA_ALLOWED_CLOCK_SKEW_SEC = 30;

@Injectable()
export class InitDataService {
  private readonly botTokens: readonly string[];
  private readonly maxAgeSec: number;

  constructor(botRegistry: MaxBotRegistryService, configService: ConfigService) {
    this.botTokens = botRegistry.getValidationTokens();
    this.maxAgeSec = configService.get<number>('INIT_DATA_MAX_AGE_SEC', 300);
  }

  validate(initData: string): AuthUser {
    const { params, receivedHash, sortedPairs } = this.parseAndPrepareInitData(initData);

    if (!/^[a-f0-9]{64}$/i.test(receivedHash)) {
      throw new UnauthorizedException('Invalid init data signature');
    }

    const valid = this.botTokens.some((botToken) =>
      this.isValidHexSignature(
        receivedHash.toLowerCase(),
        this.calculateInitDataHash(sortedPairs, botToken),
      ),
    );
    if (!valid) {
      throw new UnauthorizedException('Invalid init data signature');
    }

    this.assertFreshAuthDate(params.get('auth_date'));

    const userPayload = params.get('user');
    if (!userPayload) {
      throw new UnauthorizedException('Missing user payload');
    }

    let parsedUser: Record<string, unknown>;
    try {
      parsedUser = JSON.parse(userPayload) as Record<string, unknown>;
    } catch {
      throw new UnauthorizedException('Invalid user payload');
    }

    const userId = String(parsedUser.id ?? parsedUser.user_id ?? '');
    if (!userId) {
      throw new UnauthorizedException('Missing user id');
    }

    const chatPayload = params.get('chat');
    const parsedChat = this.parseChat(chatPayload);

    return {
      userId,
      username: parsedUser.username ? String(parsedUser.username) : null,
      displayName: parsedUser.display_name
        ? String(parsedUser.display_name)
        : parsedUser.first_name
          ? String(parsedUser.first_name)
          : null,
      avatarUrl: parsedUser.photo_url
        ? String(parsedUser.photo_url)
        : parsedUser.photoUrl
          ? String(parsedUser.photoUrl)
          : null,
      profileUrl: this.readProfileUrl(
        parsedUser.profile_url,
        parsedUser.profileUrl,
        parsedUser.url,
        parsedUser.link,
      ),
      ...(parsedChat ? parsedChat : {}),
    };
  }

  private parseAndPrepareInitData(raw: string): {
    params: URLSearchParams;
    receivedHash: string;
    sortedPairs: string;
  } {
    const entries = this.parseInitDataEntries(this.normalizeInitData(raw));
    const hashEntries = entries.filter(([key]) => key === 'hash');
    if (hashEntries.length !== 1) {
      throw new UnauthorizedException('Missing hash in init data');
    }

    const receivedHash = hashEntries[0][1].trim();
    const params = new URLSearchParams();
    for (const [key, value] of entries) {
      params.append(key, value);
    }

    const sortedPairs = entries
      .filter(([key]) => key !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    return {
      params,
      receivedHash,
      sortedPairs,
    };
  }

  private normalizeInitData(raw: string): string {
    let current = raw.trim();

    for (let i = 0; i < 3; i += 1) {
      const extracted = this.extractWrappedInitData(current);
      if (extracted) {
        current = extracted;
      }

      if (current.includes('hash=')) {
        return current;
      }

      try {
        const decoded = decodeURIComponent(current);
        if (decoded === current) {
          break;
        }
        current = decoded;
      } catch {
        break;
      }
    }

    return this.extractWrappedInitData(current) ?? current;
  }

  private extractWrappedInitData(raw: string): string | null {
    const normalized = raw.trim().replace(/^[?#]/u, '');
    if (
      !normalized.includes('WebAppData=') &&
      !normalized.includes('init_data=') &&
      !normalized.includes('initData=')
    ) {
      return null;
    }

    const params = new URLSearchParams(normalized);
    for (const key of ['WebAppData', 'init_data', 'initData']) {
      const candidate = params.get(key);
      if (candidate?.trim()) {
        return candidate.trim();
      }
    }

    return null;
  }

  private parseInitDataEntries(value: string): Array<[string, string]> {
    const normalized = value.trim();
    if (!normalized) {
      throw new UnauthorizedException('Init data is empty');
    }

    const parts = normalized.split('&');
    const seen = new Set<string>();
    const entries: Array<[string, string]> = [];

    for (const part of parts) {
      if (!part) {
        throw new UnauthorizedException('Invalid init data payload');
      }

      const separatorIndex = part.indexOf('=');
      const rawKey = separatorIndex >= 0 ? part.slice(0, separatorIndex) : part;
      const rawValue = separatorIndex >= 0 ? part.slice(separatorIndex + 1) : '';
      const key = rawKey.trim();
      if (!key) {
        throw new UnauthorizedException('Invalid init data payload');
      }
      if (seen.has(key)) {
        throw new UnauthorizedException(`Duplicate init data parameter: ${key}`);
      }

      let decodedValue = rawValue;
      try {
        decodedValue = decodeURIComponent(rawValue.replace(/\+/g, '%20'));
      } catch {
        throw new UnauthorizedException(`Invalid init data parameter encoding: ${key}`);
      }

      seen.add(key);
      entries.push([key, decodedValue]);
    }

    return entries;
  }

  private assertFreshAuthDate(rawAuthDate: string | null) {
    if (!rawAuthDate) {
      throw new UnauthorizedException('Missing auth_date in init data');
    }

    const normalized = rawAuthDate.trim();
    if (!/^\d+$/u.test(normalized)) {
      throw new UnauthorizedException('Invalid auth_date in init data');
    }

    const authDateSec = Number.parseInt(normalized, 10);
    if (!Number.isFinite(authDateSec) || authDateSec <= 0) {
      throw new UnauthorizedException('Invalid auth_date in init data');
    }

    const nowSec = Math.floor(Date.now() / 1_000);
    if (authDateSec > nowSec + INIT_DATA_ALLOWED_CLOCK_SKEW_SEC) {
      throw new UnauthorizedException('Init data auth_date is in the future');
    }

    if (nowSec - authDateSec > this.maxAgeSec) {
      throw new UnauthorizedException('Init data has expired');
    }
  }

  private calculateInitDataHash(sortedPairs: string, botToken: string): string {
    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    return createHmac('sha256', secretKey).update(sortedPairs).digest('hex');
  }

  private isValidHexSignature(providedHex: string, expectedHex: string): boolean {
    return (
      providedHex.length === expectedHex.length &&
      timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'))
    );
  }

  private parseChat(
    chatPayload: string | null,
  ): { chatId?: string; chatTitle?: string | null; chatType?: AuthUser['chatType'] } | null {
    if (!chatPayload) {
      return null;
    }

    try {
      const parsed = JSON.parse(chatPayload) as Record<string, unknown>;
      const chatId = parsed.id ?? parsed.chat_id;
      if (typeof chatId !== 'string' && typeof chatId !== 'number') {
        return null;
      }

      const chatTitle = parsed.title ?? parsed.chat_title;
      const chatType = this.normalizeChatType(parsed.type ?? parsed.chat_type ?? parsed.chatType);
      return {
        chatId: String(chatId),
        chatTitle: typeof chatTitle === 'string' ? chatTitle : null,
        chatType,
      };
    } catch {
      return null;
    }
  }

  private normalizeChatType(value: unknown): AuthUser['chatType'] {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'channel') {
      return 'channel';
    }
    if (normalized === 'chat' || normalized === 'group' || normalized === 'supergroup') {
      return 'chat';
    }
    if (normalized === 'dialog') {
      return 'dialog';
    }

    return null;
  }

  private readProfileUrl(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') {
        continue;
      }

      const normalized = this.normalizeMaxProfileUrl(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private normalizeMaxProfileUrl(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      const hostname = parsed.hostname.toLowerCase();
      if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
        return null;
      }

      parsed.hash = '';
      return parsed.toString();
    } catch {
      return null;
    }
  }
}
