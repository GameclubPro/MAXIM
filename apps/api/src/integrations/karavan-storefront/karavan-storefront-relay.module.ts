import { Module } from '@nestjs/common';
import { MaxModule } from '../../max/max.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisCounterModule } from '../../moderation/redis-counter.module';
import { KaravanStorefrontRelayService } from './karavan-storefront-relay.service';

@Module({
  imports: [MaxModule, PrismaModule, RedisCounterModule],
  providers: [KaravanStorefrontRelayService],
  exports: [KaravanStorefrontRelayService],
})
export class KaravanStorefrontRelayModule {}
