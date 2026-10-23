import { ConfigService } from '@nestjs/config';
import { MARKETPLACE_PILOT_USER_ID } from './marketplace-state.service';

export function statisticsExchangeActorAllowed(
  config: ConfigService,
  actorUserId: string,
): boolean {
  const cohort = config.get<string>('SVYAZKA_STATISTICS_V2_USERS') ?? MARKETPLACE_PILOT_USER_ID;
  return cohort.trim() === '*' || cohort.split(',').some((value) => value.trim() === actorUserId);
}
