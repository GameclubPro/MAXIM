import type {
  UpdateVkParsingSettingsRequest,
  VkParsingFeed,
  VkParsingSource,
} from '@maxim/contracts';

export type VkParsingAutopostMode = 'manual' | 'auto' | 'pause';

export function resolveVkParsingAutopostMode(
  settings: Pick<VkParsingFeed['settings'], 'autoPublishEnabled' | 'autoPublishKillSwitchEnabled'>,
  sources: ReadonlyArray<
    Pick<
      VkParsingSource,
      | 'importEnabled'
      | 'autoPublishEnabled'
      | 'autoPublishPausedReason'
      | 'publishMode'
      | 'syncStatus'
      | 'terminalFailureCount'
      | 'circuitOpenedAt'
    >
  >,
): VkParsingAutopostMode {
  if (settings.autoPublishKillSwitchEnabled) {
    return 'pause';
  }
  if (!settings.autoPublishEnabled) {
    return 'manual';
  }
  const activeSources = sources.filter((source) => source.importEnabled);
  if (activeSources.length === 0 || activeSources.some((source) => source.autoPublishEnabled)) {
    return 'auto';
  }
  const hasRepairableSource = activeSources.some(
    (source) =>
      source.publishMode !== 'REVIEW' &&
      source.syncStatus !== 'ERROR' &&
      source.terminalFailureCount === 0 &&
      source.circuitOpenedAt === null &&
      (source.autoPublishPausedReason === null ||
        source.autoPublishPausedReason === 'manual' ||
        source.autoPublishPausedReason === 'preset'),
  );
  return hasRepairableSource ? 'manual' : 'auto';
}

export function buildVkParsingAutopostModeUpdate(
  mode: VkParsingAutopostMode,
): UpdateVkParsingSettingsRequest {
  const command = {
    auto: 'AUTO',
    manual: 'MANUAL',
    pause: 'PAUSED',
  } as const;
  return { autoPublishMode: command[mode] };
}

export function mergeVkParsingMutationFeed(
  currentFeed: VkParsingFeed | undefined,
  mutationFeed: VkParsingFeed,
): VkParsingFeed | undefined {
  if (!currentFeed) {
    return undefined;
  }

  return {
    ...mutationFeed,
    posts: currentFeed.posts,
    pagination: currentFeed.pagination,
  };
}

export function buildVkParsingSourceMetrics(
  source: Pick<VkParsingSource, 'newPostCount' | 'queuedPostCount' | 'failedPostCount'>,
) {
  return [
    { label: 'Входящие', value: source.newPostCount, danger: false },
    { label: 'Очередь', value: source.queuedPostCount, danger: false },
    { label: 'Ошибки', value: source.failedPostCount, danger: source.failedPostCount > 0 },
  ] as const;
}

export function buildVkParsingSourceConnectionToast(
  source: Pick<VkParsingSource, 'importEnabled' | 'autoPublishEnabled'> | undefined,
  alreadyConnected: boolean,
): { title: string; description?: string } {
  const modeLabel = !source
    ? null
    : !source.importEnabled
      ? 'Пауза'
      : source.autoPublishEnabled
        ? 'Авто'
        : 'Ручной режим';
  if (alreadyConnected) {
    return {
      title: 'Источник уже подключён',
      ...(modeLabel ? { description: modeLabel } : {}),
    };
  }
  return {
    title: 'Источник подключён',
    description: modeLabel ? `${modeLabel} · обновление запущено` : 'Обновление запущено',
  };
}
