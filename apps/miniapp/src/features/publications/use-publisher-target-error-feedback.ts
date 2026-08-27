import { useEffect } from 'react';
import { useToast } from '../../components/ui/toast';
import { describeUserFacingError } from '../../lib/user-facing-error';

export function usePublisherTargetErrorFeedback(options: {
  draftHydrationError: unknown;
  draftHydrationFailed: boolean;
}): void {
  const { pushToast } = useToast();

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
