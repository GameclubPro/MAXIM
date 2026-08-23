import { Module } from '@nestjs/common';
import { AdminModule } from '../../admin/admin.module';
import { AuthModule } from '../../auth/auth.module';
import { MaxModule } from '../../max/max.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisCounterModule } from '../../moderation/redis-counter.module';
import { KaravanStorefrontAllowlistController } from './karavan-storefront-allowlist.controller';
import { KaravanStorefrontAllowlistService } from './karavan-storefront-allowlist.service';

@Module({
  imports: [AdminModule, AuthModule, MaxModule, PrismaModule, RedisCounterModule],
  controllers: [KaravanStorefrontAllowlistController],
  providers: [KaravanStorefrontAllowlistService],
  exports: [KaravanStorefrontAllowlistService],
})
export class KaravanStorefrontRelayModule {}
