import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { MarketplaceStateService } from './marketplace-state.service';

@Module({
  imports: [PrismaModule, ConfigModule],
  providers: [MarketplaceStateService],
  exports: [MarketplaceStateService],
})
export class MarketplaceStateModule {}
