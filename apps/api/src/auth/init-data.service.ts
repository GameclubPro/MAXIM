import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';

@Injectable()
export class InitDataService {
  constructor(private readonly configService: ConfigService) {}

  validate(initData: string): AuthUser {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');

    if (!receivedHash) {
      throw new UnauthorizedException('Missing hash in init data');
    }

    const sortedPairs = [...params.entries()]
      .filter(([key]) => key !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secret = this.configService.getOrThrow<string>('INIT_DATA_HMAC_SECRET');
    const calculatedHash = createHmac('sha256', secret).update(sortedPairs).digest('hex');

    if (receivedHash.length !== calculatedHash.length) {
      throw new UnauthorizedException('Invalid init data signature');
    }

    const valid = timingSafeEqual(Buffer.from(calculatedHash), Buffer.from(receivedHash));
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

    return {
      userId,
      username: parsedUser.username ? String(parsedUser.username) : null,
      displayName: parsedUser.display_name
        ? String(parsedUser.display_name)
        : parsedUser.first_name
          ? String(parsedUser.first_name)
          : null,
    };
  }
}
