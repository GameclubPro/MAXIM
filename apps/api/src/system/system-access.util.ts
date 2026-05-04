import type { ConfigService } from '@nestjs/config';

export type SystemAccessConfig = {
  systemAdminUserIds: ReadonlySet<string>;
  requireSystemAdmin: boolean;
};

export function readSystemAccessConfig(configService: ConfigService): SystemAccessConfig {
  const configuredUserIds = String(configService.get<string>('SYSTEM_ADMIN_USER_IDS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const nodeEnv = String(configService.get<string>('NODE_ENV', 'development')).trim().toLowerCase();

  return {
    systemAdminUserIds: new Set(configuredUserIds),
    requireSystemAdmin: nodeEnv === 'production' || configuredUserIds.length > 0,
  };
}

export function canUserAccessSystem(userId: string, config: SystemAccessConfig): boolean {
  if (!config.requireSystemAdmin) {
    return true;
  }

  return config.systemAdminUserIds.has(userId.trim());
}
