import { BadRequestException, ConflictException, HttpStatus } from '@nestjs/common';
import type { PublisherReadinessBlockerCode } from '@maxim/contracts/publisher';

const SETUP_MESSAGES: Record<PublisherReadinessBlockerCode, string> = {
  policy_disabled: 'Публик выключен администратором этого чата или канала.',
  module_disabled: 'Эта функция выключена администратором.',
  bot_not_connected: 'Публик не подключён к этому чату или каналу.',
  bot_not_admin: 'Публику нужны права администратора в этом чате или канале.',
  write_permission_missing: 'У Публика нет права отправлять сообщения в этот чат или канал.',
  bot_access_unconfirmed: 'Доступ Публика ещё не подтверждён. Повторите позже.',
  bot_access_expired: 'Обновляется проверка доступа Публика. Повторите позже.',
  route_quarantined: 'Отправка сообщений Публиком временно приостановлена. Повторите позже.',
  publisher_runtime_unavailable: 'Публик временно недоступен. Повторите позже.',
};

export class PublisherActorAccessRequiredException extends BadRequestException {
  constructor(readonly chatIds: readonly string[]) {
    super({
      code: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      message: 'Некоторые получатели недоступны. Перепроверьте свои права администратора.',
    });
  }
}

export class PublisherSetupRequiredException extends ConflictException {
  constructor(
    readonly chatIds: readonly string[],
    readonly blockerCode: string,
  ) {
    super({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: Object.hasOwn(SETUP_MESSAGES, blockerCode)
        ? SETUP_MESSAGES[blockerCode as PublisherReadinessBlockerCode]
        : blockerCode === 'catalog_unconfirmed'
          ? 'Подключение ещё не появилось в каталоге Публика. Перепроверьте его.'
          : blockerCode === 'audience_empty'
            ? 'Не осталось доступных получателей. Измените аудиторию публикации.'
            : 'Проверьте подключение и права Публика в этом чате или канале.',
      code: 'PUBLISHER_SETUP_REQUIRED',
      blockerCode,
      chatIds: [...chatIds],
    });
    this.name = 'PublisherSetupRequiredException';
  }
}

export class PublisherFeatureV2RequiredException extends ConflictException {
  constructor() {
    super({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: 'This action must be opened through a main bot',
      code: 'PUBLISHER_FEATURE_V2_REQUIRED',
    });
    this.name = 'PublisherFeatureV2RequiredException';
  }
}
