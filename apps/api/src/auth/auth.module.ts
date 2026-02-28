import { Global, Module } from '@nestjs/common';
import { InitDataGuard } from './init-data.guard';
import { InitDataService } from './init-data.service';

@Global()
@Module({
  providers: [InitDataService, InitDataGuard],
  exports: [InitDataService, InitDataGuard],
})
export class AuthModule {}
