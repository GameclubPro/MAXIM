import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MaxModule } from '../max/max.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule, MaxModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
