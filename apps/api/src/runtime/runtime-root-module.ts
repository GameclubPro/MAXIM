import type { Type } from '@nestjs/common';
import type { AppRole } from './app-role';

export async function loadRuntimeRootModule(role: AppRole): Promise<Type<unknown>> {
  // FLAG: Keep imports in their branches: eager AppModule imports retain the full graph in every role.
  // Production Compose supplies APP_ROLE before loading. Without it the complete root retains
  // dotenv-driven local startup compatibility; ConfigModule validates role/service afterwards.
  if (role === 'message-retention') {
    return (await import('../message-retention/message-retention-app.module'))
      .MessageRetentionAppModule;
  }
  return (await import('../app.module')).AppModule;
}
