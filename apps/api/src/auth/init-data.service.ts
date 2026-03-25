import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';

@Injectable()
export class InitDataService {
  constructor(private readonly configService: ConfigService) {}

  validate(initData: string): AuthUser {
    const params = new URLSearchParams(this.normalizeInitData(initData));
    const receivedHash = params.get('hash');

    if (!receivedHash) {
      throw new UnauthorizedException('Missing hash in init data');
    }

    const sortedPairs = [...params.entries()]
      .filter(([key]) => key !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const botToken = this.configService.getOrThrow<string>('MAX_BOT_TOKEN');
    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = createHmac('sha256', secretKey).update(sortedPairs).digest('hex');

    if (!/^[a-f0-9]{64}$/i.test(receivedHash)) {
      throw new UnauthorizedException('Invalid init data signature');
    }

    if (receivedHash.length !== calculatedHash.length) {
      throw new UnauthorizedException('Invalid init data signature');
    }

    const valid = timingSafeEqual(
      Buffer.from(calculatedHash, 'hex'),
      Buffer.from(receivedHash.toLowerCase(), 'hex'),
    );
    if (!valid) {
      throw new UnauthorizedException('Invalid init data signature');
    }

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

  private normalizeInitData(raw: string): string {
    let current = raw.trim();

    for (let i = 0; i < 2; i += 1) {
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

    return current;
  }

  private parseChat(chatPayload: string | null): { chatId?: string; chatTitle?: string | null } | null {
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
      return {
        chatId: String(chatId),
        chatTitle: typeof chatTitle === 'string' ? chatTitle : null,
      };
    } catch {
      return null;
    }
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
