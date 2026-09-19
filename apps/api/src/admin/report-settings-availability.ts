import { ConflictException } from '@nestjs/common';

export function assertReportsActivationAvailable(
  current: { reportsEnabled?: boolean } | null | undefined,
  next: { reportsEnabled?: boolean },
  available: boolean,
): void {
  if (next.reportsEnabled && !current?.reportsEnabled && !available) {
    throw new ConflictException({
      code: 'REPORTS_UNAVAILABLE',
      message: 'Приём жалоб приостановлен оператором. Включение пока недоступно.',
    });
  }
}
