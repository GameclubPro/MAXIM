import { useEffect } from 'react';
import { useToast } from '../../components/ui/toast';
import { describeUserFacingError } from '../../lib/user-facing-error';

export function usePublisherTargetErrorFeedback(options: {
  directTargetError: unknown | null;
  draftHydrationError: unknown;
  draftHydrationFailed: boolean;
}): void {
  const { pushToast } = useToast();

  useEffect(() => {
    if (options.directTargetError) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось выбрать получателя из ссылки',
        description: describeUserFacingError(
          options.directTargetError,
          'Выберите получателя вручную.',
        ),
      });
    }
  }, [options.directTargetError, pushToast]);

  useEffect(() => {
    if (options.draftHydrationFailed) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось проверить выбранных получателей',
        description: describeUserFacingError(
          options.draftHydrationError,
          'Нажмите «Повторить» в блоке получателей.',
        ),
      });
    }
  }, [options.draftHydrationError, options.draftHydrationFailed, pushToast]);
}
