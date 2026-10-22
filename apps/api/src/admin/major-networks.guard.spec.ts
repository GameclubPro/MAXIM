import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { InitDataGuard } from '../auth/init-data.guard';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MajorNetworksGuard, type MajorNetworksRequest } from './major-networks.guard';
import { NetworkSettingsController } from './network-settings.controller';
import { NetworkStatisticsController } from './network-statistics.controller';
import { ManagedEntityNetworksController } from './managed-entity-networks.controller';

const user = (userId: string): AuthUser => ({ userId, username: null, displayName: null });
const request = (userId = 'tester'): MajorNetworksRequest => ({
  user: user(userId),
  miniappProfile: 'moderation',
});
function guard(mode?: string, testers = 'tester') {
  return new MajorNetworksGuard(
    new ConfigService({
      MAJOR_NETWORKS_ROLLOUT: mode,
      SYSTEM_ADMIN_USER_IDS: testers,
    }),
  );
}
const context = (value: MajorNetworksRequest) => new ExecutionContextHost([value]);

describe('MajorNetworksGuard', () => {
  it.each([undefined, 'off', 'invalid'])(
    'rejects %s even for a configured system admin',
    (mode) => {
      expect(() => guard(mode).canActivate(context(request()))).toThrow(ForbiddenException);
    },
  );

  it('limits test mode to the parsed system admin allowlist', () => {
    const canary = guard('test', '  tester , second  ');
    expect(canary.canActivate(context(request('tester')))).toBe(true);
    expect(canary.canActivate(context(request('second')))).toBe(true);
    expect(() => canary.canActivate(context(request('ordinary')))).toThrow(ForbiddenException);
    expect(() => guard('test', '').canActivate(context(request()))).toThrow(ForbiddenException);
  });

  it('admits an authenticated moderation account in on mode', () => {
    expect(guard('on').canActivate(context(request('ordinary')))).toBe(true);
  });

  it.each(['test', 'on'])('rejects Publisher in %s mode even for a system admin', (mode) => {
    expect(() =>
      guard(mode).canActivate(context({ ...request(), miniappProfile: 'publisher' })),
    ).toThrow(ForbiddenException);
  });

  it.each<MajorNetworksRequest>([
    {},
    { miniappProfile: 'moderation' },
    { user: user('tester') },
    { user: user(''), miniappProfile: 'moderation' },
    { user: user('  '), miniappProfile: 'moderation' },
  ])('fails closed for missing verified profile or principal %j', (value) => {
    expect(() => guard('on').canActivate(context(value))).toThrow(ForbiddenException);
  });

  it('guards new settings and statistics after authentication while retaining status and shared favorites', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, NetworkStatisticsController)).toEqual([
      InitDataGuard,
      MajorNetworksGuard,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, NetworkSettingsController)).toEqual([
      InitDataGuard,
    ]);
    for (const method of ['read', 'preview', 'apply'] as const) {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, NetworkSettingsController.prototype[method]),
      ).toEqual([MajorNetworksGuard]);
    }
    expect(
      Reflect.getMetadata(GUARDS_METADATA, NetworkSettingsController.prototype.status),
    ).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, ManagedEntityNetworksController)).toEqual([
      InitDataGuard,
    ]);
  });
});
