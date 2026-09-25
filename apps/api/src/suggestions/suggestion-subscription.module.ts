import { Module } from '@nestjs/common';
import { MaxModule } from '../max/max.module';
import { SuggestionSubscriptionService } from './suggestion-subscription.service';

@Module({
  imports: [MaxModule],
  providers: [SuggestionSubscriptionService],
  exports: [SuggestionSubscriptionService],
})
export class SuggestionSubscriptionModule {}
