import { HttpException } from '@nestjs/common';
import { z } from 'zod';
const messages: Record<string, string> = {
  MARKETPLACE_REVISION_CONFLICT: 'Магазин изменился. Обновите экран перед сохранением.',
  MARKETPLACE_BINDING_CHANGED: 'Магазин чата изменился. Откройте его заново.',
  MARKETPLACE_IMPACT_CHANGED: 'Состав каталога изменился. Проверьте последствия ещё раз.',
  MARKETPLACE_SELF_REVIEW: 'Вашу витрину должен проверить другой администратор.',
  MARKETPLACE_RULES_NOTICE_REQUIRED:
    'Новые ограничения для действующих продавцов можно назначить через 14 дней.',
  MARKETPLACE_RULES_ALREADY_SCHEDULED: 'Сначала отмените запланированные изменения категорий.',
  MARKETPLACE_RULES_DATE_INVALID: 'Обновите проверку изменений перед сохранением.',
  MARKETPLACE_FORBIDDEN: 'Права администратора изменились. Откройте настройки чата заново.',
  MARKETPLACE_CATEGORIES_INVALID: 'Проверьте выбранные категории и подкатегории.',
  MARKETPLACE_PIN_UNAVAILABLE: 'Объявление сейчас не показывается в магазине.',
  MARKETPLACE_IMAGE_INVALID: 'Загрузите изображение заново.',
  MARKETPLACE_COMMAND_CONFLICT: 'Действие уже выполнено с другими данными. Обновите экран.',
  MARKETPLACE_CONTENT_NOT_FOUND: 'Объявление больше недоступно. Обновите каталог.',
};
export async function throwKnownKaravanManagementError(response: Response): Promise<void> {
  if (![400, 403, 404, 409, 422].includes(response.status)) return;
  try {
    const parsed = z.object({ error: z.string().max(100) }).safeParse(await response.json());
    if (parsed.success && messages[parsed.data.error])
      throw new HttpException(
        { code: parsed.data.error, message: messages[parsed.data.error] },
        response.status,
      );
  } catch (error) {
    if (error instanceof HttpException) throw error;
  }
}
