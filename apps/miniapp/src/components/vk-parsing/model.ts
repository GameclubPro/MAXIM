import type {
  UpdateVkParsingSettingsRequest,
  UpdateVkParsingSourceRequest,
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

export function resolveCommonVkParsingSourceValue<T>(values: readonly T[]): T | null {
  if (values.length === 0) {
    return null;
  }
  const [first] = values;
  return values.every((value) => value === first) ? first! : null;
}

export type VkParsingCommonNumericInput = {
  value: number | '';
  mixed: boolean;
};

export type VkParsingNumberDraftState = {
  draft: string;
  editing: boolean;
  pendingValue: number | null;
};

export type VkParsingNumberDraftAction =
  | { type: 'sync'; serverDraft: string }
  | { type: 'focus' }
  | { type: 'change'; draft: string }
  | { type: 'submit'; value: number }
  | { type: 'reset'; serverDraft: string };

export function resolveVkParsingCommonNumericInput(
  values: readonly number[],
): VkParsingCommonNumericInput {
  const commonValue = resolveCommonVkParsingSourceValue(values);
  return {
    value: commonValue ?? '',
    mixed: values.length > 0 && commonValue === null,
  };
}

export function createVkParsingNumberDraftState(value: number | ''): VkParsingNumberDraftState {
  return {
    draft: value === '' ? '' : String(value),
    editing: false,
    pendingValue: null,
  };
}

export function reduceVkParsingNumberDraft(
  state: VkParsingNumberDraftState,
  action: VkParsingNumberDraftAction,
): VkParsingNumberDraftState {
  if (action.type === 'sync') {
    if (state.editing || state.pendingValue !== null || state.draft === action.serverDraft) {
      return state;
    }
    return { ...state, draft: action.serverDraft };
  }
  if (action.type === 'focus') {
    return state.pendingValue === null ? { ...state, editing: true } : state;
  }
  if (action.type === 'change') {
    return state.editing && state.pendingValue === null ? { ...state, draft: action.draft } : state;
  }
  if (action.type === 'submit') {
    return {
      draft: String(action.value),
      editing: false,
      pendingValue: action.value,
    };
  }
  return {
    draft: action.serverDraft,
    editing: false,
    pendingValue: null,
  };
}

export function parseVkParsingIntegerDraft(value: string, min: number, max: number): number | null {
  if (!value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function buildVkParsingSourceIntervalUpdate(
  publishIntervalMinutes: number,
): UpdateVkParsingSourceRequest {
  return { publishIntervalMinutes };
}

export function buildVkParsingSourceDailyLimitUpdate(
  value: string,
): (UpdateVkParsingSourceRequest & { dailyLimit: number }) | null {
  const dailyLimit = parseVkParsingIntegerDraft(value, 1, 500);
  return dailyLimit === null ? null : { dailyLimit };
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
