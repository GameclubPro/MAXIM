import {
  MESSAGE_LIMITS_BLOCKED_DOMAINS_MAX,
  MESSAGE_LIMITS_BLOCKED_WORDS_MAX,
  REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
  type ApplySettingsTarget,
  chatRulesSchema,
  chatSettingsSchema,
  normalizeAllowlistDomain,
  normalizeAllowlistLink,
  normalizeStoredAllowlistEntry,
  stepDeleteBotMessagesDelayMinutes,
  type AllowlistMatchType,
  type ChatRules,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type DomainAllowlistEntry,
} from '@maxim/contracts/settings';
import {
  type BroadcastLinkButton,
  type BroadcastTargetMode,
  type ManagedAutopostRuleDetails,
  type ManagedAutopostRuleSummary,
  type ManagedBroadcastDetails,
} from '@maxim/contracts/broadcast';
import { type ChatSummary, type ManagedEntityHeader } from '@maxim/contracts/managed-entities';
import {
  BOT_SPEECH_STYLE_METADATA,
  applyBotSpeechStylePreset,
  type BotSpeechStyle,
} from '@maxim/contracts/bot-speech';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import '../styles/settings-drilldown-core.css';
import '../styles/settings-policy-controls.css';
import '../styles/settings-native-controls.css';
import '../styles/settings-home-compact.css';
import '../styles/settings-home-route-polish.css';
import '../styles/broadcast-studio-base.css';
import '../styles/settings-rules-studio.css';
import '../styles/settings-link-allowlist.css';
import '../styles/settings-drilldown-polish.css';
import '../styles/settings-duration-editor.css';
import '../styles/settings-route-polish.css';
import '../styles/settings-interaction-polish.css';
import '../styles/managed-giveaway.css';
import '../styles/broadcast-studio.css';
import './settings-page.css';
import './settings/settings-word-banlist.css';
import './settings/settings-duplicate-stage.css';
import '../styles/broadcast-autopost-polish.css';
import '../styles/settings-tile-grid.css';
import {
  Suspense,
  lazy,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { BroadcastSchedulePlannerSelectionState } from '../components/broadcast-schedule-planner';
import { AdminContactToggle } from '../components/admin-contact-toggle';
import { BroadcastLinkButtonsEditor } from '../components/broadcast-link-buttons-editor';
import { BroadcastPublishBar } from '../components/broadcast-publish-bar';
import {
  BroadcastStudioHeader,
  type BroadcastStudioSignal,
} from '../components/broadcast-studio-header';
import {
  BroadcastHistoryFilterTabs,
  BroadcastWorkspaceChrome,
  countManagedBroadcastHistoryFilters,
  filterManagedBroadcastsByHistoryFilter,
  type BroadcastHistoryFilter,
} from '../components/broadcast-studio-workspace';
import { PublicationWorkspaceHandoff } from '../components/publication-workspace-handoff';
import { CompactStickyHeader } from '../components/ui/compact-sticky-header';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl, type SegmentedOption } from '../components/ui/segmented-control';
import { ResetIcon } from '../components/ui/reset-icon';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../components/ui/settings-section-toggle';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  addDomain,
  applySettingsSectionToAll,
  cancelManagedBroadcast,
  clearBroadcastHandoffState,
  createBroadcastRequestId,
  deleteManagedAutopostRule,
  getBroadcastComposerClientResetState,
  getBroadcastHandoffState,
  getManagedAutopostRule,
  getManagedAutopostRules,
  getManagedBroadcast,
  getManagedBroadcastCalendar,
  getSettingsScreen,
  previewApplySettingsSectionTarget,
  publishRules,
  removeDomain,
  recheckManagedEntityAccess,
  resolveRequiredSubscriptionChannel,
  resetPublishedRules,
  retryManagedBroadcast,
  scheduleDomainRemoval,
  sendBroadcast,
  sendBroadcastTest,
  updateManagedAutopostRule,
  updateManagedBroadcast,
  updateRules,
  updateSettings,
} from '../lib/api/chat-settings-client';
import { getVkParsingCapability } from '../lib/api/vk-parsing-client';
import { buildBroadcastSendFeedback } from '../lib/broadcast-send-feedback';
import { getGlobalSpammerReviewMetrics } from '../lib/api/spammer-review-client';
import { getMe } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import type {
  BroadcastHandoffPayload,
  SendBroadcastPayload,
  UpdateChatRulesPayload,
} from '../lib/api/shared-types';
import {
  buildBroadcastLinkButtonLegacyFields,
  createEmptyBroadcastLinkButton,
  formatBroadcastButtonsPreview,
  formatBroadcastButtonsStatus,
  hasBroadcastLinkButtonErrors,
  trimBroadcastLinkButtons,
  validateBroadcastLinkButtons,
  type BroadcastLinkButtonFieldErrors,
} from '../lib/broadcast-link-buttons';
import {
  buildManagedAutopostRuleFacts,
  normalizeManagedAutopostPayload,
  sortManagedAutopostRules,
} from '../lib/managed-autopost-ui';
import { useKeyboardOpen } from '../lib/use-keyboard-open';
import {
  createDefaultBroadcastCycleDraft,
  findBroadcastSlotConflicts,
  formatBroadcastCycleSummary,
  getBroadcastCycleValidationError,
  hasBroadcastHandoffDraft,
  normalizeBroadcastCycleDraft,
  resolveBroadcastHandoffLoadMode,
  resolveBroadcastHandoffSchedule,
  resolveBroadcastCycleSendAt,
  resolveBroadcastScheduleTimezone,
  sortAndUniqueBroadcastSlots,
  type BroadcastCycleDraft,
  type BroadcastTimingMode,
} from '../lib/broadcast-schedule';
import {
  clearBroadcastComposerDraft,
  hasAppliedBroadcastComposerReset,
  loadBroadcastComposerDraftAsync,
  markBroadcastComposerResetApplied,
  saveBroadcastComposerDraft,
  type BroadcastComposerDraft,
} from '../lib/broadcast-composer-draft';
import { buildChatBroadcastSystemButtons } from '../lib/broadcast-system-buttons';
import { cn } from '../lib/cn';
import {
  normalizeBroadcastAudienceTargetChatIds,
  resolveBroadcastAudienceLastScopedMode,
  resolveBroadcastAudiencePayload,
  restoreBroadcastAudienceModeFromAll,
  type BroadcastScopedTargetMode,
} from '../lib/broadcast-audience';
import {
  buildBroadcastAudiencePresentation,
  buildBroadcastAudiencePreviewBundle,
  toManagedBroadcastTargetPreview,
} from '../lib/broadcast-audience-presentation';
import {
  applyMessageLimitsBlockedDomainsInput,
  applyMessageLimitsBlockedWordsInput,
  findMessageLimitsBlockedDomainCoveringRule,
  splitMessageLimitsBlockedDomainsInput,
  splitMessageLimitsBlockedWordsInput,
} from '../lib/message-limits-blocked-words';
import { resolveAdminContactProfileUrl } from '../lib/admin-contact-profile-url';
import { maxNotify, openMaxBotLink, setMaxClosingConfirmation } from '../lib/max-bridge';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';
import { useManagedEntitiesSync } from '../lib/use-managed-entities-sync';
import {
  MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS,
  MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_INTERVAL_MS,
  buildManagedEntitiesSettledMarker,
  useManagedEntitiesVisibilityRefresh,
} from '../lib/use-managed-entities-visibility-refresh';
import { useVisualViewportOverlayStyle } from '../lib/use-visual-viewport-overlay-style';
import {
  resolveLegacyBroadcastEditorTarget,
  resolveLegacyPublicationReturnPath,
} from '../features/publications/legacy-autoposts';
import { SettingsCommentsSection } from './settings/settings-comments-section';
import { SettingsExtraSection } from './settings/settings-extra-section';
import { SettingsSectionSaveFooter } from './settings/settings-section-save-footer';
import { useBroadcastImageDraft } from './settings/use-broadcast-image-draft';
import {
  BOT_SPEECH_SYNC_SETTING_KEYS,
  COMMENTS_SETTING_KEYS,
  SECTION_SETTING_KEYS,
  type ApplySectionKey,
  applyNightModeBotMessageEnabledChange,
  applyNightModeEnabledChange,
  hasSectionBotSpeechMediaChanges,
  mergeBotSpeechStyleSettings,
  mergeCommentsSettings,
  mergeSectionSettings,
} from './settings-page-state';
import {
  DUPLICATE_DETECTION_LABELS,
  DUPLICATE_DETECTION_OPTIONS,
  type DuplicateDetectionPreset,
  type NumericChatSettingKey,
  type StopWordsMode,
} from './settings-page.constants';
import {
  buildRulesTextFromSettingsScreen,
  serializeRulesDraftPayload,
  shouldHydrateRulesDraftFromServer,
} from './settings-rules-state';
import { createManagedEntityHeader } from '../lib/managed-entity-header';
import { buildRequiredSubscriptionChannelCollections } from './settings-required-subscription-state';
import {
  FieldErrors,
  ManagedBroadcastListItem,
  MailingWorkspaceView,
  PendingBroadcastPublishReview,
  resolveBroadcastImagesFromLegacyFields,
  areBroadcastImagesReady,
  ChatSettingsButtonGroup,
  AdminContactButtonGroup,
  LazyMessageLimitsBlockedWordPresets,
  LazyBroadcastAudienceControls,
  LazyBroadcastSchedulePlanner,
  LazyBroadcastContentComposer,
  LazyBroadcastButtonsSheet,
  LazyBroadcastPublishReviewSheet,
  LazySettingsHandoffState,
  LazyManagedGiveawayCard,
  LazyActionConfirmMarkdownPreview,
  LazyVkParsingCard,
  LazyManagedAutopostRuleCard,
  LazyManagedBroadcastHistoryCard,
  LazySettingsTimeFields,
  LazyRequiredSubscriptionSourcePicker,
  LazyManagedEntityAccessDiagnosticsBanner,
  LazySettingsAdminCommandsSection,
  preloadBotSpeechMessageEditorSheet,
  AUTO_SAVE_DELAY_MS,
  AUTO_MUTE_DURATION_MIN_HOURS,
  AUTO_MUTE_DURATION_MAX_HOURS,
  AUTO_MUTE_DURATION_PRESET_HOURS,
  DUPLICATE_ALLOWED_COUNT_MIN,
  DUPLICATE_ALLOWED_COUNT_MAX,
  MESSAGE_COUNT_LIMIT_MIN,
  MESSAGE_COUNT_LIMIT_MAX,
  MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS,
  MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS,
  MESSAGE_LENGTH_MIN,
  MESSAGE_LENGTH_MAX,
  MESSAGE_LENGTH_STEP,
  PHOTO_COOLDOWN_MIN_HOURS,
  PHOTO_COOLDOWN_MAX_HOURS,
  STICKER_COOLDOWN_MIN_MINUTES,
  STICKER_COOLDOWN_MAX_MINUTES,
  NIGHT_FORCE_CLOSE_MIN_HOURS,
  NIGHT_FORCE_CLOSE_MAX_HOURS,
  NIGHT_FORCE_CLOSE_MIN_DAYS,
  NIGHT_FORCE_CLOSE_MAX_DAYS,
  COMMERCIAL_SENSITIVITY_MIN,
  COMMERCIAL_SENSITIVITY_MAX,
  DOMAIN_REMOVAL_MIN_FUTURE_MS,
  MAX_BROADCAST_TEXT_LENGTH,
  MIN_BROADCAST_CYCLE_HOURS,
  LINK_BOT_BUTTON_GROUP,
  GREETING_BOT_BUTTON_GROUP,
  TEXT_FILTERS_BOT_BUTTON_GROUP,
  DUPLICATE_BOT_BUTTON_GROUP,
  MESSAGE_LIMITS_BOT_BUTTON_GROUP,
  NIGHT_MODE_BOT_BUTTON_GROUP,
  LINK_ADMIN_CONTACT_BUTTON_GROUP,
  PROFANITY_ADMIN_CONTACT_BUTTON_GROUP,
  TEXT_FILTERS_ADMIN_CONTACT_BUTTON_GROUP,
  DUPLICATE_ADMIN_CONTACT_BUTTON_GROUP,
  MESSAGE_LIMITS_ADMIN_CONTACT_BUTTON_GROUP,
  REQUIRED_SUBSCRIPTION_ADMIN_CONTACT_BUTTON_GROUP,
  MAX_CHAT_RULES_TEXT_LENGTH,
  MESSAGE_LIMITS_BLOCKED_WORDS_PREVIEW_COUNT,
  DEFAULT_RULES_POST_BUTTON_TEXT,
  ADMIN_CONTACT_BUTTON_TEXT,
  BROADCAST_HOUR_MS,
  MaxMessageLengthSlider,
  DeleteDelayStepper,
  PublishedRulesButtonToggleSlot,
  AutoMuteDurationKey,
  AutoMuteEnabledKey,
  HintKey,
  BotSpeechMediaFieldKey,
  BotSpeechMediaImage,
  BotMessageEditorKey,
  WarnMessageEditorKey,
  SettingsSectionKey,
  INITIAL_EXPANDED_SECTIONS,
  SECTION_LABELS,
  createDefaultApplySettingsTarget,
  resolveDuplicateSharedWindowSec,
  resolveDuplicateAllowedCount,
  buildDuplicateFlowSettings,
  normalizeDuplicateFlowSettings,
  formatDuplicateAllowanceLabel,
  LINK_POLICY_OPTIONS,
  RUSSIAN_TIMEZONE_OPTIONS,
  resolveBotSpeechPreviewContext,
  buildSpeechStylePreviewSamples,
  formatApiError,
  minutesToTimeInput,
  toLocalDateInputValue,
  toLocalTimeInputValue,
  parseIsoToLocalDateTime,
  formatRemovalDateTime,
  formatAllowlistModeLabel,
  formatAllowlistMetaLabel,
  ALLOWLIST_MATCH_OPTIONS,
  formatCompactBroadcastDateTime,
  formatRussianCountLabel,
  formatBroadcastPayloadScheduleLabel,
  resolveBroadcastCountdown,
  resolveManagedBroadcastCardTone,
  resolveManagedBroadcastCardBadge,
  resolveManagedBroadcastCardTitle,
  resolveManagedBroadcastMetric,
  buildManagedBroadcastFactChips,
  formatNightForceCloseDuration,
  resolveCommercialSensitivityConfig,
  getCommercialSensitivityLabel,
  inferCommercialSensitivitySliderValue,
  normalizeLegacyChatCommentScope,
  formatRequiredSubscriptionCount,
  formatRequiredSubscriptionEntityLabel,
  formatRequiredSubscriptionLinkPreview,
  getRouteChatTitle,
  getRouteChatAvatarUrl,
  resolveDesktopToggleRowLabel,
  CalendarIcon,
  ClockIcon,
  TrashIcon,
  EditToggleButton,
  SettingsHintAnchor,
  LazyBotMessageEditor,
  EMPTY_BROADCAST_PLANNER_STATE,
  areBroadcastPlannerStatesEqual,
  LazyWarnMessageEditor,
} from './settings/settings-page-helpers';

const LazyActionConfirmSheet = lazy(() =>
  import('../components/ui/action-confirm-sheet').then((module) => ({
    default: module.ActionConfirmSheet,
  })),
);
let settingsApplyTargetSheetPromise: Promise<{
  default: typeof import('./settings/settings-apply-target-sheet').SettingsApplyTargetSheet;
}> | null = null;
function preloadSettingsApplyTargetSheet() {
  settingsApplyTargetSheetPromise ??= import('./settings/settings-apply-target-sheet').then(
    (module) => ({ default: module.SettingsApplyTargetSheet }),
  );
  return settingsApplyTargetSheetPromise;
}
const LazySettingsApplyTargetSheet = lazy(preloadSettingsApplyTargetSheet);
const LazySettingsOverviewSearch = lazy(() =>
  import('../components/ui/settings-overview-search').then((module) => ({
    default: module.SettingsOverviewSearch,
  })),
);
const LazySettingsSpeechStylePanel = lazy(
  () => import('./settings/settings-speech-style-panel'),
);

export function SettingsPage({ api }: { api: ApiTransport }) {
  const { chatId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { isCompact: isHeaderCompact } = useAutoHideHeader();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [draft, setDraft] = useState<ChatSettings | null>(null);
  const [rulesDraft, setRulesDraft] = useState<ChatRules | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [rulesTextError, setRulesTextError] = useState('');
  const [rulesImageError, setRulesImageError] = useState('');
  const [rulesButtonErrors, setRulesButtonErrors] = useState<BroadcastLinkButtonFieldErrors[]>([]);
  const [rulesButtonFieldsTouched, setRulesButtonFieldsTouched] = useState(false);
  const [rulesButtonsSheetOpen, setRulesButtonsSheetOpen] = useState(false);
  const [rulesButtonRevealSignal, setRulesButtonRevealSignal] = useState(0);
  const [domainInput, setDomainInput] = useState('');
  const [domainInputMode, setDomainInputMode] = useState<AllowlistMatchType>('DOMAIN');
  const [domainInputError, setDomainInputError] = useState('');
  const [stopWordsMode, setStopWordsMode] = useState<StopWordsMode>('words');
  const [messageLimitsBlockedWordsInput, setMessageLimitsBlockedWordsInput] = useState('');
  const [messageLimitsBlockedDomainsInput, setMessageLimitsBlockedDomainsInput] = useState('');
  const [messageLimitsBlockedWordsExpanded, setMessageLimitsBlockedWordsExpanded] = useState(false);
  const [messageLimitsBlockedDomainsExpanded, setMessageLimitsBlockedDomainsExpanded] =
    useState(false);
  const [scheduleDomain, setScheduleDomain] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [mailingText, setMailingText] = useState('');
  const [mailingTargetMode, setMailingTargetMode] = useState<BroadcastTargetMode>('current');
  const [mailingTargetChatIds, setMailingTargetChatIds] = useState<string[]>([]);
  const [mailingLastScopedTargetMode, setMailingLastScopedTargetMode] =
    useState<BroadcastScopedTargetMode>('current');
  const [mailingAudienceError, setMailingAudienceError] = useState('');
  const [mailingButtons, setMailingButtons] = useState<BroadcastLinkButton[]>([]);
  const [mailingButtonsSheetOpen, setMailingButtonsSheetOpen] = useState(false);
  const [mailingButtonRevealSignal, setMailingButtonRevealSignal] = useState(0);
  const {
    mailingImageEnabled,
    mailingImageBase64,
    mailingImageMimeType,
    mailingImageFileName,
    mailingImages,
    mailingImagesPreparing,
    applyMailingImages,
    resetMailingImages,
    setMailingImagesPreparing,
  } = useBroadcastImageDraft();
  const [mailingVideoCleared, setMailingVideoCleared] = useState(false);
  const [mailingScheduledSlots, setMailingScheduledSlots] = useState<string[]>([]);
  const [mailingTimingMode, setMailingTimingMode] = useState<BroadcastTimingMode>('now');
  const [mailingCycleDraft, setMailingCycleDraft] = useState<BroadcastCycleDraft>(() =>
    createDefaultBroadcastCycleDraft(),
  );
  const [mailingScheduleTimezone, setMailingScheduleTimezone] = useState(() =>
    resolveBroadcastScheduleTimezone(),
  );
  const [, setMailingScheduleEnabled] = useState(false);
  const [, setMailingScheduleDays] = useState(0);
  const [, setMailingScheduleTime] = useState(() =>
    toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)),
  );
  const [, setMailingCycleEnabled] = useState(false);
  const [, setMailingCycleEveryHours] = useState(MIN_BROADCAST_CYCLE_HOURS);
  const [, setMailingCycleCount] = useState(2);
  const [mailingTextError, setMailingTextError] = useState('');
  const [mailingButtonErrors, setMailingButtonErrors] = useState<BroadcastLinkButtonFieldErrors[]>(
    [],
  );
  const [mailingImageError, setMailingImageError] = useState('');
  const [mailingScheduleError, setMailingScheduleError] = useState('');
  const [mailingCycleError, setMailingCycleError] = useState('');
  const [requiredSubscriptionExternalChannelValue, setRequiredSubscriptionExternalChannelValue] =
    useState('');
  const [requiredSubscriptionExternalChannelError, setRequiredSubscriptionExternalChannelError] =
    useState('');
  useEffect(() => {
    const { body } = document;
    body.classList.add('settings-home-page-open');

    return () => {
      body.classList.remove('settings-home-page-open');
    };
  }, []);

  const [resolvedRequiredSubscriptionChannels, setResolvedRequiredSubscriptionChannels] = useState<
    ManagedEntityHeader[]
  >([]);
  const [mailingPlannerResetKey, setMailingPlannerResetKey] = useState(0);
  const [mailingPlannerState, setMailingPlannerState] =
    useState<BroadcastSchedulePlannerSelectionState>(EMPTY_BROADCAST_PLANNER_STATE);
  const [editingManagedBroadcast, setEditingManagedBroadcast] =
    useState<ManagedBroadcastDetails | null>(null);
  const [editingManagedAutopostRule, setEditingManagedAutopostRule] =
    useState<ManagedAutopostRuleDetails | null>(null);
  const [managedBroadcastDeleteTarget, setManagedBroadcastDeleteTarget] =
    useState<ManagedBroadcastListItem | null>(null);
  const [managedAutopostRuleDeleteTarget, setManagedAutopostRuleDeleteTarget] =
    useState<ManagedAutopostRuleSummary | null>(null);
  const [pendingMailingSlotConflict, setPendingMailingSlotConflict] = useState<{
    broadcastId: string | null;
    payload: SendBroadcastPayload;
  } | null>(null);
  const [pendingMailingPublishReview, setPendingMailingPublishReview] =
    useState<PendingBroadcastPublishReview | null>(null);
  const [applyTargetSheet, setApplyTargetSheet] = useState<{
    section: ApplySectionKey;
    sourceSettings: ChatSettings;
    target: ApplySettingsTarget;
  } | null>(null);
  const [applyTargetPreview, setApplyTargetPreview] = useState<Awaited<
    ReturnType<typeof previewApplySettingsSectionTarget>
  > | null>(null);
  const [applyTargetPreviewLoading, setApplyTargetPreviewLoading] = useState(false);
  const [applyTargetPreviewError, setApplyTargetPreviewError] = useState<string | null>(null);
  const applyTargetOverlayStyle = useVisualViewportOverlayStyle(Boolean(applyTargetSheet));

  useEffect(() => {
    if (!applyTargetSheet) {
      return undefined;
    }

    const { body, documentElement } = document;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;

    body.classList.add('settings-apply-target-open');
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';

    return () => {
      body.classList.remove('settings-apply-target-open');
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
    };
  }, [applyTargetSheet]);

  const [chatsListRefreshRequest, setChatsListRefreshRequest] = useState<{
    nonce: number;
    behavior: 'default' | 'manual' | 'recovery';
  }>({
    nonce: 0,
    behavior: 'default',
  });
  const [mailingNowMs, setMailingNowMs] = useState(() => Date.now());
  const [mailingWorkspaceView, setMailingWorkspaceView] = useState<MailingWorkspaceView>('compose');
  const [mailingHistoryFilter, setMailingHistoryFilter] =
    useState<BroadcastHistoryFilter>('future');
  const [duplicateWindowInputValue, setDuplicateWindowInputValue] = useState('');
  const [rulesFailedSnapshot, setRulesFailedSnapshot] = useState('');
  const rulesDraftRef = useRef<ChatRules | null>(null);
  const previousRulesServerSnapshotRef = useRef('');
  const [openHintKey, setOpenHintKey] = useState<HintKey | null>(null);
  const [openMuteDurationKey, setOpenMuteDurationKey] = useState<AutoMuteDurationKey | null>(null);
  const [openBotEditorKey, setOpenBotEditorKey] = useState<BotMessageEditorKey | null>(null);
  const [openWarnEditorKey, setOpenWarnEditorKey] = useState<WarnMessageEditorKey | null>(null);
  const [speechStylePanelOpen, setSpeechStylePanelOpen] = useState(false);
  const [pendingSpeechStyle, setPendingSpeechStyle] = useState<BotSpeechStyle | null>(null);
  const [expandedSections, setExpandedSections] =
    useState<Record<SettingsSectionKey, boolean>>(INITIAL_EXPANDED_SECTIONS);
  const [
    requiredSubscriptionChannelsRefreshRequest,
    setRequiredSubscriptionChannelsRefreshRequest,
  ] = useState<{
    nonce: number;
    behavior: 'default' | 'manual' | 'recovery';
  }>({
    nonce: 0,
    behavior: 'default',
  });
  const isLinksKeyboardOpen = useKeyboardOpen(120, expandedSections.links);
  const appliedBroadcastHandoffSignatureRef = useRef<string | null>(null);
  const appliedLegacyEditorTargetRef = useRef<string | null>(null);
  const broadcastDraftRestoreEpochRef = useRef(0);
  const [broadcastDraftRestoreReady, setBroadcastDraftRestoreReady] = useState(false);

  const routeChatTitle = getRouteChatTitle(location.state);
  const routeChatAvatarUrl = getRouteChatAvatarUrl(location.state);
  const searchParams = new URLSearchParams(location.search);
  const focusSection = searchParams.get('focus');
  const handoffRequested = searchParams.get('handoff') === '1';
  const legacyEditorTarget = resolveLegacyBroadcastEditorTarget(location.search);
  const broadcastComposerClientResetQuery = useQuery({
    queryKey: ['broadcast-composer-client-reset', chatId],
    queryFn: ({ signal }) => getBroadcastComposerClientResetState(api, chatId ?? '', { signal }),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (
      focusSection !== 'links' &&
      focusSection !== 'rules' &&
      focusSection !== 'comments' &&
      focusSection !== 'stopWords' &&
      focusSection !== 'giveaway' &&
      focusSection !== 'vkParsing' &&
      focusSection !== 'broadcast' &&
      focusSection !== 'requiredSubscription'
    ) {
      return;
    }

    setExpandedSections({
      ...INITIAL_EXPANDED_SECTIONS,
      ...(focusSection === 'links'
        ? { links: true }
        : focusSection === 'rules'
          ? { rules: true }
          : focusSection === 'comments'
            ? { comments: true }
            : focusSection === 'stopWords'
              ? { stopWords: true }
              : focusSection === 'giveaway'
                ? { giveaway: true }
                : focusSection === 'vkParsing'
                  ? { vkParsing: true }
                  : focusSection === 'requiredSubscription'
                    ? { requiredSubscription: true }
                    : { mailing: true }),
    });
  }, [focusSection]);

  useEffect(() => {
    if (chatId) {
      saveLastEntityId('chat', chatId);
    }
  }, [chatId]);

  useEffect(() => {
    setApplyTargetSheet(null);
    setApplyTargetPreview(null);
    setApplyTargetPreviewError(null);
    setApplyTargetPreviewLoading(false);
    setRulesDraft(null);
    setRulesTextError('');
    setRulesImageError('');
    setRulesButtonErrors([]);
    setRulesButtonFieldsTouched(false);
    setRulesButtonsSheetOpen(false);
    setRulesButtonRevealSignal(0);
    setRulesFailedSnapshot('');
    previousRulesServerSnapshotRef.current = '';
    setMailingTargetMode('current');
    setMailingTargetChatIds(chatId ? [chatId] : []);
    setMailingLastScopedTargetMode('current');
    setMailingAudienceError('');
    setMailingText('');
    setMailingButtons([]);
    setMailingButtonsSheetOpen(false);
    applyMailingImages([]);
    setMailingVideoCleared(false);
    setMailingTimingMode('now');
    setMailingCycleDraft(createDefaultBroadcastCycleDraft());
    setMailingScheduledSlots([]);
    setMailingScheduleTimezone(resolveBroadcastScheduleTimezone());
    setMailingScheduleEnabled(false);
    setMailingScheduleDays(0);
    setMailingScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setMailingCycleEnabled(false);
    setMailingCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setMailingCycleCount(2);
    setMailingTextError('');
    setMailingButtonErrors([]);
    setMailingImageError('');
    setMailingScheduleError('');
    setMailingCycleError('');
    setRequiredSubscriptionExternalChannelValue('');
    setRequiredSubscriptionExternalChannelError('');
    setResolvedRequiredSubscriptionChannels([]);
    resetMailingPlanner();
    setEditingManagedBroadcast(null);
    setEditingManagedAutopostRule(null);
    setMailingWorkspaceView('compose');
    const restoreEpoch = ++broadcastDraftRestoreEpochRef.current;
    setBroadcastDraftRestoreReady(false);
    setDuplicateWindowInputValue('');
    setPendingSpeechStyle(null);
    setRequiredSubscriptionChannelsRefreshRequest({
      nonce: 0,
      behavior: 'default',
    });

    if (!chatId || !broadcastComposerClientResetQuery.isSuccess) {
      return;
    }

    const resetAt = broadcastComposerClientResetQuery.data?.resetAt;
    const shouldApplyReset =
      Boolean(resetAt) && !hasAppliedBroadcastComposerReset('chat', chatId, resetAt);
    let cancelled = false;
    const markRestoreReady = () => {
      if (cancelled || restoreEpoch !== broadcastDraftRestoreEpochRef.current) {
        return;
      }

      setBroadcastDraftRestoreReady(true);
    };

    if (shouldApplyReset && resetAt) {
      void (async () => {
        await clearBroadcastComposerDraft('chat', chatId);
        if (cancelled || restoreEpoch !== broadcastDraftRestoreEpochRef.current) {
          return;
        }

        markBroadcastComposerResetApplied('chat', chatId, resetAt);
        appliedBroadcastHandoffSignatureRef.current = null;
        resetMailingComposer();
        void queryClient.invalidateQueries({ queryKey: ['broadcast-handoff-state', chatId] });
        markRestoreReady();
      })();

      return () => {
        cancelled = true;
      };
    }

    const applySavedBroadcastDraft = (savedBroadcastDraft: BroadcastComposerDraft) => {
      if (cancelled || restoreEpoch !== broadcastDraftRestoreEpochRef.current) {
        return;
      }

      setMailingTargetMode(savedBroadcastDraft.targetMode);
      setMailingTargetChatIds(
        savedBroadcastDraft.targetChatIds.length > 0
          ? savedBroadcastDraft.targetChatIds
          : chatId
            ? [chatId]
            : [],
      );
      setMailingLastScopedTargetMode(savedBroadcastDraft.lastScopedTargetMode);
      setMailingText(savedBroadcastDraft.text);
      setMailingButtons(savedBroadcastDraft.buttons);
      setMailingTimingMode(savedBroadcastDraft.timingMode);
      setMailingCycleDraft(normalizeBroadcastCycleDraft(savedBroadcastDraft.cycle));
      setMailingScheduledSlots(sortAndUniqueBroadcastSlots(savedBroadcastDraft.scheduledSlots));
      setMailingScheduleTimezone(
        savedBroadcastDraft.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      );
    };

    void loadBroadcastComposerDraftAsync('chat', chatId).then((draft) => {
      if (draft) {
        applySavedBroadcastDraft(draft);
      }
      markRestoreReady();
    });

    return () => {
      cancelled = true;
    };
  }, [
    broadcastComposerClientResetQuery.data?.resetAt,
    broadcastComposerClientResetQuery.isSuccess,
    chatId,
    queryClient,
  ]);

  const settingsScreenQuery = useQuery({
    queryKey: ['settings-screen', chatId],
    queryFn: ({ signal }) =>
      getSettingsScreen(api, chatId ?? '', { signal, prefetch: handoffRequested }),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
    ...(handoffRequested
      ? {
          retry: 7,
          retryDelay: (failureCount: number) => Math.min(800 + failureCount * 400, 2600),
        }
      : {}),
  });
  const broadcastHandoffStateQuery = useQuery({
    queryKey: ['broadcast-handoff-state', chatId],
    queryFn: () => getBroadcastHandoffState(api, chatId ?? ''),
    enabled:
      Boolean(chatId) &&
      !editingManagedBroadcast &&
      focusSection === 'broadcast' &&
      handoffRequested,
    refetchOnWindowFocus: false,
  });
  const settingsHandoffMode = resolveBroadcastHandoffLoadMode({
    requested: Boolean(chatId) && focusSection === 'broadcast' && handoffRequested,
    queries: [settingsScreenQuery, broadcastHandoffStateQuery],
  });
  const hasLegacyBroadcastHandoff =
    handoffRequested &&
    Boolean(
      broadcastHandoffStateQuery.data &&
      hasBroadcastHandoffDraft(broadcastHandoffStateQuery.data, { includeTargets: true }),
    );
  const legacyBroadcastWorkspaceRequested =
    focusSection === 'broadcast' &&
    (hasLegacyBroadcastHandoff ||
      searchParams.get('workspace') === 'autoposts' ||
      legacyEditorTarget !== null);
  const sendBroadcastHandoffMutation = useMutation({
    mutationFn: (payload: SendBroadcastPayload) => sendBroadcast(api, chatId ?? '', payload),
    onSuccess: async (result) => {
      const feedback = buildBroadcastSendFeedback(result);
      if (feedback.clearDraft) {
        resetMailingComposer();
      }
      let cleanupFailed = false;
      if (chatId) {
        const handoffQueryKey = ['broadcast-handoff-state', chatId] as const;
        if (feedback.clearDraft) {
          try {
            await clearBroadcastHandoffState(api, chatId);
            await queryClient.invalidateQueries({ queryKey: handoffQueryKey });
          } catch {
            cleanupFailed = true;
            queryClient.setQueryData(handoffQueryKey, null);
          }
        }
        void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
        void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['publications', 'legacy'] });
      pushToast({
        tone: cleanupFailed && feedback.tone === 'success' ? 'info' : feedback.tone,
        title: feedback.title,
        description:
          [
            feedback.description ?? '',
            cleanupFailed ? 'Черновик не удалось очистить. Не запускайте его повторно.' : '',
          ]
            .filter(Boolean)
            .join(' ') || undefined,
      });
      maxNotify(cleanupFailed ? 'warning' : feedback.notification);
    },
    onError: (error) => {
      const description = reportMailingAudienceApiError(error);
      pushToast({
        tone: 'danger',
        title: 'Не удалось запустить публикацию',
        description,
      });
      maxNotify('error');
    },
  });
  const meQuery = useQuery({
    queryKey: ['me', chatId ?? null],
    queryFn: ({ signal }) =>
      getMe(api, { chatId: chatId ?? undefined, entityType: 'chat', signal }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const vkParsingCapabilityQuery = useQuery({
    queryKey: ['vk-parsing-capability', 'chat', chatId],
    queryFn: () => getVkParsingCapability(api, 'chat', chatId ?? ''),
    enabled: Boolean(chatId),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const spammerReviewMetricsQuery = useQuery({
    queryKey: ['global-spammer-review-metrics', chatId, 'summary'],
    queryFn: ({ signal }) =>
      getGlobalSpammerReviewMetrics(api, chatId ?? '', { mode: 'summary' }, { signal }),
    enabled: Boolean(chatId) && Boolean(settingsScreenQuery.data),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const vkParsingCapability = vkParsingCapabilityQuery.data ?? null;
  const canAccessVkParsing = vkParsingCapability?.canUse === true;
  const shouldShowVkParsingSection =
    canAccessVkParsing || vkParsingCapability?.reasonCode === 'NOT_CONFIGURED';
  const adminContactProfileUrl = useMemo(
    () => resolveAdminContactProfileUrl(meQuery.data ?? {}),
    [meQuery.data],
  );

  const shouldLoadRequiredSubscriptionChannels =
    Boolean(chatId) &&
    (expandedSections.requiredSubscription || focusSection === 'requiredSubscription');
  const chatsList = useManagedEntitiesSync({
    api,
    entityType: 'chat',
    reloadNonce: chatsListRefreshRequest.nonce,
    reloadBehavior: chatsListRefreshRequest.behavior,
    backgroundRefreshOnFirstLoad: true,
    persistLocalCache: true,
    localCacheScope: 'home',
  });
  const channelsList = useManagedEntitiesSync({
    api,
    entityType: 'channel',
    enabled: shouldLoadRequiredSubscriptionChannels,
    reloadNonce: requiredSubscriptionChannelsRefreshRequest.nonce,
    reloadBehavior: requiredSubscriptionChannelsRefreshRequest.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    persistLocalCache: true,
    localCacheScope: 'home',
  });
  const requiredSubscriptionEntitiesLoading =
    shouldLoadRequiredSubscriptionChannels && (channelsList.isLoading || chatsList.isLoading);
  const requiredSubscriptionEntitiesSyncing =
    shouldLoadRequiredSubscriptionChannels && (channelsList.isRefreshing || chatsList.isRefreshing);
  const requiredSubscriptionEntitiesError = channelsList.error ?? chatsList.error;
  const requiredSubscriptionEntitiesBackoffActive =
    channelsList.isBackoffActive || chatsList.isBackoffActive;
  const settledChatsListMarker = useMemo(
    () =>
      buildManagedEntitiesSettledMarker({
        hasLoadedFromServer: chatsList.hasLoadedFromServer,
        isSyncComplete: chatsList.isSyncComplete,
        isBackoffActive: chatsList.isBackoffActive,
        snapshotVersion: chatsList.snapshot?.version,
        snapshotBuiltAt: chatsList.snapshot?.builtAt,
        lastSyncedAt: chatsList.refreshState?.lastSyncedAt,
      }),
    [
      chatsList.hasLoadedFromServer,
      chatsList.isBackoffActive,
      chatsList.isSyncComplete,
      chatsList.refreshState?.lastSyncedAt,
      chatsList.snapshot?.builtAt,
      chatsList.snapshot?.version,
    ],
  );
  useManagedEntitiesVisibilityRefresh({
    enabled: true,
    hasLoadedFromServer: chatsList.hasLoadedFromServer,
    isLoading: chatsList.isLoading,
    isRefreshing: chatsList.isRefreshing,
    isSyncComplete: chatsList.isSyncComplete,
    snapshotStale: chatsList.snapshot?.stale ?? null,
    settledMarker: settledChatsListMarker,
    minIntervalMs: MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_INTERVAL_MS,
    minHiddenDurationMs: MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS,
    onVisibilityReturnRefresh: () => {
      startTransition(() => {
        setChatsListRefreshRequest((current) => ({
          nonce: current.nonce + 1,
          behavior: 'recovery',
        }));
      });
    },
  });
  const settingsQuery = {
    data: settingsScreenQuery.data?.settings,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
    refetch: settingsScreenQuery.refetch,
  };
  const rulesQuery = {
    data: settingsScreenQuery.data?.rules,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
  };

  useEffect(() => {
    rulesDraftRef.current = rulesDraft;
  }, [rulesDraft]);

  useEffect(() => {
    preloadBotSpeechMessageEditorSheet();
  }, []);

  const managedBroadcastsQuery = {
    data: settingsScreenQuery.data?.managedBroadcasts,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
  };
  const chatHeaderQuery = {
    data: settingsScreenQuery.data?.header,
  };
  const botSpeechPreviewContext = useMemo(
    () => resolveBotSpeechPreviewContext(settingsScreenQuery.data?.botSpeechPreviewProfile),
    [settingsScreenQuery.data?.botSpeechPreviewProfile],
  );
  const domainsQuery = {
    data: settingsScreenQuery.data?.domains,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
  };
  const resolvedRequiredSubscriptionChannelCandidates = useMemo(() => {
    const channelById = new Map<string, ManagedEntityHeader>();
    for (const channel of settingsScreenQuery.data?.requiredSubscriptionChannels ?? []) {
      channelById.set(channel.id, channel);
    }
    for (const channel of resolvedRequiredSubscriptionChannels) {
      channelById.set(channel.id, channel);
    }
    return [...channelById.values()];
  }, [
    resolvedRequiredSubscriptionChannels,
    settingsScreenQuery.data?.requiredSubscriptionChannels,
  ]);
  const requiredSubscriptionChannelCollections = useMemo(
    () =>
      buildRequiredSubscriptionChannelCollections({
        managedChats: chatsList.data,
        managedChannels: channelsList.data,
        resolvedChannels: resolvedRequiredSubscriptionChannelCandidates,
        selectedChannelIds: draft?.requiredSubscriptionChannelIds ?? [],
      }),
    [
      chatsList.data,
      channelsList.data,
      draft?.requiredSubscriptionChannelIds,
      resolvedRequiredSubscriptionChannelCandidates,
    ],
  );
  const selectedRequiredSubscriptionChannels =
    requiredSubscriptionChannelCollections.selectedChannels;
  const selectedRequiredSubscriptionChannelHeaders =
    requiredSubscriptionChannelCollections.selectedHeaders;
  const selectedUnavailableRequiredSubscriptionChannels =
    requiredSubscriptionChannelCollections.selectedUnavailableChannels;
  const unavailableManagedRequiredSubscriptionChannels =
    requiredSubscriptionChannelCollections.unavailableManagedChannels;
  const availableRequiredSubscriptionChannelChoices =
    requiredSubscriptionChannelCollections.availableChoices;
  const currentRulesTextSource = useMemo(() => {
    const currentSettings = draft ?? settingsScreenQuery.data?.settings;
    if (!currentSettings) {
      return null;
    }

    const channelById = new Map<string, ManagedEntityHeader>();
    for (const channel of settingsScreenQuery.data?.requiredSubscriptionChannels ?? []) {
      channelById.set(channel.id, channel);
    }
    for (const channel of selectedRequiredSubscriptionChannelHeaders) {
      channelById.set(channel.id, channel);
    }
    for (const channel of selectedUnavailableRequiredSubscriptionChannels) {
      channelById.set(
        channel.id,
        createManagedEntityHeader({
          id: channel.id,
          title: channel.title,
          entityType: 'channel',
          link: null,
          participantsCount: null,
        }),
      );
    }

    return {
      settings: currentSettings,
      domains: domainsQuery.data ?? settingsScreenQuery.data?.domains ?? [],
      requiredSubscriptionChannels: currentSettings.requiredSubscriptionChannelIds
        .map((channelId) => channelById.get(channelId))
        .filter((channel): channel is ManagedEntityHeader => Boolean(channel)),
    };
  }, [
    domainsQuery.data,
    draft,
    selectedRequiredSubscriptionChannelHeaders,
    selectedUnavailableRequiredSubscriptionChannels,
    settingsScreenQuery.data?.domains,
    settingsScreenQuery.data?.requiredSubscriptionChannels,
    settingsScreenQuery.data?.settings,
  ]);

  const chatTitle = useMemo(() => {
    if (!chatId) {
      return '';
    }

    const fromHeader = chatHeaderQuery.data?.title?.trim();
    if (fromHeader) {
      return fromHeader;
    }

    if (routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(chatId);
  }, [chatHeaderQuery.data?.title, chatId, routeChatTitle]);

  useEffect(() => {
    if (!chatId || !chatTitle) {
      return;
    }

    saveChatTitle(chatId, chatTitle);
  }, [chatId, chatTitle]);

  useEffect(() => {
    if (!chatTitle || routeChatTitle === chatTitle) {
      return;
    }

    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: {
        chatTitle,
        avatarUrl: chatHeaderQuery.data?.avatarUrl ?? routeChatAvatarUrl ?? null,
      },
    });
  }, [
    chatHeaderQuery.data?.avatarUrl,
    chatTitle,
    location.pathname,
    location.search,
    navigate,
    routeChatAvatarUrl,
    routeChatTitle,
  ]);

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    setDraft(
      normalizeDuplicateFlowSettings(
        normalizeLegacyChatCommentScope(
          normalizeRequiredSubscriptionDraftSettings(settingsQuery.data),
        ),
      ),
    );
    setFieldErrors({});
    setDuplicateWindowInputValue('');
  }, [settingsQuery.data]);

  useEffect(() => {
    setResolvedRequiredSubscriptionChannels(
      settingsScreenQuery.data?.requiredSubscriptionChannels ?? [],
    );
  }, [settingsScreenQuery.data?.requiredSubscriptionChannels]);

  useEffect(() => {
    if (!broadcastHandoffStateQuery.data || !handoffRequested) {
      return;
    }

    if (!hasBroadcastHandoffDraft(broadcastHandoffStateQuery.data, { includeTargets: true })) {
      appliedBroadcastHandoffSignatureRef.current = null;
      return;
    }

    const signature = JSON.stringify(broadcastHandoffStateQuery.data);
    if (appliedBroadcastHandoffSignatureRef.current === signature) {
      return;
    }

    appliedBroadcastHandoffSignatureRef.current = signature;
    broadcastDraftRestoreEpochRef.current += 1;
    setEditingManagedBroadcast(null);
    setEditingManagedAutopostRule(null);
    const handoffTargetChatIds = normalizeBroadcastAudienceTargetChatIds(
      broadcastHandoffStateQuery.data.targetChatIds,
    );
    setMailingTargetMode(broadcastHandoffStateQuery.data.targetMode);
    setMailingTargetChatIds(
      broadcastHandoffStateQuery.data.targetMode === 'selected' && handoffTargetChatIds.length === 0
        ? chatId
          ? [chatId]
          : []
        : handoffTargetChatIds,
    );
    setMailingLastScopedTargetMode(
      resolveBroadcastAudienceLastScopedMode({
        targetMode: broadcastHandoffStateQuery.data.targetMode,
        targetChatIds: handoffTargetChatIds,
        currentChatId: chatId ?? undefined,
      }),
    );
    setMailingAudienceError('');
    setMailingButtons(broadcastHandoffStateQuery.data.buttons);
    const handoffSchedule = resolveBroadcastHandoffSchedule(broadcastHandoffStateQuery.data);
    setMailingTimingMode(handoffSchedule.timingMode);
    setMailingCycleDraft(handoffSchedule.cycle);
    setMailingScheduledSlots(handoffSchedule.scheduledSlots);
    setMailingScheduleTimezone(
      broadcastHandoffStateQuery.data.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
    );
    setMailingButtonErrors([]);
    setMailingScheduleError('');
    setMailingCycleError('');
    resetMailingPlanner();
    setExpandedSections((current) => ({ ...current, mailing: true }));
    setMailingWorkspaceView('compose');
  }, [broadcastHandoffStateQuery.data, chatId, handoffRequested]);

  useEffect(() => {
    if (
      !chatId ||
      editingManagedBroadcast ||
      editingManagedAutopostRule ||
      !broadcastDraftRestoreReady
    ) {
      return;
    }

    const draftToPersist: BroadcastComposerDraft = {
      text: mailingText,
      targetMode: mailingTargetMode,
      targetChatIds: mailingTargetChatIds,
      lastScopedTargetMode: mailingLastScopedTargetMode,
      buttons: mailingButtons,
      imageEnabled: mailingImageEnabled,
      imageBase64: mailingImageBase64,
      imageMimeType: mailingImageMimeType,
      imageFileName: mailingImageFileName,
      images: mailingImages,
      timingMode: mailingTimingMode,
      scheduledSlots: mailingScheduledSlots,
      scheduleTimezone: mailingScheduleTimezone,
      cycle: mailingCycleDraft,
    };

    saveBroadcastComposerDraft('chat', chatId, draftToPersist);
  }, [
    broadcastDraftRestoreReady,
    chatId,
    editingManagedBroadcast,
    editingManagedAutopostRule,
    mailingButtons,
    mailingCycleDraft,
    mailingImageBase64,
    mailingImageEnabled,
    mailingImageFileName,
    mailingImageMimeType,
    mailingImages,
    mailingLastScopedTargetMode,
    mailingScheduleTimezone,
    mailingScheduledSlots,
    mailingTargetChatIds,
    mailingTargetMode,
    mailingText,
    mailingTimingMode,
  ]);

  useEffect(() => {
    if (!rulesQuery.data) {
      return;
    }

    const nextServerDraft = chatRulesSchema.parse(rulesQuery.data);
    const shouldHydrate = shouldHydrateRulesDraftFromServer({
      currentDraft: rulesDraftRef.current,
      previousServerSnapshot: previousRulesServerSnapshotRef.current,
      nextServerDraft,
    });
    previousRulesServerSnapshotRef.current = serializeRulesDraftPayload(nextServerDraft);
    if (!shouldHydrate) {
      return;
    }

    setRulesDraft(nextServerDraft);
    setRulesTextError('');
    setRulesImageError('');
    setRulesButtonErrors([]);
    setRulesButtonFieldsTouched(false);
    setRulesButtonRevealSignal(0);
  }, [rulesQuery.data]);

  useEffect(() => {
    if (!scheduleDomain) {
      return;
    }

    const exists = (domainsQuery.data ?? []).some(
      (item) => item.normalizedValue === scheduleDomain,
    );
    if (!exists) {
      setScheduleDomain(null);
      setScheduleError('');
    }
  }, [domainsQuery.data, scheduleDomain]);

  const draftSnapshot = useMemo(() => (draft ? JSON.stringify(draft) : ''), [draft]);
  const rulesDraftSnapshot = useMemo(
    () => (rulesDraft ? serializeRulesDraftPayload(rulesDraft) : ''),
    [rulesDraft],
  );

  const serverSnapshot = useMemo(
    () =>
      settingsQuery.data
        ? JSON.stringify(
            normalizeLegacyChatCommentScope(
              normalizeRequiredSubscriptionDraftSettings(settingsQuery.data),
            ),
          )
        : '',
    [settingsQuery.data],
  );
  const rulesServerSnapshot = useMemo(
    () => (rulesQuery.data ? serializeRulesDraftPayload(rulesQuery.data) : ''),
    [rulesQuery.data],
  );

  const hasChanges = Boolean(draft && settingsQuery.data && draftSnapshot !== serverSnapshot);
  const hasRulesChanges = Boolean(
    rulesDraft && rulesQuery.data && rulesDraftSnapshot !== rulesServerSnapshot,
  );
  const rulesPublishedMessageId =
    rulesDraft?.publishedMessageId ?? rulesQuery.data?.publishedMessageId ?? null;
  const rulesPublishedUrl = rulesDraft?.publishedUrl ?? rulesQuery.data?.publishedUrl ?? null;
  const hasPublishedRules = Boolean(rulesPublishedMessageId || rulesPublishedUrl);
  const saveSectionMutation = useMutation({
    mutationFn: ({ payload }: { section: ApplySectionKey; payload: ChatSettings }) =>
      updateSettings(api, chatId ?? '', payload),
    onSuccess: (saved, variables) => {
      syncSavedSectionSettings(variables.section, saved);
      pushToast({
        tone: 'success',
        title: `Блок «${SECTION_LABELS[variables.section]}» сохранен`,
      });
      maxNotify('success');
    },
    onError: (error, variables) => {
      pushToast({
        tone: 'danger',
        title: `Не удалось сохранить блок «${SECTION_LABELS[variables.section]}»`,
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isSavingSettings = saveSectionMutation.isPending;
  const savingSection = saveSectionMutation.variables?.section ?? null;
  const mutateSettingsAsync = saveSectionMutation.mutateAsync;

  const saveCommentsMutation = useMutation({
    mutationFn: (payload: ChatSettings) => updateSettings(api, chatId ?? '', payload),
    onSuccess: (saved) => {
      syncSavedCommentsSettings(saved);
      pushToast({
        tone: 'success',
        title: 'Комментарии сохранены',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить комментарии',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isSavingComments = saveCommentsMutation.isPending;
  const mutateCommentsAsync = saveCommentsMutation.mutateAsync;

  const recheckAccessMutation = useMutation({
    mutationFn: () => recheckManagedEntityAccess(api, 'chat', chatId ?? ''),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({
        tone: 'success',
        title: 'Проверка доступа запущена',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось запустить проверку доступа',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });

  const resolveRequiredSubscriptionChannelMutation = useMutation({
    mutationFn: (value: string) => resolveRequiredSubscriptionChannel(api, chatId ?? '', value),
    onSuccess: ({ channel }) => {
      const alreadySelected = draft?.requiredSubscriptionChannelIds.includes(channel.id) ?? false;
      setResolvedRequiredSubscriptionChannels((current) => {
        const next = current.filter((item) => item.id !== channel.id);
        next.push(channel);
        return next;
      });
      if (!alreadySelected) {
        addRequiredSubscriptionChannel(channel.id);
      }
      setRequiredSubscriptionExternalChannelValue('');
      setRequiredSubscriptionExternalChannelError('');
      const entityLabel = formatRequiredSubscriptionEntityLabel(channel.entityType);
      pushToast({
        tone: 'success',
        title: alreadySelected
          ? `${entityLabel} уже в списке`
          : `${entityLabel} «${channel.title}» добавлен`,
      });
      maxNotify('success');
    },
    onError: (error) => {
      setRequiredSubscriptionExternalChannelError(formatApiError(error));
      maxNotify('error');
    },
  });
  const isResolvingRequiredSubscriptionChannel =
    resolveRequiredSubscriptionChannelMutation.isPending;

  const saveSpeechStyleMutation = useMutation({
    mutationFn: ({ payload }: { style: BotSpeechStyle; payload: ChatSettings }) =>
      updateSettings(api, chatId ?? '', payload),
    onSuccess: (saved, variables) => {
      syncSavedBotSpeechStyle(saved);
      setSpeechStylePanelOpen(false);
      setPendingSpeechStyle(null);
      pushToast({
        tone: 'success',
        title: `Стиль «${BOT_SPEECH_STYLE_METADATA[variables.style].label}» применен`,
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить стиль речи',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isSavingSpeechStyle = saveSpeechStyleMutation.isPending;

  const saveRulesMutation = useMutation({
    mutationFn: (payload: UpdateChatRulesPayload) => updateRules(api, chatId ?? '', payload),
    onSuccess: (saved, payload) => {
      const payloadSnapshot = serializeRulesDraftPayload(payload);
      setRulesDraft((current) => {
        if (!current) {
          return saved;
        }
        const currentSnapshot = serializeRulesDraftPayload(current);
        return currentSnapshot === payloadSnapshot ? saved : current;
      });
      setRulesTextError('');
      setRulesImageError('');
      setRulesButtonErrors([]);
      setRulesButtonFieldsTouched(false);
      setRulesButtonRevealSignal(0);
      setRulesFailedSnapshot('');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
    },
    onError: (error, payload) => {
      setRulesFailedSnapshot(serializeRulesDraftPayload(payload));
      pushToast({
        tone: 'danger',
        title: 'Не удалось сохранить черновик правил',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isSavingRules = saveRulesMutation.isPending;
  const mutateRules = saveRulesMutation.mutate;
  const mutateRulesAsync = saveRulesMutation.mutateAsync;
  const isHeaderSaving = isSavingSettings || isSavingRules || isSavingSpeechStyle;
  const hasPendingHeaderChanges = hasChanges || hasRulesChanges;
  const showHeaderStatus = isHeaderSaving || hasPendingHeaderChanges;
  const compactHeaderStatusLabel = isHeaderSaving ? 'Сохр.' : 'Черн.';
  const activeSpeechStyle = draft?.botSpeechStyle ?? null;
  const pendingSpeechStyleSamples = pendingSpeechStyle
    ? buildSpeechStylePreviewSamples(pendingSpeechStyle, botSpeechPreviewContext)
    : null;
  const botSpeechEditorProps = draft
    ? {
        settings: draft,
        onImageChange: setBotSpeechMediaImage,
      }
    : undefined;

  const publishRulesMutation = useMutation({
    mutationFn: () => publishRules(api, chatId ?? ''),
    onSuccess: (result) => {
      const updated = chatRulesSchema.parse({
        ...(rulesDraft ?? rulesQuery.data ?? {}),
        publishedMessageId: result.messageId,
        publishedUrl: result.url,
        publishedAt: result.publishedAt,
      });
      setRulesDraft(updated);
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({
        tone: 'success',
        title: 'Правила опубликованы',
        description: 'Пост опубликован.',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось опубликовать правила',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isPublishingRules = publishRulesMutation.isPending;

  const resetPublishedRulesMutation = useMutation({
    mutationFn: () => resetPublishedRules(api, chatId ?? ''),
    onSuccess: (updated) => {
      const nextDraft = chatRulesSchema.parse({
        ...(rulesDraft ?? updated),
        publishedMessageId: null,
        publishedUrl: null,
        publishedAt: null,
      });
      setRulesDraft(nextDraft);
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({
        tone: 'success',
        title: 'Публикация правил сброшена',
        description: 'Ранее опубликованный пост удален, статус очищен.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось сбросить публикацию',
        description: formatApiError(error),
      });
    },
  });
  const isResettingPublishedRules = resetPublishedRulesMutation.isPending;

  const applySectionToAllMutation = useMutation({
    mutationFn: async ({
      section,
      sourceSettings,
      target,
    }: {
      section: ApplySectionKey;
      sourceSettings: ChatSettings;
      target: ApplySettingsTarget;
    }) => {
      if (!chatId) {
        throw new Error('Чат не выбран');
      }

      const savedSourceSettings = await updateSettings(api, chatId, sourceSettings);
      const result = await applySettingsSectionToAll(api, chatId, section, target);
      return {
        ...result,
        section,
        sourceSettings: savedSourceSettings,
      };
    },
    onSuccess: (result) => {
      syncSavedSectionSettings(result.section, result.sourceSettings);
      pushToast({
        tone: 'success',
        title: `Блок «${SECTION_LABELS[result.section]}» применен`,
        description: `Обновлено чатов: ${result.updatedChats}.`,
      });
      setApplyTargetSheet(null);
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить блок ко всем чатам',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isApplyingSectionToAll = applySectionToAllMutation.isPending;
  const applyingSection = applySectionToAllMutation.variables?.section ?? null;

  useEffect(() => {
    if (!chatId || !applyTargetSheet) {
      setApplyTargetPreview(null);
      setApplyTargetPreviewError(null);
      setApplyTargetPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setApplyTargetPreviewLoading(true);
    setApplyTargetPreviewError(null);

    void previewApplySettingsSectionTarget(api, chatId, applyTargetSheet.target)
      .then((preview) => {
        if (cancelled) {
          return;
        }

        setApplyTargetPreview(preview);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        setApplyTargetPreview(null);
        setApplyTargetPreviewError(formatApiError(error));
      })
      .finally(() => {
        if (!cancelled) {
          setApplyTargetPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, applyTargetSheet, chatId]);

  useEffect(() => {
    const shouldBlockClose = hasPendingHeaderChanges || isHeaderSaving || isApplyingSectionToAll;
    setMaxClosingConfirmation(shouldBlockClose);
    return () => {
      setMaxClosingConfirmation(false);
    };
  }, [hasPendingHeaderChanges, isApplyingSectionToAll, isHeaderSaving]);

  const addDomainMutation = useMutation({
    mutationFn: (payload: { domain: string; matchType: AllowlistMatchType }) =>
      addDomain(api, chatId ?? '', payload),
    onSuccess: (_, payload) => {
      setDomainInput('');
      setDomainInputError('');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({
        tone: 'success',
        title:
          payload.matchType === 'DOMAIN'
            ? 'Домен добавлен в белый список'
            : 'Ссылка добавлена в белый список',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title:
          domainInputMode === 'DOMAIN' ? 'Не удалось добавить домен' : 'Не удалось добавить ссылку',
        description: formatApiError(error),
      });
    },
  });

  const removeDomainMutation = useMutation({
    mutationFn: (domain: string) => removeDomain(api, chatId ?? '', domain),
    onSuccess: () => {
      setScheduleDomain(null);
      setScheduleError('');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({ tone: 'success', title: 'Правило удалено из белого списка' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить правило',
        description: formatApiError(error),
      });
    },
  });

  const scheduleDomainRemovalMutation = useMutation({
    mutationFn: (payload: { domain: string; removeAfterAt: string | null }) =>
      scheduleDomainRemoval(api, chatId ?? '', payload.domain, payload.removeAfterAt),
    onSuccess: (_, payload) => {
      setScheduleError('');
      setScheduleDomain(null);
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      if (payload.removeAfterAt) {
        pushToast({
          tone: 'success',
          title: 'Удаление правила запланировано',
          description: `Правило будет удалено ${formatRemovalDateTime(payload.removeAfterAt)}.`,
        });
        return;
      }

      pushToast({ tone: 'success', title: 'Отложенное удаление отменено' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить расписание удаления',
        description: formatApiError(error),
      });
    },
  });

  const sendBroadcastTestMutation = useMutation({
    mutationFn: (payload: SendBroadcastPayload) => sendBroadcastTest(api, chatId ?? '', payload),
    onSuccess: () => {
      pushToast({
        tone: 'success',
        title: 'Тест отправлен',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Тест не отправлен',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });

  const clearBroadcastHandoffMutation = useMutation({
    mutationFn: () => clearBroadcastHandoffState(api, chatId ?? ''),
    onSuccess: () => {
      appliedBroadcastHandoffSignatureRef.current = null;
      resetMailingComposer();
      void queryClient.invalidateQueries({ queryKey: ['broadcast-handoff-state', chatId] });
      pushToast({
        tone: 'info',
        title: 'Черновик очищен',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось очистить черновик',
        description: formatApiError(error),
      });
    },
  });

  const invalidateChatAutopostData = () => {
    void queryClient.invalidateQueries({ queryKey: ['managed-autopost-rules', chatId] });
    void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
    void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
  };

  const updateManagedAutopostRuleMutation = useMutation({
    mutationFn: ({
      ruleId,
      payload,
      status,
    }: {
      ruleId: string;
      payload?: SendBroadcastPayload;
      status?: 'ACTIVE' | 'PAUSED';
    }) =>
      updateManagedAutopostRule(api, chatId ?? '', ruleId, {
        ...(payload
          ? {
              payload: normalizeManagedAutopostPayload(payload),
            }
          : {}),
        ...(status ? { status } : {}),
      }),
    onSuccess: (rule) => {
      invalidateChatAutopostData();
      const savedEditingRule = editingManagedAutopostRule?.id === rule.id;
      if (savedEditingRule) {
        resetMailingComposer();
        setMailingWorkspaceView('autoposts');
      }
      pushToast({
        tone: rule.status === 'PAUSED' ? 'info' : 'success',
        title: savedEditingRule
          ? 'Автопост сохранён'
          : rule.status === 'PAUSED'
            ? 'Пауза'
            : 'Автопост запущен',
      });
      maxNotify(rule.status === 'PAUSED' ? 'warning' : 'success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить автопост',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });

  const deleteManagedAutopostRuleMutation = useMutation({
    mutationFn: (ruleId: string) => deleteManagedAutopostRule(api, chatId ?? '', ruleId),
    onSuccess: () => {
      invalidateChatAutopostData();
      if (deleteManagedAutopostRuleMutation.variables === editingManagedAutopostRule?.id) {
        resetMailingComposer();
      }
      setManagedAutopostRuleDeleteTarget(null);
      pushToast({ tone: 'info', title: 'Автопост отменён' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отменить автопост',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });

  const openManagedAutopostRuleMutation = useMutation({
    mutationFn: (ruleId: string) => getManagedAutopostRule(api, chatId ?? '', ruleId),
    retry: 2,
    onSuccess: (rule) => {
      const payload = rule.payload;
      setEditingManagedBroadcast(null);
      setEditingManagedAutopostRule(rule);
      setMailingText(payload.text);
      setMailingButtons(payload.buttons);
      applyMailingImages(resolveBroadcastImagesFromLegacyFields(payload));
      setMailingVideoCleared(false);
      setMailingTargetMode(payload.targetMode);
      setMailingTargetChatIds(normalizeBroadcastAudienceTargetChatIds(payload.targetChatIds));
      setMailingLastScopedTargetMode(payload.targetMode === 'selected' ? 'selected' : 'current');
      setMailingTimingMode('scheduled');
      setMailingScheduledSlots(sortAndUniqueBroadcastSlots(payload.scheduledSlots));
      setMailingScheduleTimezone(
        payload.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      );
      setMailingScheduleError('');
      setMailingCycleError('');
      resetMailingPlanner();
      setMailingWorkspaceView('compose');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть автопост',
        description: formatApiError(error),
      });
    },
  });

  const updateRulesAttachMutation = useMutation({
    mutationFn: (enabled: boolean) => {
      const base = settingsQuery.data ?? draft;
      if (!chatId || !base) {
        throw new Error('Чат не выбран');
      }

      return updateSettings(api, chatId, {
        ...base,
        rulesAttachViolationsEnabled: enabled,
      });
    },
    onSuccess: (saved) => {
      setDraft((current) =>
        current
          ? {
              ...current,
              rulesAttachViolationsEnabled: saved.rulesAttachViolationsEnabled,
            }
          : saved,
      );
      queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
        ['settings-screen', chatId],
        (current) =>
          current
            ? {
                ...current,
                settings: {
                  ...current.settings,
                  rulesAttachViolationsEnabled: saved.rulesAttachViolationsEnabled,
                },
              }
            : current,
      );
      pushToast({
        tone: 'success',
        title: saved.rulesAttachViolationsEnabled
          ? 'Кнопка «Правила» включена'
          : 'Кнопка «Правила» выключена',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить кнопку «Правила»',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });

  const updateManagedBroadcastMutation = useMutation({
    mutationFn: ({
      broadcastId,
      payload,
    }: {
      broadcastId: string;
      payload: SendBroadcastPayload;
    }) => updateManagedBroadcast(api, chatId ?? '', broadcastId, payload),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
      resetMailingComposer();
      pushToast({
        tone: broadcast.status === 'FAILED' ? 'info' : 'success',
        title: 'Автопостинг обновлён',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatRemovalDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
          : 'Изменения сохранены.',
      });
    },
    onError: (error) => {
      const description = reportMailingAudienceApiError(error);
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить автопостинг',
        description,
      });
    },
  });

  const cancelManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) => cancelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
      setManagedBroadcastDeleteTarget(null);
      if (editingManagedBroadcast?.id === broadcast.id) {
        resetMailingComposer();
      }
      pushToast({
        tone: 'info',
        title: 'Отправки отменены',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отменить',
        description: formatApiError(error),
      });
    },
  });

  const retryManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) => retryManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
      pushToast({
        tone: broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL' ? 'info' : 'success',
        title:
          broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL'
            ? 'Часть чатов все еще с ошибкой'
            : 'Повтор выполнен',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatRemovalDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
          : 'Ошибка закрыта.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось повторить автопостинг',
        description: formatApiError(error),
      });
    },
  });

  function applyManagedBroadcastToMailingComposer(broadcast: ManagedBroadcastDetails) {
    const targetChatIds = normalizeBroadcastAudienceTargetChatIds(broadcast.targetChatIds);
    setEditingManagedAutopostRule(null);
    setEditingManagedBroadcast(broadcast);
    setMailingTargetMode(broadcast.targetMode);
    setMailingTargetChatIds(
      broadcast.targetMode === 'selected' && targetChatIds.length === 0
        ? chatId
          ? [chatId]
          : []
        : targetChatIds,
    );
    setMailingLastScopedTargetMode(
      resolveBroadcastAudienceLastScopedMode({
        targetMode: broadcast.targetMode,
        targetChatIds,
        currentChatId: chatId ?? undefined,
      }),
    );
    setMailingAudienceError('');
    setMailingText(broadcast.text);
    setMailingButtons(broadcast.buttons);
    applyMailingImages(resolveBroadcastImagesFromLegacyFields(broadcast));
    setMailingVideoCleared(false);
    const restoredTimingMode: BroadcastTimingMode =
      broadcast.scheduleMode === 'calendar'
        ? 'scheduled'
        : broadcast.cycleEnabled
          ? 'cycle'
          : broadcast.nextSendAt
            ? 'scheduled'
            : 'now';
    setMailingTimingMode(restoredTimingMode);
    setMailingCycleDraft(
      normalizeBroadcastCycleDraft({
        startMode: broadcast.nextSendAt ? 'later' : 'now',
        startAt: broadcast.nextSendAt ?? createDefaultBroadcastCycleDraft().startAt,
        everyHours: broadcast.cycleEveryHours,
        count: Math.max(2, broadcast.cycleCount),
      }),
    );
    setMailingScheduledSlots(
      sortAndUniqueBroadcastSlots(
        broadcast.scheduleMode === 'calendar'
          ? broadcast.scheduledSlots
          : broadcast.nextSendAt && !broadcast.cycleEnabled
            ? [broadcast.nextSendAt]
            : [],
      ),
    );
    setMailingScheduleTimezone(
      broadcast.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
    );
    setMailingTextError('');
    setMailingButtonErrors([]);
    setMailingImageError('');
    setMailingScheduleError('');
    setMailingCycleError('');
    resetMailingPlanner();
    setMailingWorkspaceView('compose');
    setExpandedSections((current) => ({ ...current, mailing: true }));
  }

  const openManagedBroadcastEditorMutation = useMutation({
    mutationFn: (broadcastId: string) => getManagedBroadcast(api, chatId ?? '', broadcastId),
    retry: 2,
    onSuccess: (broadcast) => {
      applyManagedBroadcastToMailingComposer(broadcast);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть автопостинг',
        description: formatApiError(error),
      });
    },
  });

  function clearFieldError(key: keyof ChatSettings) {
    setFieldErrors((current) => {
      if (!current[key]) {
        return current;
      }

      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function setFieldValue<K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    clearFieldError(key);
  }

  function normalizeRequiredSubscriptionDraftSettings(settings: ChatSettings): ChatSettings {
    const requiredSubscriptionChannelIds = Array.from(
      new Set(
        settings.requiredSubscriptionChannelIds
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    );

    return {
      ...settings,
      requiredSubscriptionEnabled: requiredSubscriptionChannelIds.length > 0,
      requiredSubscriptionChannelIds,
      requiredSubscriptionExpiresAt: '',
    };
  }

  function setBotSpeechMediaImage(key: BotSpeechMediaFieldKey, image: BotSpeechMediaImage | null) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const nextMedia = { ...current.botSpeechMedia };
      if (image?.base64) {
        nextMedia[key] = image;
      } else {
        delete nextMedia[key];
      }
      return { ...current, botSpeechMedia: nextMedia };
    });
    clearFieldError('botSpeechMedia');
  }

  function clearButtonGroupErrors(group: ChatSettingsButtonGroup) {
    clearFieldError(group.buttonsKey);
    clearFieldError(group.urlKey);
    clearFieldError(group.textKey);
  }

  function updateDraftButtonGroup(
    group: ChatSettingsButtonGroup,
    options: {
      buttons?: BroadcastLinkButton[];
      enabled?: boolean;
    },
  ) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const nextButtons = options.buttons ?? current[group.buttonsKey];
      const buttonState = buildBroadcastLinkButtonLegacyFields(nextButtons);

      return {
        ...current,
        [group.buttonsKey]: nextButtons,
        [group.enabledKey]: options.enabled ?? current[group.enabledKey],
        [group.urlKey]: buttonState.buttonUrl,
        [group.textKey]: buttonState.buttonText,
      };
    });
    clearButtonGroupErrors(group);
  }

  function updateAdminContactButtonGroup(group: AdminContactButtonGroup, enabled: boolean) {
    if (enabled && !adminContactProfileUrl) {
      pushToast({
        tone: 'info',
        title: 'Ссылка на админа пока недоступна',
        description: 'Бот сможет добавить ссылку после события, где виден ваш профиль.',
      });
      return;
    }

    setDraft((current) =>
      current
        ? ({
            ...current,
            [group.enabledKey]: enabled,
            [group.urlKey]: enabled ? adminContactProfileUrl : '',
          } as ChatSettings)
        : current,
    );
    clearFieldError(group.enabledKey);
    clearFieldError(group.urlKey);
  }

  function renderAdminContactToggle(
    group: AdminContactButtonGroup,
    ariaLabel = 'Добавить связь с админом в сообщение бота',
  ) {
    if (!draft) {
      return null;
    }

    return (
      <AdminContactToggle
        title={ADMIN_CONTACT_BUTTON_TEXT}
        checked={Boolean(draft[group.enabledKey])}
        onChange={(enabled) => updateAdminContactButtonGroup(group, enabled)}
        ariaLabel={ariaLabel}
        nested
      />
    );
  }

  function addRequiredSubscriptionChannel(channelId: string) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      if (current.requiredSubscriptionChannelIds.includes(channelId)) {
        return current;
      }

      if (current.requiredSubscriptionChannelIds.length >= REQUIRED_SUBSCRIPTION_MAX_CHANNELS) {
        return current;
      }

      return {
        ...current,
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: [...current.requiredSubscriptionChannelIds, channelId],
        requiredSubscriptionExpiresAt: '',
      };
    });
    clearFieldError('requiredSubscriptionChannelIds');
  }

  function removeRequiredSubscriptionChannel(channelId: string) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const requiredSubscriptionChannelIds = current.requiredSubscriptionChannelIds.filter(
        (item) => item !== channelId,
      );
      return {
        ...current,
        requiredSubscriptionEnabled: requiredSubscriptionChannelIds.length > 0,
        requiredSubscriptionChannelIds,
        requiredSubscriptionExpiresAt: '',
      };
    });
    clearFieldError('requiredSubscriptionChannelIds');
  }

  function refreshRequiredSubscriptionChannels() {
    setChatsListRefreshRequest((current) => ({
      nonce: current.nonce + 1,
      behavior: 'manual',
    }));
    setRequiredSubscriptionChannelsRefreshRequest((current) => ({
      nonce: current.nonce + 1,
      behavior: 'manual',
    }));
  }

  function handleResolveRequiredSubscriptionExternalChannel() {
    const normalizedValue = requiredSubscriptionExternalChannelValue.trim();
    if (!chatId) {
      return;
    }

    if (!normalizedValue) {
      setRequiredSubscriptionExternalChannelError(
        'Укажите публичную ссылку, ссылку на чат/пост MAX или ID чата/канала.',
      );
      return;
    }

    if ((draft?.requiredSubscriptionChannelIds.length ?? 0) >= REQUIRED_SUBSCRIPTION_MAX_CHANNELS) {
      setRequiredSubscriptionExternalChannelError(
        `Можно выбрать максимум ${REQUIRED_SUBSCRIPTION_MAX_CHANNELS} чатов и каналов.`,
      );
      return;
    }

    setRequiredSubscriptionExternalChannelError('');
    resolveRequiredSubscriptionChannelMutation.mutate(normalizedValue);
  }

  function clearSectionErrors(section: ApplySectionKey) {
    setFieldErrors((current) => {
      let changed = false;
      const next = { ...current };

      for (const key of SECTION_SETTING_KEYS[section]) {
        if (!next[key]) {
          continue;
        }

        delete next[key];
        changed = true;
      }

      return changed ? next : current;
    });
  }

  function clearCommentsErrors() {
    setFieldErrors((current) => {
      let changed = false;
      const next = { ...current };

      for (const key of COMMENTS_SETTING_KEYS) {
        if (!next[key]) {
          continue;
        }

        delete next[key];
        changed = true;
      }

      return changed ? next : current;
    });
  }

  function clearBotSpeechErrors() {
    setFieldErrors((current) => {
      let changed = false;
      const next = { ...current };

      for (const key of BOT_SPEECH_SYNC_SETTING_KEYS) {
        if (!next[key]) {
          continue;
        }

        delete next[key];
        changed = true;
      }

      return changed ? next : current;
    });
  }

  function syncSavedSectionSettings(section: ApplySectionKey, saved: ChatSettings) {
    const normalizedSaved = normalizeRequiredSubscriptionDraftSettings(saved);
    setDraft((current) =>
      current ? mergeSectionSettings(current, normalizedSaved, section) : normalizedSaved,
    );
    clearSectionErrors(section);
    queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
      ['settings-screen', chatId],
      (current) =>
        current
          ? {
              ...current,
              settings: mergeSectionSettings(
                normalizeRequiredSubscriptionDraftSettings(current.settings),
                normalizedSaved,
                section,
              ),
            }
          : current,
    );
  }

  function syncSavedCommentsSettings(saved: ChatSettings) {
    setDraft((current) => (current ? mergeCommentsSettings(current, saved) : saved));
    clearCommentsErrors();
    queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
      ['settings-screen', chatId],
      (current) =>
        current
          ? {
              ...current,
              settings: mergeCommentsSettings(current.settings, saved),
            }
          : current,
    );
  }

  function syncSavedBotSpeechStyle(saved: ChatSettings) {
    setDraft((current) => (current ? mergeBotSpeechStyleSettings(current, saved) : saved));
    clearBotSpeechErrors();
    queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
      ['settings-screen', chatId],
      (current) =>
        current
          ? {
              ...current,
              settings: mergeBotSpeechStyleSettings(current.settings, saved),
            }
          : current,
    );
  }

  function validateDraft(value: ChatSettings): ChatSettings | null {
    const normalizedValue = normalizeRequiredSubscriptionDraftSettings(value);
    const parsed = chatSettingsSchema.safeParse(normalizedValue);

    if (parsed.success) {
      const normalizedParsed = normalizeRequiredSubscriptionDraftSettings(parsed.data);
      const nextErrors: FieldErrors = {};

      if (
        normalizedParsed.requiredSubscriptionEnabled &&
        selectedUnavailableRequiredSubscriptionChannels.length > 0
      ) {
        nextErrors.requiredSubscriptionChannelIds =
          'Удалите недоступные чаты или каналы без рабочей ссылки и выберите их заново.';
      }

      if (Object.keys(nextErrors).length === 0) {
        setFieldErrors({});
        return normalizedParsed;
      }

      setFieldErrors(nextErrors);
      return null;
    }

    const nextErrors: FieldErrors = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof ChatSettings | undefined;
      if (!key || nextErrors[key]) {
        continue;
      }
      nextErrors[key] = issue.message;
    }

    setFieldErrors(nextErrors);
    return null;
  }

  function validateRulesDraft(
    value: ChatRules,
    options: { forceButtonErrors?: boolean } = {},
  ): UpdateChatRulesPayload | null {
    const normalizedText = value.text;
    if (normalizedText.length > MAX_CHAT_RULES_TEXT_LENGTH) {
      setRulesTextError(`Максимум ${MAX_CHAT_RULES_TEXT_LENGTH} символов.`);
      return null;
    }
    setRulesTextError('');

    if (value.imageBase64) {
      if (!value.imageMimeType.toLowerCase().startsWith('image/')) {
        setRulesImageError('Поддерживаются только изображения.');
        return null;
      }
      setRulesImageError('');
    } else {
      setRulesImageError('');
    }

    const shouldShowButtonErrors = Boolean(options.forceButtonErrors || rulesButtonFieldsTouched);
    const normalizedButtonState = buildBroadcastLinkButtonLegacyFields(value.buttons);
    if (value.buttonEnabled) {
      const nextButtonErrors = validateBroadcastLinkButtons(value.buttons);
      if (hasBroadcastLinkButtonErrors(nextButtonErrors)) {
        setRulesButtonErrors(shouldShowButtonErrors ? nextButtonErrors : []);
        return null;
      }
      setRulesButtonErrors([]);
    } else {
      setRulesButtonErrors([]);
    }

    return {
      autoTextEnabled: value.autoTextEnabled,
      text: value.text,
      imageBase64: value.imageBase64,
      imageMimeType: value.imageMimeType,
      imageFileName: value.imageFileName,
      buttons: value.buttons,
      buttonEnabled: value.buttonEnabled,
      buttonUrl: normalizedButtonState.buttonUrl,
      buttonText: normalizedButtonState.buttonText,
      adminContactButtonEnabled: value.adminContactButtonEnabled,
      adminContactButtonUrl: value.adminContactButtonEnabled ? value.adminContactButtonUrl : '',
    };
  }

  function reportRulesAutofillError(error: unknown) {
    const description = error instanceof Error ? error.message : 'Не удалось собрать текст правил.';
    setRulesTextError(description);
    pushToast({
      tone: 'danger',
      title: 'Не удалось собрать текст правил',
      description,
    });
    maxNotify('error');
  }

  function buildRulesDraftFromCurrentSettings(value: ChatRules): ChatRules {
    if (!currentRulesTextSource) {
      throw new Error('Настройки чата ещё загружаются.');
    }

    return {
      ...value,
      autoTextEnabled: true,
      text: buildRulesTextFromSettingsScreen(currentRulesTextSource),
    };
  }

  function prepareRulesDraftForSubmit(value: ChatRules): ChatRules | null {
    if (!value.autoTextEnabled) {
      return value;
    }

    try {
      const nextDraft = buildRulesDraftFromCurrentSettings(value);
      setRulesTextError('');
      if (serializeRulesDraftPayload(nextDraft) !== serializeRulesDraftPayload(value)) {
        setRulesDraft((current) =>
          current ? { ...current, text: nextDraft.text, autoTextEnabled: true } : current,
        );
      }
      return nextDraft;
    } catch (error) {
      reportRulesAutofillError(error);
      return null;
    }
  }

  async function saveRulesDraftNow(
    options: { forceButtonErrors?: boolean; draft?: ChatRules } = {},
  ): Promise<ChatRules | null> {
    const targetDraft = options.draft ?? rulesDraft;
    if (!targetDraft) {
      return null;
    }

    const payload = validateRulesDraft(targetDraft, options);
    if (!payload) {
      return null;
    }

    return mutateRulesAsync(payload);
  }

  function secondsToHours(value: number): number {
    return Math.max(1, Math.round(value / 3600));
  }

  function applyDuplicateFlowConfig(overrides: {
    allowedCount?: number;
    windowSec?: number;
    duplicateBotMessageEnabled?: boolean;
    duplicateWarnEnabled?: boolean;
    duplicateMuteEnabled?: boolean;
    duplicateBanEnabled?: boolean;
  }) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const duplicateBotMessageEnabled =
        overrides.duplicateBotMessageEnabled ?? current.duplicateBotMessageEnabled;
      const duplicateWarnEnabled = overrides.duplicateWarnEnabled ?? current.duplicateWarnEnabled;
      const duplicateMuteEnabled = overrides.duplicateMuteEnabled ?? current.duplicateMuteEnabled;
      const duplicateBanEnabled = overrides.duplicateBanEnabled ?? current.duplicateBanEnabled;
      const allowedCount = overrides.allowedCount ?? resolveDuplicateAllowedCount(current);
      const windowSec = overrides.windowSec ?? resolveDuplicateSharedWindowSec(current);

      return {
        ...current,
        duplicateBotMessageEnabled,
        duplicateWarnEnabled,
        duplicateMuteEnabled,
        duplicateBanEnabled,
        ...buildDuplicateFlowSettings({
          duplicateBotMessageEnabled,
          duplicateWarnEnabled,
          duplicateMuteEnabled,
          duplicateBanEnabled,
          allowedCount,
          windowSec,
        }),
      };
    });

    clearFieldError('duplicateWarnWindowSec');
    clearFieldError('duplicateWarnMaxCount');
    clearFieldError('duplicateMuteWindowSec');
    clearFieldError('duplicateMuteMaxCount');
    clearFieldError('duplicateBanWindowSec');
    clearFieldError('duplicateBanMaxCount');
  }

  function handleDuplicateWindowHoursChange(rawValue: string) {
    setDuplicateWindowInputValue(rawValue);

    const normalized = rawValue.trim();
    if (normalized.length === 0) {
      return;
    }

    const hours = Number.parseInt(normalized, 10);
    if (Number.isNaN(hours)) {
      return;
    }

    const safeHours = Math.min(168, Math.max(1, hours));
    applyDuplicateFlowConfig({ windowSec: safeHours * 3600 });
  }

  function handleDuplicateWindowHoursBlur() {
    const rawValue = duplicateWindowInputValue;
    const normalized = rawValue.trim();
    const parsed = Number.parseInt(normalized, 10);

    const fallbackHours = draft ? secondsToHours(resolveDuplicateSharedWindowSec(draft)) : 1;
    const safeHours = Number.isNaN(parsed) ? fallbackHours : Math.min(168, Math.max(1, parsed));
    applyDuplicateFlowConfig({ windowSec: safeHours * 3600 });
    setDuplicateWindowInputValue('');
  }

  function formatMuteDurationCompact(hours: number) {
    return hours >= 24 && hours % 24 === 0 ? `${hours / 24}д` : `${hours}ч`;
  }

  function setMuteDurationValue(key: AutoMuteDurationKey, nextValue: number) {
    const safeValue = Math.min(
      AUTO_MUTE_DURATION_MAX_HOURS,
      Math.max(AUTO_MUTE_DURATION_MIN_HOURS, Math.round(nextValue)),
    );
    setFieldValue(key, safeValue as ChatSettings[AutoMuteDurationKey]);
  }

  function adjustMuteDuration(key: AutoMuteDurationKey, deltaHours: number) {
    if (!draft) {
      return;
    }

    setMuteDurationValue(key, Number(draft[key]) + deltaHours);
  }

  function adjustDeleteBotMessagesDelayValue(
    key: 'deleteBotMessagesDelayMinutes' | 'greetingDeleteBotMessageDelayMinutes',
    direction: number,
  ) {
    if (!draft) {
      return;
    }

    const next = stepDeleteBotMessagesDelayMinutes(Number(draft[key]), direction);

    setFieldValue(key, next as ChatSettings[typeof key]);
  }

  function adjustDeleteBotMessagesDelay(direction: number) {
    adjustDeleteBotMessagesDelayValue('deleteBotMessagesDelayMinutes', direction);
  }

  function adjustGreetingDeleteBotMessagesDelay(direction: number) {
    adjustDeleteBotMessagesDelayValue('greetingDeleteBotMessageDelayMinutes', direction);
  }

  function adjustStickerMessageCooldown(deltaMinutes: number) {
    if (!draft) {
      return;
    }

    const next = Math.min(
      STICKER_COOLDOWN_MAX_MINUTES,
      Math.max(
        STICKER_COOLDOWN_MIN_MINUTES,
        Number(draft.stickerMessageCooldownMinutes) + deltaMinutes,
      ),
    );

    setFieldValue(
      'stickerMessageCooldownMinutes',
      next as ChatSettings['stickerMessageCooldownMinutes'],
    );
  }

  function adjustDuplicateAllowedCount(currentValue: number, delta: number) {
    const next = Math.min(
      DUPLICATE_ALLOWED_COUNT_MAX,
      Math.max(DUPLICATE_ALLOWED_COUNT_MIN, Number(currentValue) + delta),
    );
    applyDuplicateFlowConfig({ allowedCount: next });
  }

  function setIntegerChatFieldValue<K extends NumericChatSettingKey>(
    key: K,
    rawValue: string,
    min: number,
    max: number,
  ) {
    const parsed = Number.parseInt(rawValue, 10);
    if (Number.isNaN(parsed)) {
      return;
    }

    const safeValue = Math.min(max, Math.max(min, parsed));
    setFieldValue(key, safeValue as ChatSettings[K]);
  }

  function applyDuplicateDetectionPreset(preset: DuplicateDetectionPreset) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        duplicateDetectionPreset: preset,
        ...(preset === 'STANDARD'
          ? {
              duplicateIgnoreLinksEnabled: false,
              duplicateIgnorePhonesEnabled: false,
              duplicateNearMatchEnabled: false,
            }
          : preset === 'STRICT'
            ? {
                duplicateIgnoreLinksEnabled: true,
                duplicateIgnorePhonesEnabled: true,
                duplicateNearMatchEnabled: true,
              }
            : {}),
      };
    });
    clearFieldError('duplicateDetectionPreset');
    clearFieldError('duplicateIgnoreLinksEnabled');
    clearFieldError('duplicateIgnorePhonesEnabled');
    clearFieldError('duplicateNearMatchEnabled');
  }

  function addMessageLimitsBlockedWords() {
    if (!draft) {
      return;
    }

    const { actions, addedWords, nextWords, removedWords } = applyMessageLimitsBlockedWordsInput(
      draft.messageLimitsBlockedWords,
      messageLimitsBlockedWordsInput,
      MESSAGE_LIMITS_BLOCKED_WORDS_MAX,
    );

    if (actions.length === 0) {
      if (messageLimitsBlockedWordsInput.trim()) {
        setFieldErrors((current) => ({
          ...current,
          messageLimitsBlockedWords: 'Нужно одно слово без пробелов, можно с префиксом + или -.',
        }));
      }
      return;
    }

    if (addedWords.length === 0 && removedWords.length === 0) {
      const hasAddActions = actions.some((action) => action.operation === 'add');
      if (
        hasAddActions &&
        draft.messageLimitsBlockedWords.length >= MESSAGE_LIMITS_BLOCKED_WORDS_MAX
      ) {
        setFieldErrors((current) => ({
          ...current,
          messageLimitsBlockedWords:
            'Лимит стоп-слов достигнут. Уберите лишнее или используйте -слово.',
        }));
      } else {
        clearFieldError('messageLimitsBlockedWords');
      }
      return;
    }

    clearFieldError('messageLimitsBlockedWords');
    setDraft((current) =>
      current
        ? {
            ...current,
            messageLimitsBlockedWords: nextWords,
          }
        : current,
    );
    setMessageLimitsBlockedWordsInput('');
  }

  function applyMessageLimitsBlockedWords(nextWords: string[]) {
    clearFieldError('messageLimitsBlockedWords');
    setDraft((current) =>
      current
        ? {
            ...current,
            messageLimitsBlockedWords: nextWords,
          }
        : current,
    );
  }

  function removeMessageLimitsBlockedWord(wordToRemove: string) {
    if (!draft) {
      return;
    }

    setFieldValue(
      'messageLimitsBlockedWords',
      draft.messageLimitsBlockedWords.filter(
        (word) => word !== wordToRemove,
      ) as ChatSettings['messageLimitsBlockedWords'],
    );
  }

  function addMessageLimitsBlockedDomains() {
    if (!draft) {
      return;
    }

    const { actions, addedDomains, nextDomains, removedDomains } =
      applyMessageLimitsBlockedDomainsInput(
        draft.messageLimitsBlockedDomains,
        messageLimitsBlockedDomainsInput,
        MESSAGE_LIMITS_BLOCKED_DOMAINS_MAX,
      );

    if (actions.length === 0) {
      if (messageLimitsBlockedDomainsInput.trim()) {
        setFieldErrors((current) => ({
          ...current,
          messageLimitsBlockedDomains: 'Укажите домен или ссылку.',
        }));
      }
      return;
    }

    if (addedDomains.length === 0 && removedDomains.length === 0) {
      const hasAddActions = actions.some((action) => action.operation === 'add');
      if (
        hasAddActions &&
        draft.messageLimitsBlockedDomains.length >= MESSAGE_LIMITS_BLOCKED_DOMAINS_MAX
      ) {
        setFieldErrors((current) => ({
          ...current,
          messageLimitsBlockedDomains: 'Лимит доменов достигнут.',
        }));
      } else {
        const addAction = actions.find((action) => action.operation === 'add');
        const coveredBy = addAction
          ? findMessageLimitsBlockedDomainCoveringRule(
              addAction.domain,
              draft.messageLimitsBlockedDomains,
            )
          : null;
        setFieldErrors((current) => ({
          ...current,
          messageLimitsBlockedDomains: addAction
            ? coveredBy && coveredBy !== addAction.domain
              ? `Уже закрыт через ${coveredBy}.`
              : 'Этот домен уже в списке.'
            : 'Такого домена нет в списке.',
        }));
      }
      return;
    }

    clearFieldError('messageLimitsBlockedDomains');
    setDraft((current) =>
      current
        ? {
            ...current,
            messageLimitsBlockedDomains: nextDomains,
          }
        : current,
    );
    setMessageLimitsBlockedDomainsInput('');
  }

  function removeMessageLimitsBlockedDomain(domainToRemove: string) {
    if (!draft) {
      return;
    }

    setFieldValue(
      'messageLimitsBlockedDomains',
      draft.messageLimitsBlockedDomains.filter(
        (domain) => domain !== domainToRemove,
      ) as ChatSettings['messageLimitsBlockedDomains'],
    );
  }

  useEffect(() => {
    if (!rulesFailedSnapshot || rulesFailedSnapshot === rulesDraftSnapshot) {
      return;
    }

    setRulesFailedSnapshot('');
  }, [rulesDraftSnapshot, rulesFailedSnapshot]);

  useEffect(() => {
    if (!chatId || !rulesDraft || !hasRulesChanges || isSavingRules || isPublishingRules) {
      return;
    }

    if (rulesFailedSnapshot && rulesFailedSnapshot === rulesDraftSnapshot) {
      return;
    }

    const parsed = validateRulesDraft(rulesDraft);
    if (!parsed) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      mutateRules(parsed);
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    chatId,
    hasRulesChanges,
    isPublishingRules,
    isSavingRules,
    mutateRules,
    rulesButtonFieldsTouched,
    rulesDraft,
    rulesDraftSnapshot,
    rulesFailedSnapshot,
  ]);

  function handleAddDomain() {
    if (!chatId) {
      return;
    }

    const normalizedDomain =
      domainInputMode === 'DOMAIN' ? normalizeAllowlistDomain(domainInput) : null;
    const normalizedLink = domainInputMode === 'EXACT' ? normalizeAllowlistLink(domainInput) : null;
    const normalizedValue = normalizeStoredAllowlistEntry(domainInput, domainInputMode);
    const normalizedInput = normalizedDomain ?? normalizedLink;

    if (!normalizedInput || !normalizedValue) {
      setDomainInputError(
        domainInputMode === 'DOMAIN'
          ? 'Введите корректный домен.'
          : 'Введите корректную ссылку (http/https).',
      );
      return;
    }

    const alreadyExists = (domainsQuery.data ?? []).some(
      (item) => item.normalizedValue === normalizedValue,
    );
    if (alreadyExists) {
      setDomainInputError('');
      setDomainInput('');
      pushToast({ title: 'Такое правило уже есть в списке' });
      return;
    }

    setDomainInputError('');
    addDomainMutation.mutate({
      domain: normalizedInput,
      matchType: domainInputMode,
    });
  }

  function toggleDomainScheduleEditor(entry: DomainAllowlistEntry) {
    if (scheduleDomain === entry.normalizedValue) {
      setScheduleDomain(null);
      setScheduleError('');
      return;
    }

    const initial = parseIsoToLocalDateTime(entry.removeAfterAt);
    setScheduleDate(initial.date);
    setScheduleTime(initial.time);
    setScheduleError('');
    setScheduleDomain(entry.normalizedValue);
  }

  function submitDomainSchedule(domain: string) {
    if (!chatId) {
      return;
    }

    if (!scheduleDate) {
      setScheduleError('Сначала выберите день удаления.');
      return;
    }

    if (!scheduleTime) {
      setScheduleError('Сначала выберите время удаления.');
      return;
    }

    const scheduledAt = new Date(`${scheduleDate}T${scheduleTime}:00`);
    if (Number.isNaN(scheduledAt.getTime())) {
      setScheduleError('Не удалось распознать дату и время.');
      return;
    }

    if (scheduledAt.getTime() <= Date.now() + DOMAIN_REMOVAL_MIN_FUTURE_MS) {
      setScheduleError('Укажите время в будущем.');
      return;
    }

    setScheduleError('');
    scheduleDomainRemovalMutation.mutate({
      domain,
      removeAfterAt: scheduledAt.toISOString(),
    });
  }

  function clearDomainSchedule(domain: string) {
    if (!chatId) {
      return;
    }

    setScheduleError('');
    scheduleDomainRemovalMutation.mutate({
      domain,
      removeAfterAt: null,
    });
  }

  async function handlePublishRules() {
    if (!chatId || !rulesDraft) {
      return;
    }

    const preparedRulesDraft = prepareRulesDraftForSubmit(rulesDraft);
    if (!preparedRulesDraft) {
      return;
    }

    if (!preparedRulesDraft.autoTextEnabled && !preparedRulesDraft.text.trim()) {
      setRulesTextError('Введите текст правил перед публикацией.');
      return;
    }
    setRulesTextError('');

    if (preparedRulesDraft.text.length > MAX_CHAT_RULES_TEXT_LENGTH) {
      setRulesTextError(`Максимум ${MAX_CHAT_RULES_TEXT_LENGTH} символов.`);
      return;
    }

    const nextRulesSnapshot = serializeRulesDraftPayload(preparedRulesDraft);
    const shouldSavePreparedRules = nextRulesSnapshot !== rulesServerSnapshot;

    if (
      !shouldSavePreparedRules &&
      !validateRulesDraft(preparedRulesDraft, { forceButtonErrors: true })
    ) {
      return;
    }

    const saved = shouldSavePreparedRules
      ? await saveRulesDraftNow({
          forceButtonErrors: true,
          draft: preparedRulesDraft,
        })
      : preparedRulesDraft;
    if (!saved) {
      return;
    }

    publishRulesMutation.mutate();
  }

  function handleManagedPostLinkClick(event: MouseEvent<HTMLElement>, url: string) {
    if (!(window.MAX?.WebApp ?? window.WebApp)) {
      return;
    }

    event.preventDefault();
    openMaxBotLink(url);
  }

  function handleResetPublishedRules() {
    if (!chatId || !hasPublishedRules || isResettingPublishedRules) {
      return;
    }

    if (
      typeof window !== 'undefined' &&
      !window.confirm('Удалить опубликованный пост правил и снять статус публикации?')
    ) {
      return;
    }

    resetPublishedRulesMutation.mutate();
  }

  function resetMailingComposer() {
    setEditingManagedBroadcast(null);
    setEditingManagedAutopostRule(null);
    setMailingTargetMode('current');
    setMailingTargetChatIds(chatId ? [chatId] : []);
    setMailingLastScopedTargetMode('current');
    setMailingAudienceError('');
    setMailingText('');
    setMailingButtons([]);
    resetMailingImages();
    setMailingVideoCleared(false);
    setMailingTimingMode('now');
    setMailingCycleDraft(createDefaultBroadcastCycleDraft());
    setMailingScheduledSlots([]);
    setMailingScheduleTimezone(resolveBroadcastScheduleTimezone());
    setMailingScheduleEnabled(false);
    setMailingScheduleDays(0);
    setMailingScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setMailingCycleEnabled(false);
    setMailingCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setMailingCycleCount(2);
    setMailingTextError('');
    setMailingButtonErrors([]);
    setMailingImageError('');
    setMailingScheduleError('');
    setMailingCycleError('');
    setPendingMailingSlotConflict(null);
    setPendingMailingPublishReview(null);
    setMailingButtonsSheetOpen(false);
    setMailingWorkspaceView('compose');
    resetMailingPlanner();
  }

  function handleCancelMailingEdit() {
    resetMailingComposer();
  }

  function handleClearMailingComposer() {
    if (editingManagedBroadcast || editingManagedAutopostRule) {
      handleCancelMailingEdit();
      return;
    }

    if (!chatId || clearBroadcastHandoffMutation.isPending) {
      resetMailingComposer();
      return;
    }

    clearBroadcastHandoffMutation.mutate();
  }

  function handleMailingAllChatsToggle(enabled: boolean) {
    setMailingAudienceError('');
    if (enabled) {
      setMailingTargetMode('all');
      return;
    }

    const savedTargetChatIds = normalizeBroadcastAudienceTargetChatIds(mailingTargetChatIds);
    if (savedTargetChatIds.length === 0) {
      setMailingTargetChatIds(chatId ? [chatId] : []);
      setMailingTargetMode('current');
      setMailingLastScopedTargetMode('current');
      return;
    }

    setMailingTargetChatIds(savedTargetChatIds);
    setMailingTargetMode(
      restoreBroadcastAudienceModeFromAll({
        lastScopedMode: mailingLastScopedTargetMode,
        targetChatIds: savedTargetChatIds,
      }),
    );
  }

  function handleMailingScopedTargetModeChange(value: string) {
    const nextMode: BroadcastScopedTargetMode = value === 'selected' ? 'selected' : 'current';
    setMailingAudienceError('');
    setMailingLastScopedTargetMode(nextMode);
    setMailingTargetMode(nextMode);
    if (nextMode === 'selected') {
      setMailingTargetChatIds((current) => {
        const normalized = normalizeBroadcastAudienceTargetChatIds(current);
        if (normalized.length > 0) {
          return normalized;
        }

        return chatId ? [chatId] : [];
      });
    }
  }

  function handleApplyMailingAudienceSelection(nextSelection: string[]) {
    const normalizedSelection = normalizeBroadcastAudienceTargetChatIds(nextSelection);
    setMailingTargetChatIds(normalizedSelection);
    setMailingLastScopedTargetMode('selected');
    setMailingTargetMode('selected');
    setMailingAudienceError('');
  }

  function handleRefreshMailingAudienceChoices() {
    startTransition(() => {
      setChatsListRefreshRequest((current) => ({
        nonce: current.nonce + 1,
        behavior: 'manual',
      }));
    });
  }

  function reportMailingAudienceApiError(error: unknown) {
    const message = formatApiError(error);
    if (
      message.toLowerCase().includes('выбранные чаты') ||
      message.toLowerCase().includes('выберите хотя бы один чат')
    ) {
      setMailingAudienceError('Обновите выбор чатов.');
    }
    if (message.includes('BROADCAST_TARGET_SLOT_CONFLICT')) {
      setMailingScheduleError('Занято у получателя.');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
    } else if (
      message.toLowerCase().includes('выбранное время') ||
      message.includes('BROADCAST_SLOT_CONFLICT')
    ) {
      setMailingScheduleError('Занято.');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
    }
    return message;
  }

  function handleMailingPlannerStateChange(nextState: BroadcastSchedulePlannerSelectionState) {
    setMailingPlannerState((current) =>
      areBroadcastPlannerStatesEqual(current, nextState) ? current : nextState,
    );
  }

  function handleDeleteManagedBroadcast(broadcast: ManagedBroadcastListItem) {
    if (!chatId || cancelManagedBroadcastMutation.isPending) {
      return;
    }

    setManagedBroadcastDeleteTarget(broadcast);
  }

  function handleEditManagedBroadcast(broadcast: ManagedBroadcastListItem) {
    if (!chatId || openManagedBroadcastEditorMutation.isPending) {
      return;
    }

    openManagedBroadcastEditorMutation.mutate(broadcast.id);
  }

  function handleDeleteManagedBroadcastById(broadcastId: string) {
    const broadcast = managedBroadcasts.find((item) => item.id === broadcastId);
    if (!broadcast) {
      return;
    }

    handleDeleteManagedBroadcast(broadcast);
  }

  function handleEditManagedBroadcastById(broadcastId: string) {
    const broadcast = managedBroadcasts.find((item) => item.id === broadcastId);
    if (!broadcast) {
      return;
    }

    handleEditManagedBroadcast(broadcast);
  }

  function confirmDeleteManagedBroadcast() {
    if (!managedBroadcastDeleteTarget || !chatId || cancelManagedBroadcastMutation.isPending) {
      return;
    }

    cancelManagedBroadcastMutation.mutate(managedBroadcastDeleteTarget.id);
  }

  function handleDeleteManagedAutopostRule(rule: ManagedAutopostRuleSummary) {
    setManagedAutopostRuleDeleteTarget(rule);
  }

  function confirmDeleteManagedAutopostRule() {
    if (
      !managedAutopostRuleDeleteTarget ||
      !chatId ||
      deleteManagedAutopostRuleMutation.isPending
    ) {
      return;
    }

    deleteManagedAutopostRuleMutation.mutate(managedAutopostRuleDeleteTarget.id);
  }

  function handleMailingButtonsEnabledChange(enabled: boolean) {
    if (enabled) {
      if (mailingButtons.length === 0) {
        setMailingButtonRevealSignal((current) => current + 1);
      }
      setMailingButtons((current) =>
        current.length > 0 ? current : [createEmptyBroadcastLinkButton()],
      );
      return;
    }

    setMailingButtons([]);
    setMailingButtonErrors([]);
  }

  function handleRulesButtonsEnabledChange(enabled: boolean) {
    setRulesButtonFieldsTouched(true);
    setRulesButtonErrors([]);
    if (enabled && (rulesDraft?.buttons.length ?? 0) === 0) {
      setRulesButtonRevealSignal((value) => value + 1);
    }
    setRulesDraft((current) => {
      if (!current) {
        return current;
      }

      if (!enabled) {
        return {
          ...current,
          buttons: [],
          buttonEnabled: false,
          buttonUrl: '',
          buttonText: DEFAULT_RULES_POST_BUTTON_TEXT,
        };
      }

      const buttons =
        current.buttons.length > 0 ? current.buttons : [createEmptyBroadcastLinkButton()];
      const buttonState = buildBroadcastLinkButtonLegacyFields(buttons);

      return {
        ...current,
        buttons,
        buttonEnabled: true,
        buttonUrl: buttonState.buttonUrl,
        buttonText: buttonState.buttonText,
      };
    });
  }

  function handleRulesAdminContactButtonChange(enabled: boolean) {
    if (enabled && !adminContactProfileUrl) {
      pushToast({
        tone: 'info',
        title: 'Ссылка на админа пока недоступна',
        description: 'Бот сможет добавить ссылку после события, где виден ваш профиль.',
      });
      return;
    }

    setRulesDraft((current) =>
      current
        ? {
            ...current,
            adminContactButtonEnabled: enabled,
            adminContactButtonUrl: enabled ? (adminContactProfileUrl ?? '') : '',
          }
        : current,
    );
  }

  function validateMailingButtonDraft() {
    const nextErrors = validateBroadcastLinkButtons(normalizedMailingButtons);
    setMailingButtonErrors(nextErrors);
    return !hasBroadcastLinkButtonErrors(nextErrors);
  }

  function buildMailingPublishBasePayload(): BroadcastHandoffPayload {
    const buttonState = buildBroadcastLinkButtonLegacyFields(normalizedMailingButtons);
    const scheduledSlots = sortAndUniqueBroadcastSlots(mailingScheduledSlots);
    const cycleDraft = normalizeBroadcastCycleDraft(mailingCycleDraft);
    const isCalendarSchedule = mailingTimingMode === 'scheduled';
    const isCycleSchedule = mailingTimingMode === 'cycle';
    const audiencePayload = resolveBroadcastAudiencePayload({
      targetMode: mailingTargetMode,
      targetChatIds: mailingTargetChatIds,
      currentChatId: chatId ?? undefined,
    });

    return {
      targetMode: audiencePayload.targetMode,
      targetChatIds: audiencePayload.targetChatIds,
      applyToAllChats: audiencePayload.applyToAllChats,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      scheduleMode: isCalendarSchedule ? 'calendar' : 'legacy',
      scheduleTimezone: mailingScheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      scheduledSlots: isCalendarSchedule ? scheduledSlots : [],
      sendAt: isCycleSchedule ? resolveBroadcastCycleSendAt(cycleDraft) : null,
      cycleEnabled: isCycleSchedule,
      cycleEveryHours: isCycleSchedule ? cycleDraft.everyHours : 1,
      cycleCount: isCycleSchedule ? cycleDraft.count : 1,
    };
  }

  function buildMailingTestPayload(): SendBroadcastPayload {
    const buttonState = buildBroadcastLinkButtonLegacyFields(normalizedMailingButtons);
    const videoSource = mailingVideoSource;
    const keepVideoMedia =
      !mailingVideoCleared &&
      !mailingImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;

    return {
      text: mailingText.trim(),
      textFormat: 'markdown',
      targetMode: 'current',
      targetChatIds: chatId ? [chatId] : [],
      applyToAllChats: false,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      imageEnabled: mailingImageEnabled,
      imageBase64: mailingImageEnabled ? mailingImageBase64 : '',
      imageMimeType: mailingImageEnabled ? mailingImageMimeType : '',
      imageFileName: mailingImageEnabled ? mailingImageFileName : '',
      images: mailingImageEnabled ? mailingImages : [],
      mediaType: keepVideoMedia ? 'video' : null,
      mediaPayload: keepVideoMedia ? (videoSource?.mediaPayload ?? null) : null,
      mediaMimeType: keepVideoMedia ? (videoSource?.mediaMimeType ?? '') : '',
      mediaFileName: keepVideoMedia ? (videoSource?.mediaFileName ?? '') : '',
      scheduleMode: 'legacy',
      scheduleTimezone: mailingScheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      scheduledSlots: [],
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
    };
  }

  function submitMailingPayload(broadcastId: string | null, payload: SendBroadcastPayload) {
    if (broadcastId) {
      updateManagedBroadcastMutation.mutate({
        broadcastId,
        payload,
      });
      return;
    }

    if (hasLegacyBroadcastHandoff) {
      sendBroadcastHandoffMutation.mutate(payload);
      return;
    }

    navigate(
      `/publications?compose=1&entityType=chat&entityId=${encodeURIComponent(chatId ?? '')}`,
    );
  }

  function handleCloseMailingPublishReview() {
    if (!isMailingBusy) {
      setPendingMailingPublishReview(null);
    }
  }

  function confirmMailingPublishReview() {
    if (!pendingMailingPublishReview || isMailingBusy) {
      return;
    }

    const { broadcastId, payload } = pendingMailingPublishReview;
    setPendingMailingPublishReview(null);

    const hasConflictingSlots =
      payload.scheduleMode === 'calendar' &&
      findBroadcastSlotConflicts(payload.scheduledSlots, mailingConflictOccupiedSlots).length > 0;
    if (hasConflictingSlots) {
      setPendingMailingSlotConflict({ broadcastId, payload });
      return;
    }

    submitMailingPayload(broadcastId, payload);
  }

  function handleCloseMailingSlotConflict() {
    setPendingMailingSlotConflict(null);
    setMailingScheduleError('Занято.');
  }

  function confirmMailingSlotReplacement() {
    if (!pendingMailingSlotConflict) {
      return;
    }

    const { broadcastId, payload } = pendingMailingSlotConflict;
    setPendingMailingSlotConflict(null);
    setMailingScheduleError('');
    submitMailingPayload(broadcastId, {
      ...payload,
      replaceConflictingSlots: true,
    });
  }

  function handleSaveChatAutopostRule() {
    if (!chatId || mailingAutopostDisabled) {
      return;
    }

    if (!editingManagedAutopostRule) {
      navigate(`/publications?compose=1&entityType=chat&entityId=${encodeURIComponent(chatId)}`);
      return;
    }

    const audiencePayload = resolveBroadcastAudiencePayload({
      targetMode: mailingTargetMode,
      targetChatIds: mailingTargetChatIds,
      currentChatId: chatId,
    });
    const keepVideoMedia = editingMailingHasVideo;
    const nextPayload: SendBroadcastPayload = {
      text: normalizedMailingText,
      textFormat: 'markdown',
      ...buildMailingPublishBasePayload(),
      targetMode: audiencePayload.targetMode,
      targetChatIds: audiencePayload.targetChatIds,
      applyToAllChats: audiencePayload.applyToAllChats,
      replaceConflictingSlots: false,
      imageEnabled: mailingImageEnabled,
      imageBase64: mailingImageEnabled ? mailingImageBase64 : '',
      imageMimeType: mailingImageEnabled ? mailingImageMimeType : '',
      imageFileName: mailingImageEnabled ? mailingImageFileName : '',
      images: mailingImageEnabled ? mailingImages : [],
      mediaType: keepVideoMedia ? 'video' : null,
      mediaPayload: keepVideoMedia ? (mailingVideoSource?.mediaPayload ?? null) : null,
      mediaMimeType: keepVideoMedia ? (mailingVideoSource?.mediaMimeType ?? '') : '',
      mediaFileName: keepVideoMedia ? (mailingVideoSource?.mediaFileName ?? '') : '',
      scheduleMode: 'calendar',
      scheduledSlots: sortAndUniqueBroadcastSlots(mailingScheduledSlots),
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
    };

    updateManagedAutopostRuleMutation.mutate({
      ruleId: editingManagedAutopostRule.id,
      payload: nextPayload,
    });
  }

  function handleSendBroadcast() {
    if (!chatId) {
      return;
    }

    if (!editingManagedBroadcast && !hasLegacyBroadcastHandoff) {
      navigate(`/publications?compose=1&entityType=chat&entityId=${encodeURIComponent(chatId)}`);
      return;
    }

    const normalizedText = mailingText.trim();
    const scheduledSlots = sortAndUniqueBroadcastSlots(mailingScheduledSlots);
    const cycleDraft = normalizeBroadcastCycleDraft(mailingCycleDraft);
    const cycleError =
      mailingTimingMode === 'cycle'
        ? getBroadcastCycleValidationError(cycleDraft, Date.now())
        : null;
    const audiencePayload = resolveBroadcastAudiencePayload({
      targetMode: mailingTargetMode,
      targetChatIds: mailingTargetChatIds,
      currentChatId: chatId,
    });

    let hasError = false;
    const videoSource = mailingVideoSource;
    const keepVideoMedia =
      !mailingVideoCleared &&
      !mailingImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;
    const mailingImagesReady = areBroadcastImagesReady(mailingImages);
    const hasDirectContent = Boolean(normalizedText || mailingImageEnabled || keepVideoMedia);
    if (editingManagedBroadcast) {
      if (!normalizedText && !mailingImageEnabled && !keepVideoMedia) {
        setMailingTextError('В сохранённом автопостинге нет текста, фото или видео.');
        hasError = true;
      } else if (normalizedText.length > MAX_BROADCAST_TEXT_LENGTH) {
        setMailingTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
        hasError = true;
      } else {
        setMailingTextError('');
      }

      if (mailingImageEnabled) {
        if (mailingImagesPreparing) {
          setMailingImageError('Фото ещё готовится.');
          hasError = true;
        } else if (!mailingImagesReady) {
          setMailingImageError('В сохранённом автопостинге отсутствует фото.');
          hasError = true;
        } else {
          setMailingImageError('');
        }
      } else {
        setMailingImageError('');
      }
    } else {
      if (!hasDirectContent) {
        setMailingTextError('Добавьте текст, фото или видео.');
        hasError = true;
      } else if (normalizedText.length > MAX_BROADCAST_TEXT_LENGTH) {
        setMailingTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
        hasError = true;
      } else {
        setMailingTextError('');
      }

      if (mailingImageEnabled) {
        if (mailingImagesPreparing) {
          setMailingImageError('Фото ещё готовится.');
          hasError = true;
        } else if (!mailingImagesReady) {
          setMailingImageError('Фото не готово.');
          hasError = true;
        } else {
          setMailingImageError('');
        }
      } else {
        setMailingImageError('');
      }
    }

    if (!validateMailingButtonDraft()) {
      hasError = true;
    }

    if (audiencePayload.targetMode === 'selected' && audiencePayload.targetChatIds.length === 0) {
      setMailingAudienceError('Выберите хотя бы один чат.');
      hasError = true;
    } else {
      setMailingAudienceError('');
    }

    if (mailingTimingMode === 'scheduled' && scheduledSlots.length === 0) {
      setMailingScheduleError('Добавьте время.');
      hasError = true;
    } else if (mailingTimingMode === 'scheduled' && mailingPlannerState.hasBlockingIssue) {
      setMailingScheduleError('Проверьте время.');
      hasError = true;
    } else if (mailingTimingMode === 'scheduled' && mailingPlannerState.futureSlotCount === 0) {
      setMailingScheduleError('Есть прошедшее время.');
      hasError = true;
    } else if (mailingTimingMode === 'cycle' && cycleError) {
      setMailingCycleError(cycleError);
      hasError = true;
    } else {
      setMailingScheduleError('');
      setMailingCycleError('');
    }

    if (hasError) {
      return;
    }

    const publishBasePayload = {
      ...buildMailingPublishBasePayload(),
      targetMode: audiencePayload.targetMode,
      targetChatIds: audiencePayload.targetChatIds,
      applyToAllChats: audiencePayload.applyToAllChats,
      replaceConflictingSlots: false,
    };

    const payload: SendBroadcastPayload = {
      text: normalizedText,
      textFormat: 'markdown',
      ...publishBasePayload,
      requestId: createBroadcastRequestId(),
      imageEnabled: mailingImageEnabled,
      imageBase64: mailingImageEnabled ? mailingImageBase64 : '',
      imageMimeType: mailingImageEnabled ? mailingImageMimeType : '',
      imageFileName: mailingImageEnabled ? mailingImageFileName : '',
      images: mailingImageEnabled ? mailingImages : [],
      mediaType: keepVideoMedia ? 'video' : null,
      mediaPayload: keepVideoMedia ? (videoSource?.mediaPayload ?? null) : null,
      mediaMimeType: keepVideoMedia ? (videoSource?.mediaMimeType ?? '') : '',
      mediaFileName: keepVideoMedia ? (videoSource?.mediaFileName ?? '') : '',
    };

    setPendingMailingPublishReview({
      broadcastId: editingManagedBroadcast?.id ?? null,
      payload,
    });
  }

  function handleSendBroadcastTest() {
    if (!chatId || sendBroadcastTestMutation.isPending) {
      return;
    }

    const normalizedText = mailingText.trim();
    const videoSource = mailingVideoSource;
    const keepVideoMedia =
      !mailingVideoCleared &&
      !mailingImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;
    const mailingImagesReady = areBroadcastImagesReady(mailingImages);
    let hasError = false;

    if (!normalizedText && !mailingImageEnabled && !keepVideoMedia) {
      setMailingTextError('Добавьте текст, фото или видео.');
      hasError = true;
    } else if (normalizedText.length > MAX_BROADCAST_TEXT_LENGTH) {
      setMailingTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
      hasError = true;
    } else {
      setMailingTextError('');
    }

    if (mailingImageEnabled) {
      if (mailingImagesPreparing) {
        setMailingImageError('Фото ещё готовится.');
        hasError = true;
      } else if (!mailingImagesReady) {
        setMailingImageError('Фото не готово.');
        hasError = true;
      } else {
        setMailingImageError('');
      }
    } else {
      setMailingImageError('');
    }

    if (!validateMailingButtonDraft()) {
      hasError = true;
    }

    if (hasError) {
      return;
    }

    sendBroadcastTestMutation.mutate(buildMailingTestPayload());
  }

  function handleCommercialSensitivitySliderChange(rawValue: number) {
    if (!draft) {
      return;
    }

    const config = resolveCommercialSensitivityConfig(rawValue);
    setFieldValue('commercialAdsSensitivity', config.sensitivity);
    setFieldValue('commercialAdsWarnThreshold', config.warnThreshold);
    setFieldValue('commercialAdsDeleteThreshold', config.deleteThreshold);
  }

  function toggleHint(key: HintKey) {
    setOpenHintKey((current) => (current === key ? null : key));
  }

  function toggleMuteDurationEditor(key: AutoMuteDurationKey) {
    setOpenMuteDurationKey((current) => (current === key ? null : key));
  }

  function renderInlineHint(hintKey: HintKey, hintId: string, text: string, hidden = false) {
    if (hidden || openHintKey !== hintKey) {
      return null;
    }

    return (
      <p id={hintId} className="settings-native-toggle__hint settings-native-toggle__hint--inline">
        {text}
      </p>
    );
  }

  function renderMuteDurationEditor(key: AutoMuteDurationKey, label: string) {
    if (!draft || openMuteDurationKey !== key) {
      return null;
    }

    const value = Number(draft[key]);

    return (
      <div id={`mute-duration-${key}`} className="settings-duration-editor">
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <ClockIcon />
            <span className="settings-native-toggle__title">{label}</span>
          </div>
          <output className="ban-duration-stepper__value" aria-live="polite">
            {formatMuteDurationCompact(value)}
          </output>
        </div>

        <div className="settings-duration-editor__presets">
          {AUTO_MUTE_DURATION_PRESET_HOURS.map((hours) => (
            <button
              key={hours}
              type="button"
              className={cn('settings-duration-editor__preset', value === hours && 'is-active')}
              onClick={() => setMuteDurationValue(key, hours)}
            >
              {formatMuteDurationCompact(hours)}
            </button>
          ))}
        </div>

        <div className="settings-duration-editor__controls">
          <div className="ban-duration-stepper">
            <button
              type="button"
              className="ban-duration-stepper__button"
              onClick={() => adjustMuteDuration(key, -1)}
              disabled={value <= AUTO_MUTE_DURATION_MIN_HOURS}
            >
              -
            </button>
            <output className="ban-duration-stepper__value" aria-live="polite">
              {value}ч
            </output>
            <button
              type="button"
              className="ban-duration-stepper__button"
              onClick={() => adjustMuteDuration(key, 1)}
              disabled={value >= AUTO_MUTE_DURATION_MAX_HOURS}
            >
              +
            </button>
          </div>

          <label className="settings-duration-editor__hours-input">
            <span>Часы</span>
            <input
              type="number"
              min={AUTO_MUTE_DURATION_MIN_HOURS}
              max={AUTO_MUTE_DURATION_MAX_HOURS}
              step={1}
              value={value}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (!Number.isFinite(nextValue)) {
                  return;
                }

                setMuteDurationValue(key, nextValue);
              }}
            />
            <small>
              {AUTO_MUTE_DURATION_MIN_HOURS}–{AUTO_MUTE_DURATION_MAX_HOURS}ч
            </small>
          </label>
        </div>
      </div>
    );
  }

  function renderMuteStageToggle(params: {
    enabledKey: AutoMuteEnabledKey;
    durationKey: AutoMuteDurationKey;
    title: string;
    onEnable: () => void;
  }) {
    if (!draft) {
      return null;
    }

    const enabled = draft[params.enabledKey];
    const durationValue = Number(draft[params.durationKey]);
    const isOpen = openMuteDurationKey === params.durationKey;
    const error = fieldErrors[params.durationKey];

    return (
      <div
        className={cn(
          'settings-native-toggle',
          'settings-native-toggle--nested',
          error && 'field--error',
        )}
      >
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">{params.title}</span>
            <div className="settings-native-toggle__title-actions">
              <button
                type="button"
                className={cn(
                  'settings-duration-editor__preset settings-duration-editor__preset--trigger',
                  isOpen && 'is-active',
                )}
                onClick={() => toggleMuteDurationEditor(params.durationKey)}
              >
                <ClockIcon />
                <span>{formatMuteDurationCompact(durationValue)}</span>
              </button>
            </div>
          </div>

          <label className="settings-native-switch" aria-label={params.title}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                const nextEnabled = event.target.checked;
                setFieldValue(params.enabledKey, nextEnabled as ChatSettings[AutoMuteEnabledKey]);
                if (nextEnabled) {
                  params.onEnable();
                }
              }}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {renderMuteDurationEditor(params.durationKey, 'Срок мута')}

        {error ? <small className="field__hint">{error}</small> : null}
      </div>
    );
  }

  function renderEscalationTuning(params: {
    title: string;
    ariaLabelPrefix: string;
    windowKey: Extract<NumericChatSettingKey, `${string}EscalationWindowHours`>;
    warnKey: Extract<NumericChatSettingKey, `${string}WarnMaxCount`>;
    muteKey: Extract<NumericChatSettingKey, `${string}MuteMaxCount`>;
    banKey: Extract<NumericChatSettingKey, `${string}BanMaxCount`>;
  }) {
    if (!draft) {
      return null;
    }

    const fields: Array<{
      key: NumericChatSettingKey;
      label: string;
      suffix: string;
      min: number;
      max: number;
    }> = [
      {
        key: params.windowKey,
        label: 'Окно',
        suffix: 'ч',
        min: 1,
        max: 168,
      },
      {
        key: params.warnKey,
        label: 'Предупреждение',
        suffix: 'раз',
        min: 1,
        max: 20,
      },
      {
        key: params.muteKey,
        label: 'Мут',
        suffix: 'раз',
        min: 1,
        max: 20,
      },
      {
        key: params.banKey,
        label: 'Бан',
        suffix: 'раз',
        min: 1,
        max: 20,
      },
    ];
    const errors = fields
      .map((field) => fieldErrors[field.key])
      .filter((error): error is string => Boolean(error));

    return (
      <article className={cn('duplicate-stage', errors.length > 0 && 'field--error')}>
        <div className="duplicate-stage__top">
          <span className="duplicate-stage__title">{params.title}</span>
        </div>

        <div className="duplicate-stage__controls">
          {fields.map((field) => (
            <label
              key={field.key}
              className={cn('duplicate-stage__field', fieldErrors[field.key] && 'field--error')}
            >
              <span className="duplicate-stage__field-label">{field.label}</span>
              <div className="duplicate-stage__input-wrap">
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={1}
                  value={Number(draft[field.key])}
                  onChange={(event) =>
                    setIntegerChatFieldValue(field.key, event.target.value, field.min, field.max)
                  }
                  aria-label={`${params.ariaLabelPrefix}: ${field.label.toLowerCase()}`}
                />
                <span className="duplicate-stage__suffix" aria-hidden>
                  {field.suffix}
                </span>
              </div>
            </label>
          ))}
        </div>

        {errors.length > 0 ? (
          <div className="duplicate-stage__errors">
            {errors.map((error) => (
              <small key={error} className="field__hint">
                {error}
              </small>
            ))}
          </div>
        ) : null}
      </article>
    );
  }

  function toggleBotMessageEditor(key: BotMessageEditorKey) {
    setOpenWarnEditorKey(null);
    setOpenBotEditorKey((current) => (current === key ? null : key));
  }

  function toggleWarnMessageEditor(key: WarnMessageEditorKey) {
    setOpenBotEditorKey(null);
    setOpenWarnEditorKey((current) => (current === key ? null : key));
  }

  function closeSection(section: SettingsSectionKey) {
    const legacyReturnPath = resolveLegacyPublicationReturnPath(location.state);
    if (section === 'mailing' && legacyEditorTarget && legacyReturnPath) {
      navigate(-1);
      return;
    }
    if (
      (section === 'mailing' && focusSection === 'broadcast') ||
      (section === 'giveaway' && focusSection === 'giveaway') ||
      (section === 'vkParsing' && focusSection === 'vkParsing') ||
      (section === 'requiredSubscription' && focusSection === 'requiredSubscription')
    ) {
      const nextSearchParams = new URLSearchParams(location.search);
      ['focus', 'handoff', 'workspace', 'legacyKind', 'legacyId'].forEach((key) =>
        nextSearchParams.delete(key),
      );
      navigate(
        {
          pathname: location.pathname,
          search: nextSearchParams.toString() ? `?${nextSearchParams.toString()}` : '',
        },
        { replace: true, state: location.state },
      );
    }

    setExpandedSections((current) => (current[section] ? INITIAL_EXPANDED_SECTIONS : current));
  }

  function toggleSection(section: SettingsSectionKey) {
    if (expandedSections[section]) {
      closeSection(section);
      return;
    }

    startTransition(() => {
      setExpandedSections({ ...INITIAL_EXPANDED_SECTIONS, [section]: true });
    });
  }

  if (!chatId) {
    return (
      <GlassCard>
        <StatusState
          tone="warning"
          title="Чат не выбран"
          description="Откройте экран настроек из карточки чата."
          action={
            <Link to={buildManagedEntitiesRoute('chat')} className="button button--accent">
              К списку чатов
            </Link>
          }
        />
      </GlassCard>
    );
  }

  const linkPolicyError = fieldErrors.linkPolicy;
  const requiredSubscriptionChannelsError = fieldErrors.requiredSubscriptionChannelIds;
  const allowlistEntries: DomainAllowlistEntry[] = domainsQuery.data ?? [];
  const isDomainMutationPending =
    addDomainMutation.isPending ||
    removeDomainMutation.isPending ||
    scheduleDomainRemovalMutation.isPending;
  const isAllowlistMode = draft?.linkPolicy === 'ALLOWLIST_ONLY';
  const shouldShowLinkStages = draft?.linkPolicy !== 'ALERT_ONLY';
  const showLinkBotButtonErrors = Boolean(
    draft?.linkBotMessageEnabled && draft?.linkBotButtonEnabled,
  );
  const linkBotButtonErrors =
    showLinkBotButtonErrors && fieldErrors.linkBotButtons
      ? validateBroadcastLinkButtons(draft?.linkBotButtons ?? [])
      : [];
  const hasLinkBotButtonError = Boolean(fieldErrors.linkBotButtons);
  const showGreetingBotButtonErrors = Boolean(
    draft?.greetingEnabled && draft?.greetingBotMessageEnabled && draft?.greetingBotButtonEnabled,
  );
  const greetingBotButtonErrors =
    showGreetingBotButtonErrors && fieldErrors.greetingBotButtons
      ? validateBroadcastLinkButtons(draft?.greetingBotButtons ?? [])
      : [];
  const hasGreetingBotButtonError = Boolean(fieldErrors.greetingBotButtons);
  const showDuplicateBotButtonErrors = Boolean(
    draft?.duplicateBotMessageEnabled && draft?.duplicateBotButtonEnabled,
  );
  const duplicateBotButtonErrors =
    showDuplicateBotButtonErrors && fieldErrors.duplicateBotButtons
      ? validateBroadcastLinkButtons(draft?.duplicateBotButtons ?? [])
      : [];
  const hasDuplicateBotButtonError = Boolean(fieldErrors.duplicateBotButtons);
  const showMessageLimitsBotButtonErrors = Boolean(
    draft?.messageLimitsBotMessageEnabled && draft?.messageLimitsBotButtonEnabled,
  );
  const messageLimitsBlockedWords = draft?.messageLimitsBlockedWords ?? [];
  const messageLimitsBlockedDomains = draft?.messageLimitsBlockedDomains ?? [];
  const messageLimitsBlockedWordsError = fieldErrors.messageLimitsBlockedWords;
  const messageLimitsBlockedDomainsError = fieldErrors.messageLimitsBlockedDomains;
  const messageLimitsBlockedWordsInputActions = splitMessageLimitsBlockedWordsInput(
    messageLimitsBlockedWordsInput,
  );
  const messageLimitsBlockedDomainsInputActions = splitMessageLimitsBlockedDomainsInput(
    messageLimitsBlockedDomainsInput,
  );
  const hasMessageLimitsBlockedWordsRemoveInputActions = messageLimitsBlockedWordsInputActions.some(
    (action) => action.operation === 'remove',
  );
  const hasMessageLimitsBlockedDomainsRemoveInputActions =
    messageLimitsBlockedDomainsInputActions.some((action) => action.operation === 'remove');
  const messageLimitsBlockedWordsRemaining = Math.max(
    0,
    MESSAGE_LIMITS_BLOCKED_WORDS_MAX - messageLimitsBlockedWords.length,
  );
  const isMessageLimitsBlockedWordsApplyDisabled =
    !messageLimitsBlockedWordsInput.trim() ||
    (messageLimitsBlockedWords.length >= MESSAGE_LIMITS_BLOCKED_WORDS_MAX &&
      messageLimitsBlockedWordsInputActions.length > 0 &&
      !hasMessageLimitsBlockedWordsRemoveInputActions);
  const isMessageLimitsBlockedDomainsApplyDisabled =
    !messageLimitsBlockedDomainsInput.trim() ||
    (messageLimitsBlockedDomains.length >= MESSAGE_LIMITS_BLOCKED_DOMAINS_MAX &&
      messageLimitsBlockedDomainsInputActions.length > 0 &&
      !hasMessageLimitsBlockedDomainsRemoveInputActions);
  const hasMessageLimitsBlockedWordsOverflow =
    messageLimitsBlockedWords.length > MESSAGE_LIMITS_BLOCKED_WORDS_PREVIEW_COUNT;
  const hasMessageLimitsBlockedDomainsOverflow =
    messageLimitsBlockedDomains.length > MESSAGE_LIMITS_BLOCKED_WORDS_PREVIEW_COUNT;
  const visibleMessageLimitsBlockedWords =
    hasMessageLimitsBlockedWordsOverflow && !messageLimitsBlockedWordsExpanded
      ? messageLimitsBlockedWords.slice(-MESSAGE_LIMITS_BLOCKED_WORDS_PREVIEW_COUNT)
      : messageLimitsBlockedWords;
  const visibleMessageLimitsBlockedDomains =
    hasMessageLimitsBlockedDomainsOverflow && !messageLimitsBlockedDomainsExpanded
      ? messageLimitsBlockedDomains.slice(-MESSAGE_LIMITS_BLOCKED_WORDS_PREVIEW_COUNT)
      : messageLimitsBlockedDomains;
  const messageLimitsBlockedWordsCaption =
    hasMessageLimitsBlockedWordsOverflow && !messageLimitsBlockedWordsExpanded
      ? `Показаны последние ${visibleMessageLimitsBlockedWords.length} из ${formatRussianCountLabel(messageLimitsBlockedWords.length, 'слова', 'слов', 'слов')}`
      : `Все ${formatRussianCountLabel(messageLimitsBlockedWords.length, 'слово', 'слова', 'слов')}`;
  const messageLimitsBlockedDomainsCaption =
    hasMessageLimitsBlockedDomainsOverflow && !messageLimitsBlockedDomainsExpanded
      ? `Показаны последние ${visibleMessageLimitsBlockedDomains.length} из ${formatRussianCountLabel(messageLimitsBlockedDomains.length, 'домена', 'доменов', 'доменов')}`
      : `Все ${formatRussianCountLabel(messageLimitsBlockedDomains.length, 'домен', 'домена', 'доменов')}`;
  const stopWordsError =
    stopWordsMode === 'words' ? messageLimitsBlockedWordsError : messageLimitsBlockedDomainsError;
  const stopWordsTotalCount = messageLimitsBlockedWords.length + messageLimitsBlockedDomains.length;
  const stopWordsSegmentOptions = useMemo<Array<SegmentedOption<StopWordsMode>>>(
    () => [
      { value: 'words', label: 'Слова', count: messageLimitsBlockedWords.length },
      { value: 'domains', label: 'Домены', count: messageLimitsBlockedDomains.length },
    ],
    [messageLimitsBlockedDomains.length, messageLimitsBlockedWords.length],
  );
  const messageLimitsBotButtonErrors =
    showMessageLimitsBotButtonErrors && fieldErrors.messageLimitsBotButtons
      ? validateBroadcastLinkButtons(draft?.messageLimitsBotButtons ?? [])
      : [];
  const hasMessageLimitsBotButtonError = Boolean(fieldErrors.messageLimitsBotButtons);

  useEffect(() => {
    if (!hasMessageLimitsBlockedWordsOverflow && messageLimitsBlockedWordsExpanded) {
      setMessageLimitsBlockedWordsExpanded(false);
    }
  }, [hasMessageLimitsBlockedWordsOverflow, messageLimitsBlockedWordsExpanded]);

  useEffect(() => {
    if (!hasMessageLimitsBlockedDomainsOverflow && messageLimitsBlockedDomainsExpanded) {
      setMessageLimitsBlockedDomainsExpanded(false);
    }
  }, [hasMessageLimitsBlockedDomainsOverflow, messageLimitsBlockedDomainsExpanded]);
  const showTextFiltersBotButtonErrors = Boolean(
    draft?.textFiltersBotMessageEnabled && draft?.textFiltersBotButtonEnabled,
  );
  const textFiltersBotButtonErrors =
    showTextFiltersBotButtonErrors && fieldErrors.textFiltersBotButtons
      ? validateBroadcastLinkButtons(draft?.textFiltersBotButtons ?? [])
      : [];
  const hasTextFiltersBotButtonError = Boolean(fieldErrors.textFiltersBotButtons);
  const showNightBotButtonErrors = Boolean(
    draft?.nightModeBotMessageEnabled && draft?.nightModeBotButtonEnabled,
  );
  const nightBotButtonErrors =
    showNightBotButtonErrors && fieldErrors.nightModeBotButtons
      ? validateBroadcastLinkButtons(draft?.nightModeBotButtons ?? [])
      : [];
  const hasNightBotButtonError = Boolean(fieldErrors.nightModeBotButtons);
  const nightTimezoneError = fieldErrors.nightModeTimezone;
  const showNightForceCloseDurationErrors = Boolean(
    draft?.nightModeForceCloseEnabled && !draft?.nightModeForceCloseForever,
  );
  const nightForceCloseHoursError = showNightForceCloseDurationErrors
    ? fieldErrors.nightModeForceCloseHours
    : undefined;
  const nightForceCloseDaysError = showNightForceCloseDurationErrors
    ? fieldErrors.nightModeForceCloseDays
    : undefined;
  const hasNightForceCloseDurationError = Boolean(
    nightForceCloseHoursError || nightForceCloseDaysError,
  );
  const linkStagesEnabledCount = [
    draft?.linkBotMessageEnabled,
    draft?.linkWarnEnabled,
    draft?.linkBanEnabled,
    draft?.linkMuteEnabled,
  ].filter(Boolean).length;
  const linksHeaderSummary =
    draft?.linkPolicy === 'ALERT_ONLY'
      ? 'Ссылки не удаляются'
      : draft?.linkPolicy === 'ALLOWLIST_ONLY'
        ? `Не удалять: ${allowlistEntries.length}`
        : `${linkStagesEnabledCount}/4 ступени включено`;
  const linksCardStatus =
    draft?.linkPolicy === 'ALERT_ONLY'
      ? 'Без удаления'
      : draft?.linkPolicy === 'ALLOWLIST_ONLY'
        ? allowlistEntries.length > 0
          ? `${allowlistEntries.length}`
          : 'Белый список'
        : `${linkStagesEnabledCount}/4`;
  const allowlistCountLabel =
    allowlistEntries.length === 1
      ? '1 правило'
      : `${allowlistEntries.length} ${allowlistEntries.length < 5 ? 'правила' : 'правил'}`;
  const allowlistComposerExamples =
    domainInputMode === 'DOMAIN'
      ? [
          { label: 'example.com', value: 'example.com' },
          { label: 'docs.max.ru', value: 'docs.max.ru' },
        ]
      : [
          {
            label: 'https://example.com/path',
            value: 'https://example.com/path',
          },
          {
            label: 'https://docs.max.ru/',
            value: 'https://docs.max.ru/',
          },
        ];
  const rulesPublishedAtLabel = formatRemovalDateTime(
    rulesDraft?.publishedAt ?? rulesQuery.data?.publishedAt ?? null,
  );
  const rulesHeaderSummary = hasPublishedRules
    ? rulesPublishedAtLabel
      ? `Опубликовано · ${rulesPublishedAtLabel}`
      : 'Опубликовано'
    : rulesDraft?.text.trim()
      ? `Черновик · ${rulesDraft.text.trim().length}/${MAX_CHAT_RULES_TEXT_LENGTH}`
      : rulesDraft?.autoTextEnabled
        ? 'Автотекст'
        : 'Не настроено';
  const rulesCardStatus = hasPublishedRules
    ? 'Пост'
    : rulesDraft?.text.trim()
      ? 'Черновик'
      : rulesDraft?.autoTextEnabled
        ? 'Авто'
        : 'Пусто';
  const normalizedRulesText = rulesDraft?.text.trim() ?? '';
  const normalizedRulesButtons = trimBroadcastLinkButtons(rulesDraft?.buttons ?? []);
  const rulesButtonEnabled = Boolean(rulesDraft?.buttonEnabled);
  const rulesButtonDraftValid =
    !rulesButtonEnabled ||
    !hasBroadcastLinkButtonErrors(validateBroadcastLinkButtons(normalizedRulesButtons));
  const rulesHasImage = Boolean(rulesDraft?.imageBase64 && rulesDraft?.imageMimeType);
  const rulesImageReady = !rulesDraft?.imageBase64 || rulesHasImage;
  const rulesHasPublishableContent = Boolean(normalizedRulesText || rulesDraft?.autoTextEnabled);
  const rulesPublishIssueLabels = [
    !rulesHasPublishableContent ? 'Текст' : null,
    !rulesImageReady ? 'Фото' : null,
    !rulesButtonDraftValid ? 'Кнопки' : null,
  ].filter((item): item is string => Boolean(item));
  const rulesPublishReady = Boolean(
    rulesDraft && rulesHasPublishableContent && rulesImageReady && rulesButtonDraftValid,
  );
  const rulesButtonStatus = rulesButtonEnabled
    ? formatBroadcastButtonsStatus(normalizedRulesButtons)
    : 'Без кнопок';
  const rulesAutoFillSummary = rulesDraft?.autoTextEnabled ? 'Включено' : 'Выключено';
  const rulesViolationButtonSummary = draft?.rulesAttachViolationsEnabled
    ? 'Включена'
    : 'Выключена';
  const rulesFooterTitle =
    rulesPublishIssueLabels.length > 0
      ? `Нужно: ${rulesPublishIssueLabels.join(' · ')}`
      : hasPublishedRules
        ? 'Переиздать правила'
        : 'Опубликовать правила';
  const rulesFooterMeta = [
    normalizedRulesText ? `${normalizedRulesText.length}/${MAX_CHAT_RULES_TEXT_LENGTH}` : null,
    rulesDraft?.autoTextEnabled ? 'Авто' : null,
    rulesHasImage ? 'Фото' : null,
    rulesButtonEnabled ? rulesButtonStatus : null,
    rulesDraft?.adminContactButtonEnabled ? ADMIN_CONTACT_BUTTON_TEXT : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const rulesStudioReadyCount = [
    rulesHasPublishableContent,
    rulesImageReady,
    rulesButtonDraftValid,
    hasPublishedRules,
  ].filter(Boolean).length;
  const rulesStudioSignals: BroadcastStudioSignal[] = [
    {
      label: 'Текст',
      value: rulesDraft?.autoTextEnabled
        ? 'Авто'
        : normalizedRulesText
          ? `${normalizedRulesText.length}/2000`
          : 'Пусто',
      tone: rulesHasPublishableContent ? 'ready' : 'pending',
      icon: 'content',
    },
    {
      label: 'Фото',
      value: rulesHasImage ? 'Есть' : 'Нет',
      tone: rulesHasImage ? 'ready' : rulesImageReady ? 'neutral' : 'danger',
      icon: 'content',
    },
    {
      label: 'Кнопки',
      value: rulesButtonStatus,
      tone: rulesButtonDraftValid ? (rulesButtonEnabled ? 'ready' : 'neutral') : 'danger',
      icon: 'button',
    },
    {
      label: 'Публикация',
      value: hasPublishedRules ? 'Есть' : 'Черновик',
      tone: hasPublishedRules ? 'ready' : 'pending',
      icon: 'channel',
    },
  ];
  const rulesStudioSubtitle =
    rulesFooterMeta ||
    (hasPublishedRules && rulesPublishedAtLabel ? rulesPublishedAtLabel : 'Черновик');
  const rulesAdminContactButtonSummary = rulesDraft?.adminContactButtonEnabled
    ? 'Включено'
    : 'Выключено';
  const isRulesBusy =
    isSavingRules ||
    isPublishingRules ||
    isResettingPublishedRules ||
    updateRulesAttachMutation.isPending;
  const rulesDrilldownFooter = rulesDraft ? (
    <div
      className={cn(
        'broadcast-publish-bar rules-publish-bar',
        hasPublishedRules && 'rules-publish-bar--with-reset',
      )}
    >
      <div className="broadcast-publish-bar__copy">
        <strong>{rulesFooterTitle}</strong>
        <small>{rulesFooterMeta || 'Черновик'}</small>
        {rulesPublishIssueLabels.length > 0 && !isRulesBusy ? (
          <span className="broadcast-publish-bar__issues" aria-label="Не готово">
            {rulesPublishIssueLabels.map((label) => (
              <span key={`rules-publish-issue-${label}`}>{label}</span>
            ))}
          </span>
        ) : null}
      </div>

      {rulesPublishedUrl ? (
        <button
          type="button"
          className="button button--ghost broadcast-publish-bar__test"
          onClick={(event) => handleManagedPostLinkClick(event, rulesPublishedUrl)}
        >
          <span>Пост</span>
        </button>
      ) : null}

      {hasPublishedRules ? (
        <button
          type="button"
          className="button button--ghost broadcast-publish-bar__test rules-publish-bar__reset"
          onClick={handleResetPublishedRules}
          disabled={isResettingPublishedRules}
          aria-label="Сбросить публикацию"
          title="Сбросить публикацию"
        >
          <ResetIcon />
        </button>
      ) : null}

      <button
        type="button"
        className="button button--accent broadcast-publish-bar__button broadcast-publish-bar__primary"
        onClick={() => void handlePublishRules()}
        disabled={isRulesBusy || !rulesPublishReady}
      >
        <span>
          {isPublishingRules
            ? 'Публикуем...'
            : isSavingRules
              ? 'Сохраняем...'
              : hasPublishedRules
                ? 'Переиздать'
                : 'Опубликовать'}
        </span>
      </button>
    </div>
  ) : null;
  const greetingHeaderSummary = draft?.greetingEnabled
    ? draft?.greetingBotMessageEnabled
      ? draft?.greetingBotButtonEnabled || draft?.greetingRulesButtonEnabled
        ? 'Сообщение + кнопки'
        : 'Только сообщение'
      : 'Сообщение выключено'
    : 'Выключено';
  const greetingCardStatus = draft?.greetingEnabled ? 'Вкл' : 'Выкл';
  const duplicateAllowedCount = draft ? resolveDuplicateAllowedCount(draft) : 1;
  const duplicateSharedWindowHours = draft
    ? secondsToHours(resolveDuplicateSharedWindowSec(draft))
    : 12;
  const duplicateStagesEnabledCount = [
    draft?.duplicateBotMessageEnabled,
    draft?.duplicateWarnEnabled,
    draft?.duplicateMuteEnabled,
    draft?.duplicateBanEnabled,
  ].filter(Boolean).length;
  const duplicateDetectionLabel = draft
    ? DUPLICATE_DETECTION_LABELS[draft.duplicateDetectionPreset]
    : DUPLICATE_DETECTION_LABELS.STANDARD;
  const duplicatesHeaderSummary = draft?.antiDuplicateEnabled
    ? `${duplicateDetectionLabel} • ${formatDuplicateAllowanceLabel(
        duplicateAllowedCount,
      )} • ${duplicateSharedWindowHours}ч • ${duplicateStagesEnabledCount}/4 этапа`
    : 'Выключено';
  const duplicatesCardStatus = draft?.antiDuplicateEnabled ? duplicateDetectionLabel : 'Выкл';
  const profanityStagesEnabledCount = draft?.russianProfanityFilterEnabled
    ? [
        draft?.profanityBotMessageEnabled,
        draft?.profanityWarnEnabled,
        draft?.profanityBanEnabled,
        draft?.profanityMuteEnabled,
      ].filter(Boolean).length
    : 0;
  const textFiltersStagesEnabledCount = draft?.commercialAdsFilterEnabled
    ? [
        draft?.textFiltersBotMessageEnabled,
        draft?.textFiltersWarnEnabled,
        draft?.textFiltersBanEnabled,
        draft?.textFiltersMuteEnabled,
      ].filter(Boolean).length
    : 0;
  const commercialSensitivitySliderValue = draft
    ? inferCommercialSensitivitySliderValue(draft)
    : 50;
  const commercialSensitivityLabel = getCommercialSensitivityLabel(
    commercialSensitivitySliderValue,
  );
  const limitsRulesEnabledCount = [
    draft?.antiSpamEnabled,
    draft?.deleteSpammersEnabled,
    draft?.messageCountLimitEnabled,
    draft?.maxMessageLengthEnabled,
    draft?.photoMessageCooldownEnabled,
    draft?.stickerMessageCooldownEnabled,
    draft ? !draft.photoMessagesEnabled : false,
    draft ? !draft.videoMessagesEnabled : false,
    draft ? !draft.fileMessagesEnabled : false,
    draft ? !draft.voiceMessagesEnabled : false,
    draft ? !draft.phoneNumbersEnabled : false,
  ].filter(Boolean).length;
  const limitsCardStatus = limitsRulesEnabledCount > 0 ? `${limitsRulesEnabledCount}` : 'Выкл';
  const stopWordsHeaderSummary =
    stopWordsTotalCount > 0
      ? `Слова: ${messageLimitsBlockedWords.length} · Домены: ${messageLimitsBlockedDomains.length}`
      : 'Список пуст';
  const stopWordsCardStatus = stopWordsTotalCount > 0 ? `${stopWordsTotalCount}` : 'Выкл';
  const nightTimezoneLabel =
    RUSSIAN_TIMEZONE_OPTIONS.find((option) => option.value === draft?.nightModeTimezone)?.label ??
    'Москва (UTC+3)';
  const nightWindowLabel = draft
    ? `${minutesToTimeInput(draft.nightModeStartTimeMinutes)}-${minutesToTimeInput(
        draft.nightModeEndTimeMinutes,
      )}`
    : '23:00-08:00';
  const nightForceCloseSummary = draft?.nightModeForceCloseEnabled
    ? draft.nightModeForceCloseForever
      ? 'Группа закрыта вручную бессрочно'
      : `Группа закрыта вручную на ${formatNightForceCloseDuration(
          draft.nightModeForceCloseDays,
          draft.nightModeForceCloseHours,
        )}`
    : null;
  const nightHeaderSummary = nightForceCloseSummary
    ? nightForceCloseSummary
    : draft?.nightModeEnabled
      ? `${nightWindowLabel} • ${nightTimezoneLabel}`
      : 'Выключено';
  const nightCardStatus = draft?.nightModeEnabled
    ? nightForceCloseSummary
      ? 'Закрыто'
      : nightWindowLabel
    : 'Выкл';
  const requiredSubscriptionSelectedCount = draft?.requiredSubscriptionChannelIds.length ?? 0;
  const requiredSubscriptionStaleCount = selectedUnavailableRequiredSubscriptionChannels.length;
  const requiredSubscriptionUnavailableCount =
    unavailableManagedRequiredSubscriptionChannels.length;
  const requiredSubscriptionIsActive = requiredSubscriptionSelectedCount > 0;
  const areChannelsSyncing =
    requiredSubscriptionEntitiesLoading || requiredSubscriptionEntitiesSyncing;
  const requiredSubscriptionPickerEmptyState =
    requiredSubscriptionSelectedCount >= REQUIRED_SUBSCRIPTION_MAX_CHANNELS
      ? 'Лимит выбран.'
      : requiredSubscriptionUnavailableCount > 0
        ? 'Нет доступных источников.'
        : 'Добавьте ссылку вручную.';
  const requiredSubscriptionHeaderSummary = areChannelsSyncing
    ? 'Обновляем...'
    : requiredSubscriptionStaleCount > 0
      ? `Нужно исправить: ${formatRequiredSubscriptionCount(requiredSubscriptionStaleCount)}`
      : requiredSubscriptionIsActive
        ? formatRequiredSubscriptionCount(requiredSubscriptionSelectedCount)
        : 'Не настроена';
  const requiredSubscriptionCardStatus =
    requiredSubscriptionStaleCount > 0
      ? 'Проверить'
      : requiredSubscriptionIsActive
        ? `${requiredSubscriptionSelectedCount}`
        : '0';
  const profanityFilterHeaderSummary = draft?.russianProfanityFilterEnabled
    ? `${profanityStagesEnabledCount}/4 ступени включено`
    : 'Выключено';
  const profanityFilterCardStatus = draft?.russianProfanityFilterEnabled
    ? `${profanityStagesEnabledCount}/4`
    : 'Выкл';
  const commercialFilterHeaderSummary = draft?.commercialAdsFilterEnabled
    ? `${textFiltersStagesEnabledCount}/4 ступени · ${commercialSensitivityLabel.toLowerCase()}`
    : 'Выключено';
  const commercialFilterCardStatus = draft?.commercialAdsFilterEnabled
    ? `${textFiltersStagesEnabledCount}/4`
    : 'Выкл';
  const extraEnabledCount = [
    draft?.deleteBotMessagesEnabled,
    draft?.removeBotsFromGroupEnabled,
  ].filter(Boolean).length;
  const deleteSpammersRuntimeStatus = !draft?.deleteSpammersEnabled
    ? 'Выкл'
    : spammerReviewMetricsQuery.data?.enforcementMode === 'shadow'
      ? 'Проверка'
      : 'Активно';
  const extraHeaderSummary =
    extraEnabledCount > 0 ? `${extraEnabledCount} опции включено` : 'Выключено';
  const extraCardStatus = extraEnabledCount > 0 ? `${extraEnabledCount}` : 'Выкл';
  const chatsCount = chatsList.data?.length ?? 0;
  const canApplyToAllChats = !chatsList.isSyncComplete || chatsCount > 1;
  const mailingAudienceChoices = useMemo(() => {
    const choicesById = new Map<string, ChatSummary>();
    for (const chat of chatsList.data ?? []) {
      if (chat.entityType === 'chat') {
        choicesById.set(chat.id, chat);
      }
    }

    const currentChatId = chatId?.trim() ?? '';
    if (currentChatId && !choicesById.has(currentChatId)) {
      choicesById.set(currentChatId, {
        id: currentChatId,
        title: chatTitle || 'Текущий чат',
        createdAt: new Date(0).toISOString(),
        entityType: 'chat',
        link: chatHeaderQuery.data?.link ?? null,
        avatarUrl: chatHeaderQuery.data?.avatarUrl ?? null,
        channelOverview: null,
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
        botCount: chatHeaderQuery.data?.botCount,
        hasSharedAutomation: chatHeaderQuery.data?.hasSharedAutomation,
      });
    }

    return [...choicesById.values()];
  }, [
    chatHeaderQuery.data?.avatarUrl,
    chatHeaderQuery.data?.botCount,
    chatHeaderQuery.data?.hasSharedAutomation,
    chatHeaderQuery.data?.link,
    chatId,
    chatTitle,
    chatsList.data,
  ]);
  const mailingAudiencePayload = useMemo(
    () =>
      resolveBroadcastAudiencePayload({
        targetMode: mailingTargetMode,
        targetChatIds: mailingTargetChatIds,
        currentChatId: chatId ?? undefined,
      }),
    [chatId, mailingTargetChatIds, mailingTargetMode],
  );
  const mailingCalendarTargetChatIds = useMemo(
    () => (mailingAudiencePayload.targetMode === 'all' ? [] : mailingAudiencePayload.targetChatIds),
    [mailingAudiencePayload.targetChatIds, mailingAudiencePayload.targetMode],
  );
  const mailingCalendarQuery = useQuery({
    queryKey: [
      'managed-broadcast-calendar',
      chatId,
      mailingAudiencePayload.targetMode,
      mailingCalendarTargetChatIds.join(':'),
      editingManagedBroadcast?.id ?? null,
    ],
    queryFn: () =>
      getManagedBroadcastCalendar(api, chatId ?? '', {
        targetMode: mailingAudiencePayload.targetMode,
        targetChatIds: mailingCalendarTargetChatIds,
      }),
    enabled: Boolean(chatId) && expandedSections.mailing,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const mailingAudienceChoicesLoading = chatsList.isLoading && (chatsList.data?.length ?? 0) === 0;
  const mailingAudienceChoicesError = chatsList.error
    ? formatApiError(chatsList.error) || 'Не удалось загрузить список чатов.'
    : null;
  const managedChatsRoute = buildManagedEntitiesRoute('chat');
  const refetchSettings = () => {
    void settingsQuery.refetch();
    if (handoffRequested) {
      void broadcastHandoffStateQuery.refetch();
    }
  };
  const managedBroadcasts = managedBroadcastsQuery.data ?? [];
  const managedAutopostRulesQuery = useQuery({
    queryKey: ['managed-autopost-rules', chatId],
    queryFn: () => getManagedAutopostRules(api, chatId ?? ''),
    enabled: Boolean(chatId) && expandedSections.mailing,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const orderedManagedAutopostRules = useMemo(
    () => sortManagedAutopostRules(managedAutopostRulesQuery.data ?? []),
    [managedAutopostRulesQuery.data],
  );

  useEffect(() => {
    if (!legacyEditorTarget) {
      appliedLegacyEditorTargetRef.current = null;
      return;
    }

    const signature = `${chatId}:${legacyEditorTarget.kind}:${legacyEditorTarget.id}`;
    if (appliedLegacyEditorTargetRef.current === signature) {
      return;
    }

    if (legacyEditorTarget.kind === 'autopost') {
      if (!settingsScreenQuery.data || openManagedAutopostRuleMutation.isPending) {
        return;
      }

      appliedLegacyEditorTargetRef.current = signature;
      setMailingWorkspaceView('autoposts');
      openManagedAutopostRuleMutation.mutate(legacyEditorTarget.id);
      return;
    }

    if (!settingsScreenQuery.data || openManagedBroadcastEditorMutation.isPending) {
      return;
    }

    appliedLegacyEditorTargetRef.current = signature;
    setMailingWorkspaceView('history');
    openManagedBroadcastEditorMutation.mutate(legacyEditorTarget.id);
  }, [
    chatId,
    legacyEditorTarget,
    openManagedAutopostRuleMutation,
    openManagedBroadcastEditorMutation,
    settingsScreenQuery.data,
  ]);
  const orderedManagedBroadcasts = useMemo(() => {
    const priority = (item: ManagedBroadcastListItem): number => {
      if (item.status === 'FAILED') {
        return 0;
      }
      if (item.status === 'PARTIAL') {
        return 1;
      }
      if (item.status === 'ACTIVE') {
        return 2;
      }
      if (item.status === 'COMPLETED') {
        return 3;
      }
      return 4;
    };

    const parseTimestamp = (value: string | null): number => {
      if (!value) {
        return Number.MAX_SAFE_INTEGER;
      }

      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    };

    return [...managedBroadcasts].sort((left, right) => {
      const priorityDiff = priority(left) - priority(right);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      const nextSendDiff = parseTimestamp(left.nextSendAt) - parseTimestamp(right.nextSendAt);
      if (nextSendDiff !== 0) {
        return nextSendDiff;
      }

      return parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt);
    });
  }, [managedBroadcasts]);
  const mailingHistoryCounts = useMemo(
    () => countManagedBroadcastHistoryFilters(orderedManagedBroadcasts),
    [orderedManagedBroadcasts],
  );
  const filteredManagedBroadcasts = useMemo(
    () => filterManagedBroadcastsByHistoryFilter(orderedManagedBroadcasts, mailingHistoryFilter),
    [mailingHistoryFilter, orderedManagedBroadcasts],
  );
  const mailingOccupiedSlots = managedBroadcasts
    .filter(
      (broadcast) =>
        broadcast.id !== editingManagedBroadcast?.id &&
        broadcast.autopostRuleId !== editingManagedAutopostRule?.id,
    )
    .flatMap((broadcast) => broadcast.scheduledSlots);
  const mailingConflictOccupiedSlots =
    mailingCalendarQuery.data?.slots && mailingCalendarQuery.data.slots.length > 0
      ? sortAndUniqueBroadcastSlots(
          mailingCalendarQuery.data.slots
            .filter(
              (slot) =>
                slot.hasTargetOverlap &&
                (!editingManagedBroadcast || slot.broadcastId !== editingManagedBroadcast.id) &&
                (!editingManagedAutopostRule ||
                  slot.autopostRuleId !== editingManagedAutopostRule.id),
            )
            .map((slot) => slot.scheduledAt),
        )
      : mailingOccupiedSlots;
  const pendingMailingConflictSlots = pendingMailingSlotConflict
    ? findBroadcastSlotConflicts(
        pendingMailingSlotConflict.payload.scheduledSlots,
        mailingConflictOccupiedSlots,
      )
    : [];
  const pendingMailingConflictPreviewSlot =
    pendingMailingConflictSlots[0] ?? pendingMailingSlotConflict?.payload.scheduledSlots[0] ?? null;
  const mailingCurrentChatChoice = mailingAudienceChoices.find((chat) => chat.id === chatId);
  const mailingCurrentChatPreview = mailingCurrentChatChoice
    ? toManagedBroadcastTargetPreview(mailingCurrentChatChoice)
    : chatId
      ? {
          id: chatId,
          title: chatTitle || 'Текущий чат',
          entityType: 'chat' as const,
          link: chatHeaderQuery.data?.link ?? null,
          avatarUrl: chatHeaderQuery.data?.avatarUrl ?? null,
        }
      : null;
  const mailingSystemButtons = buildChatBroadcastSystemButtons({
    commentsEnabled: draft?.commentsEnabled,
    commentsChatBroadcastsEnabled: draft?.commentsChatBroadcastsEnabled,
  });
  const pendingMailingReviewPayload = pendingMailingPublishReview?.payload ?? null;
  const pendingMailingReviewAudienceLabel = pendingMailingReviewPayload
    ? buildBroadcastAudiencePresentation({
        targetMode: pendingMailingReviewPayload.targetMode,
        targetChatIds:
          pendingMailingReviewPayload.targetMode === 'all'
            ? mailingCalendarTargetChatIds
            : pendingMailingReviewPayload.targetChatIds,
        targetPreviews: buildBroadcastAudiencePreviewBundle({
          targetChatIds:
            pendingMailingReviewPayload.targetMode === 'all'
              ? mailingCalendarTargetChatIds
              : pendingMailingReviewPayload.targetChatIds,
          choices: mailingAudienceChoices,
          currentChat: mailingCurrentChatPreview,
        }).previews,
        targetChats:
          pendingMailingReviewPayload.targetMode === 'all'
            ? mailingAudienceChoices.length
            : pendingMailingReviewPayload.targetChatIds.length,
        currentLabel: 'Текущий чат',
        currentTitle: chatTitle,
      }).label
    : '';
  const pendingMailingReviewFacts = pendingMailingReviewPayload
    ? [
        `Кому · ${pendingMailingReviewAudienceLabel}`,
        `Время · ${formatBroadcastPayloadScheduleLabel(pendingMailingReviewPayload)}`,
        pendingMailingReviewPayload.buttonEnabled || mailingSystemButtons.length > 0
          ? `Кнопки · ${formatBroadcastButtonsPreview([
              ...pendingMailingReviewPayload.buttons,
              ...mailingSystemButtons,
            ])}`
          : 'Кнопки · нет',
        pendingMailingReviewPayload.imageEnabled ||
        pendingMailingReviewPayload.mediaType === 'video'
          ? 'Медиа'
          : null,
      ].filter((item): item is string => Boolean(item))
    : [];
  const activeManagedBroadcast = orderedManagedBroadcasts.find((broadcast) => {
    if (broadcast.status !== 'ACTIVE' && broadcast.status !== 'PARTIAL') {
      return false;
    }

    return resolveBroadcastCountdown(broadcast.nextSendAt, mailingNowMs) !== null;
  });
  const activeManagedBroadcastCountdown = activeManagedBroadcast
    ? resolveBroadcastCountdown(activeManagedBroadcast.nextSendAt, mailingNowMs)
    : null;
  const hasActiveManagedBroadcastCountdown = activeManagedBroadcastCountdown !== null;
  const isUpdatingManagedBroadcast = updateManagedBroadcastMutation.isPending;
  const isOpeningManagedBroadcastEditor = openManagedBroadcastEditorMutation.isPending;
  const isMailingBusy =
    sendBroadcastTestMutation.isPending ||
    sendBroadcastHandoffMutation.isPending ||
    clearBroadcastHandoffMutation.isPending ||
    updateManagedAutopostRuleMutation.isPending ||
    deleteManagedAutopostRuleMutation.isPending ||
    openManagedAutopostRuleMutation.isPending ||
    isOpeningManagedBroadcastEditor ||
    isUpdatingManagedBroadcast ||
    cancelManagedBroadcastMutation.isPending ||
    retryManagedBroadcastMutation.isPending;
  const commentsTargetSummary = [
    draft?.commentsAdminsEnabled ? 'посты админов' : null,
    draft?.commentsChatBroadcastsEnabled ? 'автопостинг' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const commentsCardSummary = !draft?.commentsEnabled
    ? 'обсуждение выключено'
    : commentsTargetSummary || 'не выбрано, где бот публикует кнопку';
  const commentsCardStatus = !draft?.commentsEnabled
    ? 'Выкл'
    : draft.commentsAdminsEnabled && draft.commentsChatBroadcastsEnabled
      ? '2 зоны'
      : draft.commentsAdminsEnabled
        ? 'Админ'
        : draft.commentsChatBroadcastsEnabled
          ? 'Авто'
          : 'Вкл';
  const mailingAudiencePreviewBundle = buildBroadcastAudiencePreviewBundle({
    targetChatIds:
      mailingTargetMode === 'all'
        ? mailingCalendarTargetChatIds
        : mailingAudiencePayload.targetChatIds,
    choices: mailingAudienceChoices,
    currentChat: mailingCurrentChatPreview,
  });
  const mailingHeaderTargetPresentation = buildBroadcastAudiencePresentation({
    targetMode: mailingTargetMode,
    targetChatIds:
      mailingTargetMode === 'all'
        ? mailingCalendarTargetChatIds
        : mailingAudiencePayload.targetChatIds,
    targetPreviews: mailingAudiencePreviewBundle.previews,
    targetOverflowCount: mailingAudiencePreviewBundle.overflowCount,
    targetChats:
      mailingTargetMode === 'all'
        ? mailingCalendarTargetChatIds.length
        : mailingAudiencePayload.targetChatIds.length,
    currentLabel: 'Текущий чат',
    currentTitle: chatTitle,
  });
  const mailingHeaderTargetLabel = mailingHeaderTargetPresentation.label;
  const mailingSlotsLabel = formatRussianCountLabel(
    mailingScheduledSlots.length,
    'отправка',
    'отправки',
    'отправок',
  );
  const normalizedMailingText = mailingText.trim();
  const normalizedMailingButtons = trimBroadcastLinkButtons(mailingButtons);
  const mailingButtonEnabled = normalizedMailingButtons.length > 0;
  const mailingVisibleButtons = [...normalizedMailingButtons, ...mailingSystemButtons];
  const mailingHasVisibleButtons = mailingVisibleButtons.length > 0;
  const mailingVisibleButtonStatus = formatBroadcastButtonsStatus(mailingVisibleButtons);
  const mailingVideoSource = editingManagedBroadcast ?? editingManagedAutopostRule?.payload;
  const editingMailingHasVideo =
    !mailingVideoCleared &&
    mailingVideoSource?.mediaType === 'video' &&
    Boolean(mailingVideoSource.mediaPayload);
  const mailingImageLabel =
    mailingImages.length > 1 ? `${mailingImages.length} фото` : mailingImageEnabled ? 'Фото' : null;
  const mailingHasDirectContent = Boolean(
    normalizedMailingText || mailingImageEnabled || editingMailingHasVideo,
  );
  const mailingImagesReady = !mailingImageEnabled || areBroadcastImagesReady(mailingImages);
  const mailingMediaReady = mailingImagesReady && !mailingImagesPreparing;
  const mailingHasPublishableContent = mailingHasDirectContent;
  const mailingContentReady = mailingHasPublishableContent && mailingMediaReady;
  const mailingNormalizedCycle = normalizeBroadcastCycleDraft(mailingCycleDraft, mailingNowMs);
  const mailingCycleValidationError =
    mailingTimingMode === 'cycle'
      ? getBroadcastCycleValidationError(mailingNormalizedCycle, mailingNowMs)
      : null;
  const mailingTimingSummary =
    mailingTimingMode === 'now'
      ? 'Сейчас'
      : mailingTimingMode === 'cycle'
        ? formatBroadcastCycleSummary(mailingNormalizedCycle, mailingNowMs)
        : mailingScheduledSlots.length > 0
          ? mailingSlotsLabel
          : 'Без времени';
  const mailingSelectionSummary = [
    mailingPlannerState.selectedDayCount > 0
      ? formatRussianCountLabel(mailingPlannerState.selectedDayCount, 'день', 'дня', 'дней')
      : null,
    mailingPlannerState.futureSlotCount > 0
      ? formatRussianCountLabel(
          mailingPlannerState.futureSlotCount,
          'отправка',
          'отправки',
          'отправок',
        )
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const mailingHeaderSummary = [mailingHeaderTargetLabel, mailingTimingSummary]
    .filter(Boolean)
    .join(' · ');
  const mailingCardStatus =
    editingManagedBroadcast || editingManagedAutopostRule
      ? 'Правка'
      : mailingTimingMode === 'cycle'
        ? 'Цикл'
        : mailingTimingMode === 'scheduled'
          ? mailingScheduledSlots.length > 0
            ? mailingSlotsLabel
            : 'План'
          : mailingHasPublishableContent
            ? 'Готов'
            : 'Черновик';
  const showMailingResetAction =
    editingManagedBroadcast !== null ||
    mailingTargetMode !== 'current' ||
    mailingTimingMode !== 'now' ||
    mailingScheduledSlots.length > 0 ||
    normalizedMailingText.length > 0 ||
    mailingImageEnabled ||
    mailingButtonEnabled;
  const mailingButtonDraftValid = !hasBroadcastLinkButtonErrors(
    validateBroadcastLinkButtons(normalizedMailingButtons),
  );
  const mailingPlannerPending = mailingPlannerState.isDaySheetOpen;
  const mailingAudienceReady =
    mailingTargetMode !== 'selected' || mailingAudiencePayload.targetChatIds.length > 0;
  const mailingHasFutureSlots =
    mailingTimingMode === 'now' ||
    (mailingTimingMode === 'cycle' && !mailingCycleValidationError) ||
    (mailingTimingMode === 'scheduled' &&
      mailingPlannerState.futureSlotCount > 0 &&
      !mailingPlannerState.hasBlockingIssue);
  const mailingCalendarScheduleReady =
    mailingTimingMode === 'scheduled' &&
    mailingScheduledSlots.length > 0 &&
    mailingPlannerState.futureSlotCount > 0 &&
    !mailingPlannerPending &&
    !mailingPlannerState.hasBlockingIssue;
  const mailingScheduleReady =
    mailingTimingMode === 'now' ||
    (mailingTimingMode === 'cycle' && !mailingCycleValidationError) ||
    mailingCalendarScheduleReady;
  const mailingTestReady = mailingContentReady && mailingButtonDraftValid;
  const mailingSendDisabled =
    isMailingBusy ||
    !mailingContentReady ||
    !mailingAudienceReady ||
    !mailingScheduleReady ||
    !mailingHasFutureSlots ||
    !mailingButtonDraftValid;
  const mailingAutopostDisabled =
    isMailingBusy ||
    !mailingContentReady ||
    !mailingAudienceReady ||
    !mailingCalendarScheduleReady ||
    !mailingButtonDraftValid;
  const mailingPublishIssueLabels = [
    !mailingHasPublishableContent ? 'Текст' : null,
    mailingHasPublishableContent && !mailingMediaReady ? 'Фото' : null,
    !mailingAudienceReady ? 'Адресат' : null,
    !mailingScheduleReady || !mailingHasFutureSlots ? 'Время' : null,
    !mailingButtonDraftValid ? 'Кнопки' : null,
  ].filter((item): item is string => Boolean(item));
  const mailingPublishIssueActions = mailingPublishIssueLabels.map((label) => ({
    label,
    onClick: () => {
      setMailingWorkspaceView('compose');

      if (label === 'Текст') {
        setMailingTextError('Добавьте текст, фото или видео.');
        return;
      }

      if (label === 'Фото') {
        setMailingImageError(mailingImagesPreparing ? 'Фото ещё готовится.' : 'Фото не готово.');
        return;
      }

      if (label === 'Адресат') {
        setMailingAudienceError('Выберите хотя бы один чат.');
        return;
      }

      if (label === 'Время') {
        if (mailingTimingMode === 'cycle') {
          setMailingCycleError(mailingCycleValidationError ?? 'Проверьте цикл публикаций.');
          return;
        }

        setMailingScheduleError('Выберите время публикации.');
        return;
      }

      if (label === 'Кнопки') {
        setMailingButtonsSheetOpen(true);
      }
    },
  }));
  const mailingPrimaryActionLabel = editingManagedBroadcast
    ? 'Сохранить'
    : editingManagedAutopostRule
      ? 'Сохранить'
      : mailingTimingMode === 'now'
        ? 'Опубликовать'
        : mailingTimingMode === 'scheduled'
          ? 'Запланировать публикацию'
          : 'Запустить';
  const mailingFooterPrimaryActionLabel = editingManagedBroadcast
    ? 'Сохранить'
    : editingManagedAutopostRule
      ? 'Сохранить'
      : mailingTimingMode === 'now'
        ? 'Опубликовать'
        : mailingTimingMode === 'scheduled'
          ? 'Запланировать публикацию'
          : 'Запустить';
  const showMailingWorkspaceTabs = !editingManagedBroadcast && !editingManagedAutopostRule;
  const activeMailingWorkspaceView =
    legacyBroadcastWorkspaceRequested &&
    !handoffRequested &&
    showMailingWorkspaceTabs &&
    (mailingWorkspaceView === 'compose' || mailingWorkspaceView === 'calendar')
      ? legacyEditorTarget?.kind === 'broadcast'
        ? 'history'
        : 'autoposts'
      : mailingWorkspaceView;
  const mailingResetActionLabel = editingManagedBroadcast
    ? 'Сбросить изменения'
    : editingManagedAutopostRule
      ? 'Сбросить изменения'
      : 'Очистить автопостинг';
  const mailingFooterScheduleLabel =
    mailingTimingMode === 'now'
      ? 'Сейчас'
      : mailingTimingMode === 'cycle'
        ? formatBroadcastCycleSummary(mailingNormalizedCycle, mailingNowMs)
        : mailingSelectionSummary || mailingSlotsLabel;
  const mailingFooterTitle = [
    mailingHeaderTargetLabel,
    mailingFooterScheduleLabel,
    editingManagedBroadcast || editingManagedAutopostRule ? 'Правка' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const mailingFooterMeta = [
    mailingImageLabel,
    editingMailingHasVideo ? 'Видео' : null,
    mailingHasVisibleButtons ? mailingVisibleButtonStatus : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const mailingDrilldownFooter = (
    <BroadcastPublishBar
      title={mailingFooterTitle}
      meta={mailingFooterMeta}
      issues={mailingPublishIssueActions}
      busy={isMailingBusy}
      testLabel={sendBroadcastTestMutation.isPending ? 'Тест...' : 'Тест'}
      testAriaLabel={sendBroadcastTestMutation.isPending ? 'Отправляем тест' : 'Отправить тест'}
      testDisabled={isMailingBusy || !mailingTestReady}
      primaryLabel={
        updateManagedAutopostRuleMutation.isPending && editingManagedAutopostRule
          ? 'Сохраняем...'
          : isUpdatingManagedBroadcast
            ? 'Сохраняем...'
            : isOpeningManagedBroadcastEditor
              ? 'Открываем...'
              : mailingFooterPrimaryActionLabel
      }
      primaryDisabled={editingManagedAutopostRule ? mailingAutopostDisabled : mailingSendDisabled}
      onTest={handleSendBroadcastTest}
      onPrimary={editingManagedAutopostRule ? handleSaveChatAutopostRule : handleSendBroadcast}
    />
  );

  useEffect(() => {
    if (editingManagedBroadcast && mailingWorkspaceView !== 'compose') {
      setMailingWorkspaceView('compose');
    }
  }, [editingManagedBroadcast, mailingWorkspaceView]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !expandedSections.mailing ||
      !hasActiveManagedBroadcastCountdown
    ) {
      return undefined;
    }

    setMailingNowMs(Date.now());
    const timerId = window.setInterval(() => {
      setMailingNowMs(Date.now());
    }, 30_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [expandedSections.mailing, hasActiveManagedBroadcastCountdown]);

  useHintPopoverAutoPosition(openHintKey !== null, openHintKey);

  function resetMailingPlanner() {
    setMailingPlannerState(EMPTY_BROADCAST_PLANNER_STATE);
    setMailingPlannerResetKey((current) => current + 1);
  }

  function isSectionDirty(section: ApplySectionKey) {
    if (!draft || !settingsQuery.data) {
      return false;
    }

    const draftSettings =
      section === 'requiredSubscription'
        ? normalizeRequiredSubscriptionDraftSettings(draft)
        : draft;
    const savedSettings =
      section === 'requiredSubscription'
        ? normalizeRequiredSubscriptionDraftSettings(settingsQuery.data)
        : settingsQuery.data;
    return (
      SECTION_SETTING_KEYS[section].some((key) => draftSettings[key] !== savedSettings[key]) ||
      hasSectionBotSpeechMediaChanges(draftSettings, savedSettings, section)
    );
  }

  function isCommentsDirty() {
    if (!draft || !settingsQuery.data) {
      return false;
    }

    const savedSettings = settingsQuery.data;
    return COMMENTS_SETTING_KEYS.some((key) => draft[key] !== savedSettings[key]);
  }

  function discardSectionChanges(section: ApplySectionKey) {
    const savedSettings = settingsQuery.data;
    if (!savedSettings) {
      return;
    }

    setDraft((current) =>
      current ? mergeSectionSettings(current, savedSettings, section) : current,
    );
  }

  function discardCommentsChanges() {
    const savedSettings = settingsQuery.data;
    if (!savedSettings) {
      return;
    }

    setDraft((current) => (current ? mergeCommentsSettings(current, savedSettings) : current));
  }

  function buildSectionPayload(section: ApplySectionKey) {
    if (!draft || !settingsQuery.data) {
      return null;
    }

    const baseSettings =
      section === 'requiredSubscription'
        ? normalizeRequiredSubscriptionDraftSettings(settingsQuery.data)
        : settingsQuery.data;
    const draftSettings =
      section === 'requiredSubscription'
        ? normalizeRequiredSubscriptionDraftSettings(draft)
        : draft;

    return validateDraft(mergeSectionSettings(baseSettings, draftSettings, section));
  }

  function buildCommentsPayload() {
    if (!draft || !settingsQuery.data) {
      return null;
    }

    return validateDraft(mergeCommentsSettings(settingsQuery.data, draft));
  }

  function buildBotSpeechStylePayload(style: BotSpeechStyle) {
    if (!settingsQuery.data) {
      return null;
    }

    return validateDraft(applyBotSpeechStylePreset(settingsQuery.data, style));
  }

  async function handleSaveSection(section: ApplySectionKey) {
    if (!chatId) {
      return;
    }

    if (!isSectionDirty(section)) {
      closeSection(section);
      return;
    }

    const payload = buildSectionPayload(section);
    if (!payload) {
      pushToast({
        tone: 'danger',
        title: `Исправьте блок «${SECTION_LABELS[section]}»`,
        description: 'В блоке есть ошибки, их нужно исправить перед сохранением.',
      });
      return;
    }

    try {
      await mutateSettingsAsync({ section, payload });
      closeSection(section);
    } catch {
      // Errors are handled by the mutation.
    }
  }

  async function handleSaveComments() {
    if (!chatId) {
      return;
    }

    if (!isCommentsDirty()) {
      closeSection('comments');
      return;
    }

    const payload = buildCommentsPayload();
    if (!payload) {
      pushToast({
        tone: 'danger',
        title: 'Исправьте блок «Комментарии»',
        description: 'В блоке есть ошибки, их нужно исправить перед сохранением.',
      });
      return;
    }

    try {
      await mutateCommentsAsync(payload);
      closeSection('comments');
    } catch {
      // Errors are handled by the mutation.
    }
  }

  function openApplyTargetSheet(section: ApplySectionKey) {
    if (!chatId || !draft) {
      return;
    }

    const payload = buildSectionPayload(section);
    if (!payload) {
      pushToast({
        tone: 'danger',
        title: `Исправьте блок «${SECTION_LABELS[section]}»`,
        description: 'В блоке есть ошибки, их нужно исправить перед сохранением.',
      });
      return;
    }

    void preloadSettingsApplyTargetSheet();
    setApplyTargetSheet({
      section,
      sourceSettings: payload,
      target: createDefaultApplySettingsTarget(),
    });
  }

  async function handleConfirmApplyTarget() {
    if (!applyTargetSheet) {
      return;
    }

    try {
      await applySectionToAllMutation.mutateAsync(applyTargetSheet);
      closeSection(applyTargetSheet.section);
    } catch {
      // Errors are handled by the mutation.
    }
  }

  async function handleApplyBotSpeechStyle(style: BotSpeechStyle) {
    if (!chatId) {
      return;
    }

    const payload = buildBotSpeechStylePayload(style);
    if (!payload) {
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить стиль речи',
        description: 'Проверьте настройки и повторите попытку.',
      });
      return;
    }

    try {
      await saveSpeechStyleMutation.mutateAsync({ style, payload });
    } catch {
      // Errors are handled by the mutation.
    }
  }

  function renderSectionSaveFooter(
    section: ApplySectionKey,
    options?: {
      note?: string | null;
      saveLabel?: string;
      applyToAllLabel?: string;
      emphasize?: 'save' | 'apply';
    },
  ) {
    return (
      <SettingsSectionSaveFooter
        section={section}
        options={options}
        isSavingSettings={isSavingSettings}
        savingSection={savingSection}
        isApplyingSectionToAll={isApplyingSectionToAll}
        applyingSection={applyingSection}
        canApplyToAllChats={canApplyToAllChats}
        isSectionDirty={isSectionDirty}
        onSaveSection={(targetSection) => void handleSaveSection(targetSection)}
        onOpenApplyTarget={openApplyTargetSheet}
      />
    );
  }

  function handleDesktopToggleRowClick(event: MouseEvent<HTMLElement>) {
    const switchLabel = resolveDesktopToggleRowLabel(event.target);
    if (!switchLabel) {
      return;
    }

    event.preventDefault();
    switchLabel.click();
  }

  return (
    <div className="page-stack page-enter">
      {applyTargetSheet ? (
        <Suspense fallback={null}>
          <LazySettingsApplyTargetSheet
            sheet={applyTargetSheet}
            preview={applyTargetPreview}
            previewLoading={applyTargetPreviewLoading}
            previewError={applyTargetPreviewError}
            sectionLabel={SECTION_LABELS[applyTargetSheet.section]}
            overlayStyle={applyTargetOverlayStyle}
            isApplying={isApplyingSectionToAll}
            onClose={() => setApplyTargetSheet(null)}
            onTargetChange={(target) =>
              setApplyTargetSheet((current) => (current ? { ...current, target } : current))
            }
            onConfirm={() => void handleConfirmApplyTarget()}
          />
        </Suspense>
      ) : null}

      {settingsHandoffMode ? (
        <Suspense fallback={null}>
          <LazySettingsHandoffState mode={settingsHandoffMode} onRetry={refetchSettings} />
        </Suspense>
      ) : null}

      {settingsQuery.isLoading && settingsHandoffMode !== 'loading' ? (
        <section className="settings-sections" aria-label="Загрузка настроек">
          <GlassCard className="settings-section">
            <SkeletonCard lines={5} />
          </GlassCard>
        </section>
      ) : null}

      {settingsQuery.error && settingsHandoffMode !== 'error' ? (
        <GlassCard>
          <StatusState
            tone="danger"
            title="Ошибка загрузки настроек"
            description={formatApiError(settingsQuery.error)}
            action={
              <button type="button" className="button button--danger" onClick={refetchSettings}>
                Повторить
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {!settingsHandoffMode && !settingsQuery.isLoading && !settingsQuery.error && draft ? (
        <section
          className="settings-sections settings-sections--chat-home"
          aria-label="Настройки модерации"
          onClickCapture={handleDesktopToggleRowClick}
        >
          <CompactStickyHeader
            backTo={managedChatsRoute}
            backLabel="Назад к чатам"
            title={chatTitle || chatId || 'Настройки'}
            avatar={
              <EntityAvatar
                title={chatTitle || chatId || 'Настройки'}
                entityType="chat"
                avatarUrl={chatHeaderQuery.data?.avatarUrl ?? routeChatAvatarUrl ?? null}
                className="compact-page-header__entity-avatar"
              />
            }
            compact={isHeaderCompact}
            className="settings-home-sticky-header stagger-in"
            aside={
              showHeaderStatus ? (
                <span
                  className={cn(
                    'compact-page-header__status',
                    isHeaderSaving
                      ? 'compact-page-header__status--saving'
                      : 'compact-page-header__status--draft',
                  )}
                  aria-label={
                    isHeaderSaving ? 'Сохраняем изменения' : 'Есть несохранённые изменения'
                  }
                  title={isHeaderSaving ? 'Сохраняем изменения' : 'Есть несохранённые изменения'}
                >
                  {compactHeaderStatusLabel}
                </span>
              ) : null
            }
          />

          {settingsScreenQuery.data?.header.accessDiagnostics?.state === 'bot_access_lost' ? (
            <Suspense fallback={null}>
              <LazyManagedEntityAccessDiagnosticsBanner
                diagnostics={settingsScreenQuery.data.header.accessDiagnostics}
                entityLabel="чат"
                isRechecking={recheckAccessMutation.isPending}
                onRecheck={() => recheckAccessMutation.mutate()}
              />
            </Suspense>
          ) : null}

          {speechStylePanelOpen && pendingSpeechStyle && pendingSpeechStyleSamples ? (
            <Suspense fallback={null}>
              <LazySettingsSpeechStylePanel
                activeStyle={activeSpeechStyle}
                selectedStyle={pendingSpeechStyle}
                samples={pendingSpeechStyleSamples}
                isSaving={isSavingSpeechStyle}
                onSelect={setPendingSpeechStyle}
                onClose={() => {
                  if (!isSavingSpeechStyle) {
                    setSpeechStylePanelOpen(false);
                    setPendingSpeechStyle(null);
                  }
                }}
                onCancel={() => {
                  setSpeechStylePanelOpen(false);
                  setPendingSpeechStyle(null);
                }}
                onDiscard={() => setPendingSpeechStyle(activeSpeechStyle ?? 'ROBOT')}
                onSave={(style) => void handleApplyBotSpeechStyle(style)}
              />
            </Suspense>
          ) : null}

          <Suspense fallback={null}>
            <LazySettingsOverviewSearch
              key={chatId}
              containerId="chat-settings-overview"
              entrySelector=".settings-home-entry"
              groupSelector=".settings-home-group-head"
            />
          </Suspense>

          <div id="chat-settings-overview" className="settings-sections-shell">
            <div className="settings-home-group-head stagger-in" style={{ order: 10 }}>
              <h2 className="settings-home-group-head__title">Защита</h2>
            </div>

            <div className="settings-home-group-head stagger-in" style={{ order: 20 }}>
              <h2 className="settings-home-group-head__title">Контент</h2>
            </div>

            <div className="settings-home-group-head stagger-in" style={{ order: 30 }}>
              <h2 className="settings-home-group-head__title">Бот</h2>
            </div>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
              style={{ order: 1 }}
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Ссылки"
                  summary={linksHeaderSummary}
                  status={linksCardStatus}
                  icon="links"
                  tone="sky"
                  open={expandedSections.links}
                  controls="settings-links-content"
                  onClick={() => toggleSection('links')}
                  hideChevron
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-links-content"
                open={expandedSections.links}
                title="Ссылки"
                summary={linksHeaderSummary}
                tone="sky"
                className="settings-drilldown__panel--board settings-drilldown__panel--links"
                onClose={() => toggleSection('links')}
                confirmCloseWhen={isSectionDirty('links')}
                onDiscardChanges={() => discardSectionChanges('links')}
                footer={renderSectionSaveFooter('links', {
                  note: isLinksKeyboardOpen ? null : undefined,
                })}
                keepFooterVisibleWhenKeyboardOpen
              >
                <div
                  id="settings-links-content"
                  className={cn('settings-section__collapse', expandedSections.links && 'is-open')}
                >
                  {expandedSections.links ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-grid settings-grid--single">
                        <div className={cn('settings-policy', linkPolicyError && 'field--error')}>
                          <span className="field__label">Режим</span>
                          <SegmentedControl
                            value={draft.linkPolicy}
                            options={LINK_POLICY_OPTIONS.map((option) => ({
                              value: option.value,
                              label: option.label,
                            }))}
                            onChange={(value) => setFieldValue('linkPolicy', value)}
                            className={cn(
                              'settings-mode-segments',
                              linkPolicyError && 'settings-mode-segments--error',
                            )}
                            ariaLabel="Режим модерации ссылок"
                          />
                          {linkPolicyError ? (
                            <small className="field__hint">{linkPolicyError}</small>
                          ) : null}
                        </div>

                        {isAllowlistMode ? (
                          <div className="allowlist-workspace">
                            <div
                              className={cn(
                                'field',
                                'allowlist-panel',
                                domainInputError && 'allowlist-panel--error',
                              )}
                            >
                              <div className="allowlist-panel__head">
                                <div className="allowlist-panel__title-block">
                                  <div className="allowlist-panel__title-row">
                                    <span className="field__label">Белый список</span>
                                    <SettingsHintAnchor
                                      hintKey="linkAllowlistScope"
                                      openHintKey={openHintKey}
                                      onToggleHint={toggleHint}
                                      label="Пояснение по белому списку ссылок и доменов"
                                    >
                                      Выберите точную ссылку или весь домен. Доменные правила не
                                      удаляют все пути этого хоста и его поддомены.
                                    </SettingsHintAnchor>
                                  </div>
                                </div>
                                <span className="chip chip--success">
                                  {allowlistEntries.length}
                                </span>
                              </div>

                              <div className="allowlist-composer">
                                <div className="allowlist-composer__head">
                                  <span className="allowlist-composer__label">Что не удалять</span>
                                  <SettingsHintAnchor
                                    hintKey="linkAllowlistMode"
                                    openHintKey={openHintKey}
                                    onToggleHint={toggleHint}
                                    label="Пояснение по режиму разрешения ссылки"
                                  >
                                    {domainInputMode === 'DOMAIN'
                                      ? 'Не удалять весь хост, например `example.com`.'
                                      : 'Не удалять только один конкретный URL, включая путь и параметры.'}
                                  </SettingsHintAnchor>
                                </div>
                                <SegmentedControl
                                  value={domainInputMode}
                                  options={ALLOWLIST_MATCH_OPTIONS}
                                  onChange={(value) => {
                                    setDomainInputMode(value);
                                    setDomainInputError('');
                                  }}
                                  className="allowlist-composer__mode"
                                  ariaLabel="Что разрешить: домен или точную ссылку"
                                />
                                <div className="allowlist-add-row">
                                  <input
                                    type="text"
                                    inputMode={domainInputMode === 'EXACT' ? 'url' : 'text'}
                                    value={domainInput}
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    enterKeyHint="done"
                                    onChange={(event) => {
                                      setDomainInput(event.target.value);
                                      setDomainInputError('');
                                    }}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault();
                                        handleAddDomain();
                                      }
                                    }}
                                    placeholder={
                                      domainInputMode === 'DOMAIN'
                                        ? 'example.com'
                                        : 'https://site.ru'
                                    }
                                    aria-label={
                                      domainInputMode === 'DOMAIN'
                                        ? 'Домен для белого списка'
                                        : 'Точная ссылка для белого списка'
                                    }
                                  />

                                  <button
                                    type="button"
                                    className="button button--accent allowlist-add-row__button"
                                    onClick={handleAddDomain}
                                    disabled={isDomainMutationPending}
                                  >
                                    {addDomainMutation.isPending ? 'Добавляем...' : 'Добавить'}
                                  </button>
                                </div>

                                <div
                                  className="allowlist-composer__examples"
                                  aria-label="Быстрые примеры"
                                >
                                  {allowlistComposerExamples.map((example) => (
                                    <button
                                      key={example.value}
                                      type="button"
                                      className="allowlist-composer__example"
                                      title={example.label}
                                      onClick={() => {
                                        setDomainInput(example.value);
                                        setDomainInputError('');
                                      }}
                                    >
                                      {example.label}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {domainInputError ? (
                                <small className="field__hint">{domainInputError}</small>
                              ) : null}

                              {domainsQuery.isLoading ? (
                                <p className="allowlist-empty">Загрузка белого списка...</p>
                              ) : null}

                              {domainsQuery.error ? (
                                <p className="allowlist-empty allowlist-empty--error">
                                  Ошибка: {formatApiError(domainsQuery.error)}
                                </p>
                              ) : null}

                              {!domainsQuery.isLoading && !domainsQuery.error ? (
                                allowlistEntries.length > 0 ? (
                                  <div className="allowlist-results">
                                    <div className="allowlist-results__head">
                                      <span className="allowlist-results__title">Не удаляются</span>
                                      <small>{allowlistCountLabel}</small>
                                    </div>

                                    <ul
                                      className="allowlist-list"
                                      aria-label="Ссылки и домены, которые не удаляются"
                                    >
                                      {allowlistEntries.map((entry) => {
                                        const isScheduleOpen =
                                          scheduleDomain === entry.normalizedValue;
                                        const scheduledAtLabel = formatRemovalDateTime(
                                          entry.removeAfterAt,
                                        );
                                        const entryIdSuffix = encodeURIComponent(
                                          entry.normalizedValue,
                                        );

                                        return (
                                          <li
                                            key={entry.normalizedValue}
                                            className={cn(
                                              'allowlist-item',
                                              'allowlist-item--domain',
                                            )}
                                          >
                                            <div className="allowlist-item__stack">
                                              <div className="allowlist-item__header">
                                                <div className="allowlist-item__lead">
                                                  <span
                                                    className="allowlist-item__domain"
                                                    title={entry.domain}
                                                  >
                                                    {entry.domain}
                                                  </span>
                                                  <small className="allowlist-item__type">
                                                    {formatAllowlistModeLabel(entry.matchType)}
                                                  </small>
                                                </div>
                                                <span
                                                  className={cn(
                                                    'chip',
                                                    'allowlist-item__status',
                                                    scheduledAtLabel
                                                      ? 'chip--warning'
                                                      : 'chip--success',
                                                  )}
                                                >
                                                  {scheduledAtLabel ? 'По таймеру' : 'Без таймера'}
                                                </span>
                                              </div>

                                              <small className="allowlist-item__meta">
                                                {formatAllowlistMetaLabel(entry, scheduledAtLabel)}
                                              </small>

                                              <div className="allowlist-item__actions">
                                                <button
                                                  type="button"
                                                  className={cn(
                                                    'allowlist-item__action',
                                                    'allowlist-item__action--schedule',
                                                    isScheduleOpen && 'is-open',
                                                  )}
                                                  aria-label={`Запланировать удаление ${entry.domain}`}
                                                  title="Запланировать удаление"
                                                  onClick={() => toggleDomainScheduleEditor(entry)}
                                                  disabled={isDomainMutationPending}
                                                >
                                                  <CalendarIcon />
                                                  <span>
                                                    {scheduledAtLabel
                                                      ? isScheduleOpen
                                                        ? 'Свернуть таймер'
                                                        : 'Изменить таймер'
                                                      : isScheduleOpen
                                                        ? 'Свернуть таймер'
                                                        : 'Поставить таймер'}
                                                  </span>
                                                </button>
                                                <button
                                                  type="button"
                                                  className={cn(
                                                    'allowlist-item__action',
                                                    'allowlist-item__action--remove',
                                                  )}
                                                  onClick={() =>
                                                    removeDomainMutation.mutate(
                                                      entry.normalizedValue,
                                                    )
                                                  }
                                                  disabled={isDomainMutationPending}
                                                  aria-label={`Удалить ${entry.domain} из белого списка`}
                                                  title="Удалить правило"
                                                >
                                                  <TrashIcon />
                                                  <span>Удалить</span>
                                                </button>
                                              </div>

                                              {isScheduleOpen ? (
                                                <div
                                                  className="allowlist-item__schedule-editor"
                                                  role="group"
                                                  aria-label={`План удаления ${entry.domain}`}
                                                >
                                                  <div className="allowlist-item__schedule-fields">
                                                    <label
                                                      className="field allowlist-item__schedule-field"
                                                      htmlFor={`domain-schedule-date-${entryIdSuffix}`}
                                                    >
                                                      <span className="field__label">
                                                        День удаления
                                                      </span>
                                                      <input
                                                        id={`domain-schedule-date-${entryIdSuffix}`}
                                                        type="date"
                                                        value={scheduleDate}
                                                        min={toLocalDateInputValue(new Date())}
                                                        onChange={(event) => {
                                                          setScheduleDate(event.target.value);
                                                          setScheduleError('');
                                                        }}
                                                      />
                                                    </label>
                                                    <div className="field allowlist-item__schedule-field">
                                                      <Suspense fallback={null}>
                                                        <LazySettingsTimeFields
                                                          kind="schedule"
                                                          value={scheduleTime}
                                                          onChange={(nextValue) => {
                                                            setScheduleTime(nextValue);
                                                            setScheduleError('');
                                                          }}
                                                        />
                                                      </Suspense>
                                                    </div>
                                                  </div>

                                                  {scheduleError ? (
                                                    <small className="field__hint">
                                                      {scheduleError}
                                                    </small>
                                                  ) : null}

                                                  <div className="allowlist-item__schedule-actions">
                                                    <button
                                                      type="button"
                                                      className="button button--accent"
                                                      onClick={() =>
                                                        submitDomainSchedule(entry.normalizedValue)
                                                      }
                                                      disabled={isDomainMutationPending}
                                                    >
                                                      {scheduleDomainRemovalMutation.isPending
                                                        ? 'Сохраняем...'
                                                        : 'Сохранить'}
                                                    </button>
                                                    {entry.removeAfterAt ? (
                                                      <button
                                                        type="button"
                                                        className="button button--ghost"
                                                        onClick={() =>
                                                          clearDomainSchedule(entry.normalizedValue)
                                                        }
                                                        disabled={isDomainMutationPending}
                                                      >
                                                        Убрать таймер
                                                      </button>
                                                    ) : null}
                                                  </div>
                                                </div>
                                              ) : null}
                                            </div>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  </div>
                                ) : (
                                  <p className="allowlist-empty">
                                    Белый список пуст. Добавьте ссылку или домен, которые бот не
                                    будет удалять.
                                  </p>
                                )
                              ) : null}
                            </div>
                          </div>
                        ) : null}

                        {shouldShowLinkStages ? (
                          <>
                            {renderEscalationTuning({
                              title: 'Пороги ссылок',
                              ariaLabelPrefix: 'Пороги ссылок',
                              windowKey: 'linkEscalationWindowHours',
                              warnKey: 'linkWarnMaxCount',
                              muteKey: 'linkMuteMaxCount',
                              banKey: 'linkBanMaxCount',
                            })}

                            <div
                              className="settings-subsection-divider"
                              role="separator"
                              aria-label="Блок действий бота"
                            >
                              <span>Действия бота</span>
                            </div>

                            <div className="settings-native-toggle">
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    1. Объяснение
                                  </span>
                                  <div className="settings-native-toggle__title-actions">
                                    <EditToggleButton
                                      label="Редактировать текст сообщения о ссылках"
                                      onClick={() => toggleBotMessageEditor('link')}
                                      disabled={!draft.linkBotMessageEnabled}
                                      isOpen={openBotEditorKey === 'link'}
                                    />
                                  </div>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить объяснение для модерации ссылок"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.linkBotMessageEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('linkBotMessageEnabled', enabled);
                                      if (!enabled) {
                                        setFieldValue('linkBotButtonEnabled', false);
                                        clearButtonGroupErrors(LINK_BOT_BUTTON_GROUP);
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {draft.linkBotMessageEnabled && openBotEditorKey === 'link' ? (
                                <LazyBotMessageEditor
                                  editorKey="link"
                                  {...botSpeechEditorProps!}
                                  botSpeechPreviewContext={botSpeechPreviewContext}
                                  value={draft.linkBotMessageText}
                                  onChange={(nextValue) =>
                                    setFieldValue(
                                      'linkBotMessageText',
                                      nextValue as ChatSettings['linkBotMessageText'],
                                    )
                                  }
                                  onReset={() => setFieldValue('linkBotMessageText', '')}
                                  onClose={() => setOpenBotEditorKey(null)}
                                />
                              ) : null}
                            </div>

                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    2. Предупреждение
                                  </span>
                                  <div className="settings-native-toggle__title-actions">
                                    <EditToggleButton
                                      label="Редактировать текст предупреждения за ссылки"
                                      onClick={() => toggleWarnMessageEditor('linkWarn')}
                                      isOpen={openWarnEditorKey === 'linkWarn'}
                                    />
                                  </div>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label={`Включить предупреждение за ${draft.linkWarnMaxCount}-ю ссылку`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.linkWarnEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('linkWarnEnabled', enabled);
                                      if (enabled) {
                                        setFieldValue('linkBotMessageEnabled', true);
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {openWarnEditorKey === 'linkWarn' ? (
                                <LazyWarnMessageEditor
                                  editorKey="linkWarn"
                                  {...botSpeechEditorProps!}
                                  botSpeechPreviewContext={botSpeechPreviewContext}
                                  value={draft.linkWarnMessageText}
                                  onChange={(nextValue) =>
                                    setFieldValue(
                                      'linkWarnMessageText',
                                      nextValue as ChatSettings['linkWarnMessageText'],
                                    )
                                  }
                                  onReset={() => setFieldValue('linkWarnMessageText', '')}
                                  onClose={() => setOpenWarnEditorKey(null)}
                                />
                              ) : null}
                            </div>

                            {renderMuteStageToggle({
                              enabledKey: 'linkMuteEnabled',
                              durationKey: 'linkMuteDurationHours',
                              title: '3. Мут',
                              onEnable: () => {
                                setFieldValue('linkWarnEnabled', true);
                                setFieldValue('linkBotMessageEnabled', true);
                              },
                            })}

                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">4. Бан</span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить бан за повторные ссылки"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.linkBanEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('linkBanEnabled', enabled);
                                      if (enabled) {
                                        setFieldValue('linkWarnEnabled', true);
                                        setFieldValue('linkBotMessageEnabled', true);
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>
                            </div>

                            {draft.linkBotMessageEnabled ? (
                              <div
                                className={cn(
                                  'settings-native-toggle',
                                  'settings-native-toggle--nested',
                                  hasLinkBotButtonError && 'field--error',
                                )}
                              >
                                <div className="settings-native-toggle__row">
                                  <div className="settings-native-toggle__title-wrap">
                                    <span className="settings-native-toggle__title">
                                      Добавить кнопку
                                    </span>
                                  </div>

                                  <label
                                    className="settings-native-switch"
                                    aria-label="Добавить кнопку в сообщение бота для модерации ссылок"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={draft.linkBotButtonEnabled}
                                      onChange={(event) => {
                                        const enabled = event.target.checked;
                                        updateDraftButtonGroup(LINK_BOT_BUTTON_GROUP, {
                                          enabled,
                                          ...(enabled && draft.linkBotButtons.length === 0
                                            ? { buttons: [createEmptyBroadcastLinkButton()] }
                                            : {}),
                                        });
                                      }}
                                    />
                                    <span className="toggle-switch" aria-hidden>
                                      <span className="toggle-switch__thumb" />
                                    </span>
                                  </label>
                                </div>

                                {draft.linkBotButtonEnabled ? (
                                  <BroadcastLinkButtonsEditor
                                    api={api}
                                    buttons={draft.linkBotButtons}
                                    errors={linkBotButtonErrors}
                                    onChange={(nextButtons) =>
                                      updateDraftButtonGroup(LINK_BOT_BUTTON_GROUP, {
                                        buttons: nextButtons,
                                        enabled: nextButtons.length > 0,
                                      })
                                    }
                                    title="Кнопки сообщения"
                                    subtitle="Название и ссылка"
                                    urlPlaceholder="https://max.ru/channel/..."
                                    textPlaceholder="Открыть"
                                  />
                                ) : null}
                              </div>
                            ) : null}

                            {renderAdminContactToggle(
                              LINK_ADMIN_CONTACT_BUTTON_GROUP,
                              'Добавить связь с админом в сообщения о ссылках',
                            )}
                          </>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '45ms', order: 21 }}
              aria-label="Правила"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Правила"
                  summary={rulesHeaderSummary}
                  status={rulesCardStatus}
                  icon="rules"
                  tone="ink"
                  open={expandedSections.rules}
                  controls="settings-rules-content"
                  onClick={() => toggleSection('rules')}
                  hideChevron
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-rules-content"
                open={expandedSections.rules}
                title="Правила"
                summary={rulesHeaderSummary}
                variant="screen"
                tone="ink"
                className="settings-drilldown__panel--campaign settings-drilldown__panel--rules settings-drilldown__panel--broadcast-screen settings-drilldown__panel--rules-screen"
                onClose={() => toggleSection('rules')}
                footer={rulesDrilldownFooter}
              >
                <div
                  id="settings-rules-content"
                  className={cn('settings-section__collapse', expandedSections.rules && 'is-open')}
                >
                  {expandedSections.rules ? (
                    <div className="settings-section__collapse-inner">
                      <div className="rules-panel">
                        {rulesQuery.isLoading ? (
                          <p className="allowlist-empty">Загрузка правил...</p>
                        ) : null}

                        {rulesQuery.error ? (
                          <p className="allowlist-empty allowlist-empty--error">
                            Ошибка: {formatApiError(rulesQuery.error)}
                          </p>
                        ) : null}

                        {!rulesQuery.isLoading && !rulesQuery.error && rulesDraft ? (
                          <div className="rules-studio broadcast-studio-screen rules-studio-screen">
                            <div className="broadcast-studio-screen__chrome">
                              <BroadcastStudioHeader
                                title="Пост правил"
                                subtitle={rulesStudioSubtitle}
                                readyCount={rulesStudioReadyCount}
                                totalCount={rulesStudioSignals.length}
                                signals={rulesStudioSignals}
                                busy={isRulesBusy}
                                ariaLabel="Сводка правил"
                              />
                            </div>

                            <div className="broadcast-compose-flow broadcast-compose-flow--screen rules-compose-flow">
                              <div className="broadcast-stage-card broadcast-stage-card--message broadcast-stage-card--primary">
                                <div className="broadcast-stage-card__head">
                                  <div className="broadcast-stage-card__title-wrap">
                                    <strong>Пост</strong>
                                  </div>
                                  <span
                                    className={cn(
                                      'broadcast-stage-card__status',
                                      rulesHasPublishableContent ? 'is-ready' : 'is-pending',
                                    )}
                                  >
                                    {rulesHasPublishableContent ? 'Готов' : 'Пусто'}
                                  </span>
                                </div>

                                <div className="broadcast-stage-card__body">
                                  <Suspense fallback={null}>
                                    <LazyBroadcastContentComposer
                                      className="rules-content-composer"
                                      text={rulesDraft.text}
                                      maxLength={MAX_CHAT_RULES_TEXT_LENGTH}
                                      image={{
                                        enabled: rulesHasImage,
                                        base64: rulesDraft.imageBase64,
                                        mimeType: rulesDraft.imageMimeType,
                                        fileName: rulesDraft.imageFileName,
                                      }}
                                      disabled={isRulesBusy}
                                      textError={rulesTextError}
                                      imageError={rulesImageError}
                                      messageAriaLabel="Пост правил"
                                      textPlaceholder="Текст правил"
                                      textAriaLabel="Текст правил"
                                      onTextChange={(nextText) => {
                                        setRulesTextError('');
                                        setRulesDraft((current) =>
                                          current
                                            ? {
                                                ...current,
                                                autoTextEnabled: false,
                                                text: nextText,
                                              }
                                            : current,
                                        );
                                      }}
                                      onImageChange={(nextImage) => {
                                        setRulesImageError('');
                                        setRulesDraft((current) =>
                                          current
                                            ? {
                                                ...current,
                                                imageBase64: nextImage.enabled
                                                  ? nextImage.base64
                                                  : '',
                                                imageMimeType: nextImage.enabled
                                                  ? nextImage.mimeType
                                                  : '',
                                                imageFileName: nextImage.enabled
                                                  ? nextImage.fileName
                                                  : '',
                                              }
                                            : current,
                                        );
                                      }}
                                      onError={(message) => {
                                        setRulesImageError(message);
                                        pushToast({
                                          tone: 'danger',
                                          title: 'Фото не добавлено',
                                          description: message,
                                        });
                                        maxNotify('error');
                                      }}
                                      buttons={normalizedRulesButtons}
                                      buttonsStatusLabel={rulesButtonStatus}
                                      buttonsActive={rulesButtonEnabled}
                                      buttonsError={!rulesButtonDraftValid}
                                      onOpenButtons={() => setRulesButtonsSheetOpen(true)}
                                    />
                                  </Suspense>
                                </div>
                              </div>

                              <div className="broadcast-stage-card broadcast-stage-card--rules-settings rules-settings-stack">
                                <div className="broadcast-stage-card__head">
                                  <div className="broadcast-stage-card__title-wrap">
                                    <strong>Настройки</strong>
                                  </div>
                                </div>

                                <div className="broadcast-stage-card__body">
                                  <div className="settings-native-toggle rules-native-card">
                                    <div className="settings-native-toggle__row">
                                      <div className="settings-native-toggle__title-wrap">
                                        <div className="rules-native-card__copy">
                                          <span className="settings-native-toggle__title">
                                            Автотекст из настроек
                                          </span>
                                          <span className="rules-native-card__meta">
                                            {rulesAutoFillSummary}
                                          </span>
                                        </div>
                                      </div>

                                      <label
                                        className="settings-native-switch"
                                        aria-label="Включить автотекст правил из настроек"
                                      >
                                        <input
                                          type="checkbox"
                                          checked={Boolean(rulesDraft.autoTextEnabled)}
                                          onChange={(event) => {
                                            const enabled = event.target.checked;
                                            if (!enabled) {
                                              setRulesTextError('');
                                              setRulesDraft((current) =>
                                                current
                                                  ? {
                                                      ...current,
                                                      autoTextEnabled: false,
                                                    }
                                                  : current,
                                              );
                                              return;
                                            }

                                            try {
                                              const nextDraft = buildRulesDraftFromCurrentSettings({
                                                ...rulesDraft,
                                                autoTextEnabled: true,
                                              });
                                              setRulesTextError('');
                                              setRulesDraft((current) =>
                                                current
                                                  ? {
                                                      ...current,
                                                      autoTextEnabled: true,
                                                      text: nextDraft.text,
                                                    }
                                                  : current,
                                              );
                                            } catch (error) {
                                              reportRulesAutofillError(error);
                                            }
                                          }}
                                        />
                                        <span className="toggle-switch" aria-hidden>
                                          <span className="toggle-switch__thumb" />
                                        </span>
                                      </label>
                                    </div>
                                  </div>

                                  <AdminContactToggle
                                    title={ADMIN_CONTACT_BUTTON_TEXT}
                                    checked={Boolean(rulesDraft.adminContactButtonEnabled)}
                                    onChange={handleRulesAdminContactButtonChange}
                                    ariaLabel="Добавить связь с админом в пост правил"
                                    meta={rulesAdminContactButtonSummary}
                                    className="rules-native-card"
                                  />

                                  <div className="settings-native-toggle rules-native-card">
                                    <div className="settings-native-toggle__row">
                                      <div className="settings-native-toggle__title-wrap">
                                        <div className="rules-native-card__copy">
                                          <span className="settings-native-toggle__title">
                                            Кнопка в нарушениях
                                          </span>
                                          <span className="rules-native-card__meta">
                                            {rulesViolationButtonSummary}
                                          </span>
                                        </div>
                                      </div>

                                      <label
                                        className="settings-native-switch"
                                        aria-label="Включить кнопку Правила в сообщениях о нарушениях"
                                      >
                                        <input
                                          type="checkbox"
                                          checked={Boolean(draft?.rulesAttachViolationsEnabled)}
                                          disabled={updateRulesAttachMutation.isPending}
                                          onChange={(event) =>
                                            updateRulesAttachMutation.mutate(event.target.checked)
                                          }
                                        />
                                        <span className="toggle-switch" aria-hidden>
                                          <span className="toggle-switch__thumb" />
                                        </span>
                                      </label>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            {chatId ? (
              <GlassCard
                className="settings-section settings-home-entry settings-home-entry--list stagger-in"
                style={{ animationDelay: '56ms', order: 25 }}
                aria-label="Розыгрыши"
              >
                <div
                  className={cn('settings-section__head', 'settings-section__head--interactive')}
                >
                  <SettingsSectionToggle
                    title="Розыгрыши"
                    summary="Запуск, итоги и реролл в mini app"
                    status="Мини"
                    icon="gift"
                    tone="amber"
                    open={expandedSections.giveaway}
                    controls="settings-giveaway-content"
                    onClick={() => toggleSection('giveaway')}
                    hideChevron
                  />
                </div>

                <SettingsDrilldownPanel
                  id="settings-giveaway-content"
                  open={expandedSections.giveaway}
                  title="Розыгрыши"
                  summary="Запуск, итоги и реролл в mini app"
                  tone="amber"
                  className="settings-drilldown__panel--campaign settings-drilldown__panel--giveaway"
                  onClose={() => toggleSection('giveaway')}
                >
                  <div
                    id="settings-giveaway-content"
                    className={cn(
                      'settings-section__collapse',
                      expandedSections.giveaway && 'is-open',
                    )}
                  >
                    {expandedSections.giveaway ? (
                      <div className="settings-section__collapse-inner">
                        <Suspense fallback={null}>
                          <LazyManagedGiveawayCard api={api} entityType="chat" entityId={chatId} />
                        </Suspense>
                      </div>
                    ) : null}
                  </div>
                </SettingsDrilldownPanel>
              </GlassCard>
            ) : null}

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '60ms', order: 22 }}
              aria-label="Приветствие новых участников"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Приветствие"
                  summary={greetingHeaderSummary}
                  status={greetingCardStatus}
                  icon="greeting"
                  tone="mint"
                  open={expandedSections.greeting}
                  controls="settings-greeting-content"
                  onClick={() => toggleSection('greeting')}
                  hideChevron
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-greeting-content"
                open={expandedSections.greeting}
                title="Приветствие"
                summary={greetingHeaderSummary}
                tone="mint"
                className="settings-drilldown__panel--notice settings-drilldown__panel--greeting"
                onClose={() => toggleSection('greeting')}
                confirmCloseWhen={isSectionDirty('greeting')}
                onDiscardChanges={() => discardSectionChanges('greeting')}
                footer={renderSectionSaveFooter('greeting')}
              >
                <div
                  id="settings-greeting-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.greeting && 'is-open',
                  )}
                >
                  {expandedSections.greeting ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Приветствие</span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'greetingEnabled' && 'is-open',
                              )}
                              aria-label="Пояснение для приветствия новых участников"
                              aria-controls="greeting-enabled-hint"
                              aria-expanded={openHintKey === 'greetingEnabled'}
                              onClick={() => toggleHint('greetingEnabled')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить приветствие новых участников"
                          >
                            <input
                              type="checkbox"
                              checked={draft.greetingEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('greetingEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('greetingBotMessageEnabled', true);
                                }
                                if (!enabled) {
                                  setFieldValue('greetingBotButtonEnabled', false);
                                  setFieldValue('greetingRulesButtonEnabled', false);
                                  clearFieldError('greetingRulesButtonEnabled');
                                  clearButtonGroupErrors(GREETING_BOT_BUTTON_GROUP);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'greetingEnabled' ? (
                          <p id="greeting-enabled-hint" className="settings-native-toggle__hint">
                            Бот отправит приветствие, когда в чат добавляют нового участника.
                          </p>
                        ) : null}
                      </div>

                      {draft.greetingEnabled ? (
                        <>
                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Сообщение от бота
                                </span>
                                <div className="settings-native-toggle__title-actions">
                                  <EditToggleButton
                                    label="Редактировать текст приветствия"
                                    onClick={() => toggleBotMessageEditor('greeting')}
                                    disabled={!draft.greetingBotMessageEnabled}
                                    isOpen={openBotEditorKey === 'greeting'}
                                  />
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'greetingBotMessage' && 'is-open',
                                    )}
                                    aria-label="Пояснение для сообщения приветствия"
                                    aria-controls="greeting-bot-message-hint"
                                    aria-expanded={openHintKey === 'greetingBotMessage'}
                                    onClick={() => toggleHint('greetingBotMessage')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить сообщение от бота для приветствия"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.greetingBotMessageEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('greetingBotMessageEnabled', enabled);
                                    if (!enabled) {
                                      setFieldValue('greetingBotButtonEnabled', false);
                                      setFieldValue('greetingRulesButtonEnabled', false);
                                      clearFieldError('greetingRulesButtonEnabled');
                                      clearButtonGroupErrors(GREETING_BOT_BUTTON_GROUP);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'greetingBotMessage' ? (
                              <p
                                id="greeting-bot-message-hint"
                                className="settings-native-toggle__hint"
                              >
                                Текст приветствия отправляется только для обычных пользователей,
                                боты исключаются.
                              </p>
                            ) : null}

                            {draft.greetingBotMessageEnabled && openBotEditorKey === 'greeting' ? (
                              <LazyBotMessageEditor
                                editorKey="greeting"
                                {...botSpeechEditorProps!}
                                botSpeechPreviewContext={botSpeechPreviewContext}
                                value={draft.greetingBotMessageText}
                                onChange={(nextValue) =>
                                  setFieldValue(
                                    'greetingBotMessageText',
                                    nextValue as ChatSettings['greetingBotMessageText'],
                                  )
                                }
                                onReset={() => setFieldValue('greetingBotMessageText', '')}
                                onClose={() => setOpenBotEditorKey(null)}
                              />
                            ) : null}
                          </div>

                          {draft.greetingBotMessageEnabled ? (
                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    Удалять приветствие
                                  </span>
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'greetingDeleteBotMessages' && 'is-open',
                                    )}
                                    aria-label="Пояснение для автоудаления приветствия"
                                    aria-controls="greeting-delete-bot-messages-hint"
                                    aria-expanded={openHintKey === 'greetingDeleteBotMessages'}
                                    onClick={() => toggleHint('greetingDeleteBotMessages')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить автоудаление приветственных сообщений бота"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.greetingDeleteBotMessageEnabled}
                                    onChange={(event) =>
                                      setFieldValue(
                                        'greetingDeleteBotMessageEnabled',
                                        event.target.checked,
                                      )
                                    }
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {openHintKey === 'greetingDeleteBotMessages' ? (
                                <p
                                  id="greeting-delete-bot-messages-hint"
                                  className="settings-native-toggle__hint"
                                >
                                  Бот будет автоматически удалять приветствие через выбранное время.
                                </p>
                              ) : null}
                            </div>
                          ) : null}

                          {draft.greetingBotMessageEnabled &&
                          draft.greetingDeleteBotMessageEnabled ? (
                            <DeleteDelayStepper
                              title="Через сколько удалять"
                              value={draft.greetingDeleteBotMessageDelayMinutes}
                              fieldError={fieldErrors.greetingDeleteBotMessageDelayMinutes}
                              groupAriaLabel="Задержка удаления приветствия"
                              decreaseAriaLabel="Уменьшить задержку удаления приветствия"
                              increaseAriaLabel="Увеличить задержку удаления приветствия"
                              onAdjust={adjustGreetingDeleteBotMessagesDelay}
                            />
                          ) : null}

                          {draft.greetingBotMessageEnabled ? (
                            <div
                              className={cn(
                                'settings-native-toggle',
                                'settings-native-toggle--nested',
                                hasGreetingBotButtonError && 'field--error',
                              )}
                            >
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    Добавить кнопку
                                  </span>
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'greetingBotButton' && 'is-open',
                                    )}
                                    aria-label="Пояснение для кнопки в приветствии"
                                    aria-controls="greeting-bot-button-hint"
                                    aria-expanded={openHintKey === 'greetingBotButton'}
                                    onClick={() => toggleHint('greetingBotButton')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Добавить кнопку в приветственное сообщение"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.greetingBotButtonEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      updateDraftButtonGroup(GREETING_BOT_BUTTON_GROUP, {
                                        enabled,
                                        ...(enabled && draft.greetingBotButtons.length === 0
                                          ? { buttons: [createEmptyBroadcastLinkButton()] }
                                          : {}),
                                      });
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {renderInlineHint(
                                'greetingBotButton',
                                'greeting-bot-button-hint',
                                'Добавляет кнопку в приветствие, например на чат или канал.',
                                hasGreetingBotButtonError,
                              )}

                              {draft.greetingBotButtonEnabled ? (
                                <BroadcastLinkButtonsEditor
                                  api={api}
                                  buttons={draft.greetingBotButtons}
                                  errors={greetingBotButtonErrors}
                                  onChange={(nextButtons) =>
                                    updateDraftButtonGroup(GREETING_BOT_BUTTON_GROUP, {
                                      buttons: nextButtons,
                                      enabled: nextButtons.length > 0,
                                    })
                                  }
                                  urlPlaceholder="https://max.ru/channel/rules"
                                  textPlaceholder="Открыть"
                                  title="Кнопки сообщения"
                                  subtitle="Название и ссылка"
                                />
                              ) : null}
                            </div>
                          ) : null}

                          {draft.greetingBotMessageEnabled ? (
                            <PublishedRulesButtonToggleSlot
                              ariaLabel="Кнопка Правила в приветствии"
                              enabled={draft.greetingRulesButtonEnabled}
                              hasRules={hasPublishedRules}
                              onChange={(enabled) =>
                                setFieldValue('greetingRulesButtonEnabled', enabled)
                              }
                            />
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '90ms', order: 11 }}
              aria-label="Мат и оскорбления"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Мат и оскорбления"
                  summary={profanityFilterHeaderSummary}
                  status={profanityFilterCardStatus}
                  icon="warning"
                  tone="rose"
                  open={expandedSections.profanityFilter}
                  controls="settings-profanity-filter-content"
                  onClick={() => toggleSection('profanityFilter')}
                  hideChevron
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-profanity-filter-content"
                open={expandedSections.profanityFilter}
                title="Мат и оскорбления"
                summary={profanityFilterHeaderSummary}
                tone="rose"
                className="settings-drilldown__panel--ladder settings-drilldown__panel--profanity"
                onClose={() => toggleSection('profanityFilter')}
                confirmCloseWhen={isSectionDirty('profanityFilter')}
                onDiscardChanges={() => discardSectionChanges('profanityFilter')}
                footer={renderSectionSaveFooter('profanityFilter')}
              >
                <div
                  id="settings-profanity-filter-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.profanityFilter && 'is-open',
                  )}
                >
                  {expandedSections.profanityFilter ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle text-filter-card">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Нецензурная лексика (RU)
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'textFiltersProfanity' && 'is-open',
                              )}
                              aria-label='Пояснение для "Нецензурная лексика (RU)"'
                              aria-controls="russian-profanity-filter-enabled-hint"
                              aria-expanded={openHintKey === 'textFiltersProfanity'}
                              onClick={() => toggleHint('textFiltersProfanity')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Нецензурная лексика (RU)"
                          >
                            <input
                              type="checkbox"
                              checked={draft.russianProfanityFilterEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('russianProfanityFilterEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('profanityBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'textFiltersProfanity' ? (
                          <p
                            id="russian-profanity-filter-enabled-hint"
                            className="settings-native-toggle__hint"
                          >
                            Удаляет сообщения с матом и грубой лексикой на русском.
                          </p>
                        ) : null}
                      </div>

                      {draft.russianProfanityFilterEnabled ? (
                        <>
                          <div
                            className="settings-subsection-divider"
                            role="separator"
                            aria-label="Действия бота для нецензурной лексики"
                          >
                            <span>Действия бота · Нецензурная лексика</span>
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">1. Объяснение</span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить объяснение для нецензурной лексики"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.profanityBotMessageEnabled}
                                  onChange={(event) =>
                                    setFieldValue(
                                      'profanityBotMessageEnabled',
                                      event.target.checked,
                                    )
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">
                                2. Предупреждение
                              </span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить предупреждение за нецензурную лексику"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.profanityWarnEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('profanityWarnEnabled', enabled);
                                    if (enabled) {
                                      setFieldValue('profanityBotMessageEnabled', true);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          {renderMuteStageToggle({
                            enabledKey: 'profanityMuteEnabled',
                            durationKey: 'profanityMuteDurationHours',
                            title: '3. Мут',
                            onEnable: () => {
                              setFieldValue('profanityWarnEnabled', true);
                              setFieldValue('profanityBotMessageEnabled', true);
                            },
                          })}

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">4. Бан</span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить бан за повторную нецензурную лексику"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.profanityBanEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('profanityBanEnabled', enabled);
                                    if (enabled) {
                                      setFieldValue('profanityWarnEnabled', true);
                                      setFieldValue('profanityBotMessageEnabled', true);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          {renderAdminContactToggle(
                            PROFANITY_ADMIN_CONTACT_BUTTON_GROUP,
                            'Добавить связь с админом в сообщения о нецензурной лексике',
                          )}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '135ms', order: 12 }}
              aria-label="Коммерческая реклама"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Коммерческая реклама"
                  summary={commercialFilterHeaderSummary}
                  status={commercialFilterCardStatus}
                  icon="ads"
                  tone="amber"
                  open={expandedSections.commercialFilter}
                  controls="settings-commercial-filter-content"
                  onClick={() => toggleSection('commercialFilter')}
                  hideChevron
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-commercial-filter-content"
                open={expandedSections.commercialFilter}
                title="Коммерческая реклама"
                summary={commercialFilterHeaderSummary}
                tone="amber"
                className="settings-drilldown__panel--ladder settings-drilldown__panel--commercial"
                onClose={() => toggleSection('commercialFilter')}
                confirmCloseWhen={isSectionDirty('commercialFilter')}
                onDiscardChanges={() => discardSectionChanges('commercialFilter')}
                footer={renderSectionSaveFooter('commercialFilter')}
              >
                <div
                  id="settings-commercial-filter-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.commercialFilter && 'is-open',
                  )}
                >
                  {expandedSections.commercialFilter ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle text-filter-card">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Фильтр рекламы</span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'textFiltersCommercial' && 'is-open',
                              )}
                              aria-label='Пояснение для "Фильтровать коммерческую рекламу"'
                              aria-controls="commercial-ads-filter-enabled-hint"
                              aria-expanded={openHintKey === 'textFiltersCommercial'}
                              onClick={() => toggleHint('textFiltersCommercial')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Фильтровать коммерческую рекламу"
                          >
                            <input
                              type="checkbox"
                              checked={draft.commercialAdsFilterEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('commercialAdsFilterEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('textFiltersBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'textFiltersCommercial' ? (
                          <p
                            id="commercial-ads-filter-enabled-hint"
                            className="settings-native-toggle__hint"
                          >
                            Бот ищет именно рекламную подачу: массовые объявления, услуги с
                            контактами, продажи со скидками, доставкой, ссылками и призывом написать
                            или позвонить. Частные объявления и бытовые разовые продажи старается
                            пропускать.
                          </p>
                        ) : null}
                      </div>

                      {draft.commercialAdsFilterEnabled ? (
                        <>
                          <div
                            className="settings-subsection-divider"
                            role="separator"
                            aria-label="Параметры коммерческого фильтра"
                          >
                            <span>Фильтр коммерческой рекламы</span>
                          </div>

                          <div className="settings-native-toggle commercial-settings-panel">
                            <div className="commercial-sensitivity-slider">
                              <div className="commercial-sensitivity-slider__head">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="field__label">Чувствительность</span>
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'commercialSensitivity' && 'is-open',
                                    )}
                                    aria-label="Пояснение по чувствительности коммерческого фильтра"
                                    aria-controls="commercial-sensitivity-hint"
                                    aria-expanded={openHintKey === 'commercialSensitivity'}
                                    onClick={() => toggleHint('commercialSensitivity')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                                <span className="chip chip--warning">
                                  {commercialSensitivityLabel}
                                </span>
                              </div>

                              <input
                                type="range"
                                min={COMMERCIAL_SENSITIVITY_MIN}
                                max={COMMERCIAL_SENSITIVITY_MAX}
                                step={1}
                                value={commercialSensitivitySliderValue}
                                onChange={(event) =>
                                  handleCommercialSensitivitySliderChange(
                                    Number(event.target.value),
                                  )
                                }
                                aria-label="Ползунок чувствительности коммерческого фильтра"
                              />

                              <div className="commercial-sensitivity-slider__labels" aria-hidden>
                                <span>Мягко</span>
                                <span>Баланс</span>
                                <span>Строго</span>
                              </div>
                            </div>

                            {openHintKey === 'commercialSensitivity' ? (
                              <p
                                id="commercial-sensitivity-hint"
                                className="settings-native-toggle__hint"
                              >
                                Сейчас бот считает объявление подозрительным с{' '}
                                {draft.commercialAdsWarnThreshold} баллов, а как явную рекламу
                                удаляет с {draft.commercialAdsDeleteThreshold}. `Мягко` реже трогает
                                спорные частные объявления, `Строго` быстрее режет саморекламу и
                                повторные коммерческие посты.
                              </p>
                            ) : null}
                          </div>

                          <div
                            className="settings-subsection-divider"
                            role="separator"
                            aria-label="Действия бота для коммерческих объявлений"
                          >
                            <span>Действия бота · Коммерческая реклама</span>
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">1. Объяснение</span>
                                <div className="settings-native-toggle__title-actions">
                                  <EditToggleButton
                                    label="Редактировать текст сообщения об удалении рекламы"
                                    onClick={() => toggleBotMessageEditor('textFilters')}
                                    disabled={!draft.textFiltersBotMessageEnabled}
                                    isOpen={openBotEditorKey === 'textFilters'}
                                  />
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'textFiltersBotMessage' && 'is-open',
                                    )}
                                    aria-label="Пояснение для тумблера сообщений о коммерческих объявлениях"
                                    aria-controls="text-filters-bot-message-hint"
                                    aria-expanded={openHintKey === 'textFiltersBotMessage'}
                                    onClick={() => toggleHint('textFiltersBotMessage')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить сообщение от бота для коммерческих объявлений"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.textFiltersBotMessageEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('textFiltersBotMessageEnabled', enabled);
                                    if (!enabled) {
                                      setFieldValue('textFiltersBotButtonEnabled', false);
                                      clearButtonGroupErrors(TEXT_FILTERS_BOT_BUTTON_GROUP);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'textFiltersBotMessage' ? (
                              <p
                                id="text-filters-bot-message-hint"
                                className="settings-native-toggle__hint"
                              >
                                Санкции усиливаются по ступеням, если пользователь повторно нарушает
                                коммерческий фильтр в течение 24 часов.
                              </p>
                            ) : null}

                            {draft.textFiltersBotMessageEnabled &&
                            openBotEditorKey === 'textFilters' ? (
                              <LazyBotMessageEditor
                                editorKey="textFilters"
                                {...botSpeechEditorProps!}
                                botSpeechPreviewContext={botSpeechPreviewContext}
                                value={draft.textFiltersBotMessageText}
                                onChange={(nextValue) =>
                                  setFieldValue(
                                    'textFiltersBotMessageText',
                                    nextValue as ChatSettings['textFiltersBotMessageText'],
                                  )
                                }
                                onReset={() => setFieldValue('textFiltersBotMessageText', '')}
                                onClose={() => setOpenBotEditorKey(null)}
                              />
                            ) : null}
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  2. Предупреждение
                                </span>
                                <div className="settings-native-toggle__title-actions">
                                  <EditToggleButton
                                    label="Редактировать текст предупреждения об удалении рекламы"
                                    onClick={() => toggleWarnMessageEditor('textFiltersWarn')}
                                    isOpen={openWarnEditorKey === 'textFiltersWarn'}
                                  />
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'textFiltersWarnMessage' && 'is-open',
                                    )}
                                    aria-label="Пояснение для предупреждения о коммерческих объявлениях"
                                    aria-controls="text-filters-warn-message-hint"
                                    aria-expanded={openHintKey === 'textFiltersWarnMessage'}
                                    onClick={() => toggleHint('textFiltersWarnMessage')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить предупреждение за второе нарушение коммерческого фильтра"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.textFiltersWarnEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('textFiltersWarnEnabled', enabled);
                                    if (enabled) {
                                      setFieldValue('textFiltersBotMessageEnabled', true);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'textFiltersWarnMessage' ? (
                              <p
                                id="text-filters-warn-message-hint"
                                className="settings-native-toggle__hint"
                              >
                                Текст отправляется при 2-м нарушении коммерческого фильтра за 24
                                часа.
                              </p>
                            ) : null}

                            {openWarnEditorKey === 'textFiltersWarn' ? (
                              <LazyWarnMessageEditor
                                editorKey="textFiltersWarn"
                                {...botSpeechEditorProps!}
                                botSpeechPreviewContext={botSpeechPreviewContext}
                                value={draft.textFiltersWarnMessageText}
                                onChange={(nextValue) =>
                                  setFieldValue(
                                    'textFiltersWarnMessageText',
                                    nextValue as ChatSettings['textFiltersWarnMessageText'],
                                  )
                                }
                                onReset={() => setFieldValue('textFiltersWarnMessageText', '')}
                                onClose={() => setOpenWarnEditorKey(null)}
                              />
                            ) : null}
                          </div>

                          {renderMuteStageToggle({
                            enabledKey: 'textFiltersMuteEnabled',
                            durationKey: 'textFiltersMuteDurationHours',
                            title: '3. Мут',
                            onEnable: () => {
                              setFieldValue('textFiltersWarnEnabled', true);
                              setFieldValue('textFiltersBotMessageEnabled', true);
                            },
                          })}

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">4. Бан</span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить бан за повторное нарушение коммерческого фильтра"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.textFiltersBanEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('textFiltersBanEnabled', enabled);
                                    if (enabled) {
                                      setFieldValue('textFiltersWarnEnabled', true);
                                      setFieldValue('textFiltersBotMessageEnabled', true);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          {draft.textFiltersBotMessageEnabled ? (
                            <div
                              className={cn(
                                'settings-native-toggle',
                                'settings-native-toggle--nested',
                                hasTextFiltersBotButtonError && 'field--error',
                              )}
                            >
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    Добавить кнопку
                                  </span>
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'textFiltersBotButton' && 'is-open',
                                    )}
                                    aria-label="Пояснение для кнопки в сообщении о коммерции"
                                    aria-controls="text-filters-bot-button-hint"
                                    aria-expanded={openHintKey === 'textFiltersBotButton'}
                                    onClick={() => toggleHint('textFiltersBotButton')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Добавить кнопку в сообщение бота о коммерческих объявлениях"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.textFiltersBotButtonEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      updateDraftButtonGroup(TEXT_FILTERS_BOT_BUTTON_GROUP, {
                                        enabled,
                                        ...(enabled && draft.textFiltersBotButtons.length === 0
                                          ? { buttons: [createEmptyBroadcastLinkButton()] }
                                          : {}),
                                      });
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {renderInlineHint(
                                'textFiltersBotButton',
                                'text-filters-bot-button-hint',
                                'Добавляет кнопку в сообщение бота о коммерческом нарушении.',
                                hasTextFiltersBotButtonError,
                              )}

                              {draft.textFiltersBotButtonEnabled ? (
                                <BroadcastLinkButtonsEditor
                                  api={api}
                                  buttons={draft.textFiltersBotButtons}
                                  errors={textFiltersBotButtonErrors}
                                  onChange={(nextButtons) =>
                                    updateDraftButtonGroup(TEXT_FILTERS_BOT_BUTTON_GROUP, {
                                      buttons: nextButtons,
                                      enabled: nextButtons.length > 0,
                                    })
                                  }
                                  urlPlaceholder="https://max.ru/channel/rules"
                                  textPlaceholder="Правила чата"
                                  title="Кнопки сообщения"
                                  subtitle="Название и ссылка"
                                />
                              ) : null}
                            </div>
                          ) : null}

                          {renderAdminContactToggle(
                            TEXT_FILTERS_ADMIN_CONTACT_BUTTON_GROUP,
                            'Добавить связь с админом в сообщения о коммерческих объявлениях',
                          )}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>


            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '180ms', order: 15 }}
              aria-label="Повторы"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Повторы"
                  summary={duplicatesHeaderSummary}
                  status={duplicatesCardStatus}
                  icon="repeat"
                  tone="rose"
                  open={expandedSections.duplicates}
                  controls="settings-duplicates-content"
                  onClick={() => toggleSection('duplicates')}
                  hideChevron
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-duplicates-content"
                open={expandedSections.duplicates}
                title="Повторы"
                summary={duplicatesHeaderSummary}
                tone="rose"
                className="settings-drilldown__panel--ladder settings-drilldown__panel--duplicates"
                onClose={() => toggleSection('duplicates')}
                confirmCloseWhen={isSectionDirty('duplicates')}
                onDiscardChanges={() => discardSectionChanges('duplicates')}
                footer={renderSectionSaveFooter('duplicates')}
              >
                <div
                  id="settings-duplicates-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.duplicates && 'is-open',
                  )}
                >
                  {expandedSections.duplicates ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Антидубль</span>
                            <SettingsHintAnchor
                              hintKey="antiDuplicate"
                              openHintKey={openHintKey}
                              onToggleHint={toggleHint}
                              label="Пояснение для антидубля"
                            >
                              Удаляет повтор и применяет ступени ниже к автору.
                            </SettingsHintAnchor>
                          </div>
                          <label className="settings-native-switch" aria-label="Включить антидубль">
                            <input
                              type="checkbox"
                              checked={draft.antiDuplicateEnabled}
                              onChange={(event) => {
                                setFieldValue('antiDuplicateEnabled', event.target.checked);
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      {draft.antiDuplicateEnabled ? (
                        <div className="settings-policy">
                          <div className="settings-policy__label-row">
                            <span className="field__label">Режим распознавания</span>
                            <SettingsHintAnchor
                              hintKey="duplicateDetectionMode"
                              openHintKey={openHintKey}
                              onToggleHint={toggleHint}
                              label="Пояснение для режима распознавания дублей"
                            >
                              Строгий: похожий текст. Точный: сообщение целиком. Свой: ручные
                              правила.
                            </SettingsHintAnchor>
                          </div>
                          <SegmentedControl
                            value={draft.duplicateDetectionPreset}
                            options={DUPLICATE_DETECTION_OPTIONS}
                            onChange={applyDuplicateDetectionPreset}
                            className="settings-mode-segments"
                            ariaLabel="Режим распознавания дублей"
                          />
                        </div>
                      ) : null}

                      {draft.antiDuplicateEnabled && draft.duplicateDetectionPreset === 'CUSTOM' ? (
                        <>
                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Одинаковая ссылка
                                </span>
                                <SettingsHintAnchor
                                  hintKey="duplicateIgnoreLinks"
                                  openHintKey={openHintKey}
                                  onToggleHint={toggleHint}
                                  label="Пояснение для одинаковой ссылки в дублях"
                                >
                                  Вкл: та же ссылка считается дублем. Выкл: проверяется текст.
                                </SettingsHintAnchor>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Считать одинаковую ссылку дублем"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.duplicateIgnoreLinksEnabled}
                                  onChange={(event) =>
                                    setFieldValue(
                                      'duplicateIgnoreLinksEnabled',
                                      event.target.checked,
                                    )
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Одинаковый номер
                                </span>
                                <SettingsHintAnchor
                                  hintKey="duplicateIgnorePhones"
                                  openHintKey={openHintKey}
                                  onToggleHint={toggleHint}
                                  label="Пояснение для одинакового номера в дублях"
                                >
                                  Вкл: тот же номер считается дублем. Выкл: проверяется текст.
                                </SettingsHintAnchor>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Считать одинаковый номер дублем"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.duplicateIgnorePhonesEnabled}
                                  onChange={(event) =>
                                    setFieldValue(
                                      'duplicateIgnorePhonesEnabled',
                                      event.target.checked,
                                    )
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Близкие совпадения
                                </span>
                                <SettingsHintAnchor
                                  hintKey="duplicateNearMatch"
                                  openHintKey={openHintKey}
                                  onToggleHint={toggleHint}
                                  label="Пояснение для близких совпадений дублей"
                                >
                                  Ловит перестановки и небольшие правки в том же тексте.
                                </SettingsHintAnchor>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить близкие совпадения дублей"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.duplicateNearMatchEnabled}
                                  onChange={(event) =>
                                    setFieldValue('duplicateNearMatchEnabled', event.target.checked)
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>
                        </>
                      ) : null}

                      {draft.antiDuplicateEnabled ? (
                        <div className="settings-native-toggle">
                          <div className="settings-native-toggle__row">
                            <div className="settings-native-toggle__title-wrap">
                              <span className="settings-native-toggle__title">1. Объяснение</span>
                              <div className="settings-native-toggle__title-actions">
                                <EditToggleButton
                                  label="Текст о дублях"
                                  onClick={() => toggleBotMessageEditor('duplicate')}
                                  disabled={!draft.duplicateBotMessageEnabled}
                                  isOpen={openBotEditorKey === 'duplicate'}
                                />
                              </div>
                            </div>

                            <label
                              className="settings-native-switch"
                              aria-label="Сообщение о дублях"
                            >
                              <input
                                type="checkbox"
                                checked={draft.duplicateBotMessageEnabled}
                                onChange={(event) => {
                                  const enabled = event.target.checked;
                                  applyDuplicateFlowConfig({
                                    duplicateBotMessageEnabled: enabled,
                                  });
                                  if (!enabled) {
                                    setFieldValue('duplicateBotButtonEnabled', false);
                                    clearButtonGroupErrors(DUPLICATE_BOT_BUTTON_GROUP);
                                  }
                                }}
                              />
                              <span className="toggle-switch" aria-hidden>
                                <span className="toggle-switch__thumb" />
                              </span>
                            </label>
                          </div>

                          {draft.duplicateBotMessageEnabled && openBotEditorKey === 'duplicate' ? (
                            <LazyBotMessageEditor
                              editorKey="duplicate"
                              {...botSpeechEditorProps!}
                              botSpeechPreviewContext={botSpeechPreviewContext}
                              value={draft.duplicateBotMessageText}
                              onChange={(nextValue) =>
                                setFieldValue(
                                  'duplicateBotMessageText',
                                  nextValue as ChatSettings['duplicateBotMessageText'],
                                )
                              }
                              onReset={() => setFieldValue('duplicateBotMessageText', '')}
                              onClose={() => setOpenBotEditorKey(null)}
                            />
                          ) : null}
                        </div>
                      ) : null}

                      {draft.antiDuplicateEnabled && draft.duplicateBotMessageEnabled ? (
                        <>
                          <div
                            className={cn(
                              'settings-native-toggle',
                              'settings-native-toggle--nested',
                              hasDuplicateBotButtonError && 'field--error',
                            )}
                          >
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Добавить кнопку
                                </span>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Кнопка в сообщении о дублях"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.duplicateBotButtonEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    updateDraftButtonGroup(DUPLICATE_BOT_BUTTON_GROUP, {
                                      enabled,
                                      ...(enabled && draft.duplicateBotButtons.length === 0
                                        ? { buttons: [createEmptyBroadcastLinkButton()] }
                                        : {}),
                                    });
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {draft.duplicateBotButtonEnabled ? (
                              <BroadcastLinkButtonsEditor
                                api={api}
                                buttons={draft.duplicateBotButtons}
                                errors={duplicateBotButtonErrors}
                                onChange={(nextButtons) =>
                                  updateDraftButtonGroup(DUPLICATE_BOT_BUTTON_GROUP, {
                                    buttons: nextButtons,
                                    enabled: nextButtons.length > 0,
                                  })
                                }
                                urlPlaceholder="https://max.ru/profile/..."
                                textPlaceholder="Открыть"
                                title="Кнопки сообщения"
                                subtitle="Название и ссылка"
                              />
                            ) : null}
                          </div>

                          {renderAdminContactToggle(
                            DUPLICATE_ADMIN_CONTACT_BUTTON_GROUP,
                            'Добавить связь с админом в сообщения о дублях',
                          )}
                        </>
                      ) : null}

                      {draft.antiDuplicateEnabled ? (
                        <>
                          <article
                            className={cn(
                              'duplicate-stage',
                              (fieldErrors.duplicateWarnWindowSec ||
                                fieldErrors.duplicateWarnMaxCount) &&
                                'field--error',
                            )}
                          >
                            <div className="duplicate-stage__top">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="duplicate-stage__title">
                                  Когда включать модерацию
                                </span>
                                <SettingsHintAnchor
                                  hintKey="duplicateModerationStart"
                                  openHintKey={openHintKey}
                                  onToggleHint={toggleHint}
                                  label="Пояснение для порога дублей"
                                >
                                  Интервал: окно поиска. Разрешено дублей: сколько пропустить до
                                  ступеней.
                                </SettingsHintAnchor>
                              </div>
                            </div>

                            <div className="duplicate-stage__controls">
                              <label
                                className={cn(
                                  'duplicate-stage__field',
                                  fieldErrors.duplicateWarnWindowSec && 'field--error',
                                )}
                              >
                                <span className="duplicate-stage__field-label">Интервал</span>
                                <div className="duplicate-stage__input-wrap">
                                  <input
                                    type="number"
                                    min={1}
                                    max={168}
                                    step={1}
                                    value={
                                      duplicateWindowInputValue ||
                                      String(duplicateSharedWindowHours)
                                    }
                                    onChange={(event) =>
                                      handleDuplicateWindowHoursChange(event.target.value)
                                    }
                                    onBlur={handleDuplicateWindowHoursBlur}
                                    aria-label="Интервал дублей, часы"
                                  />
                                  <span className="duplicate-stage__suffix" aria-hidden>
                                    часы
                                  </span>
                                </div>
                              </label>

                              <div
                                className={cn(
                                  'duplicate-stage__field',
                                  fieldErrors.duplicateWarnMaxCount && 'field--error',
                                )}
                              >
                                <span className="duplicate-stage__field-label">
                                  Разрешено дублей
                                </span>
                                <div
                                  className="duplicate-count-stepper"
                                  role="group"
                                  aria-label="Разрешено дублей"
                                >
                                  <button
                                    type="button"
                                    className="duplicate-count-stepper__button"
                                    onClick={() =>
                                      adjustDuplicateAllowedCount(duplicateAllowedCount, -1)
                                    }
                                    disabled={duplicateAllowedCount <= DUPLICATE_ALLOWED_COUNT_MIN}
                                    aria-label="Меньше дублей"
                                  >
                                    -
                                  </button>

                                  <output
                                    className="duplicate-count-stepper__value"
                                    aria-live="polite"
                                  >
                                    {duplicateAllowedCount}
                                  </output>

                                  <button
                                    type="button"
                                    className="duplicate-count-stepper__button"
                                    onClick={() =>
                                      adjustDuplicateAllowedCount(duplicateAllowedCount, 1)
                                    }
                                    disabled={duplicateAllowedCount >= DUPLICATE_ALLOWED_COUNT_MAX}
                                    aria-label="Больше дублей"
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                            </div>

                            {fieldErrors.duplicateWarnWindowSec ||
                            fieldErrors.duplicateWarnMaxCount ? (
                              <div className="duplicate-stage__errors">
                                {fieldErrors.duplicateWarnWindowSec ? (
                                  <small className="field__hint">
                                    {fieldErrors.duplicateWarnWindowSec}
                                  </small>
                                ) : null}
                                {fieldErrors.duplicateWarnMaxCount ? (
                                  <small className="field__hint">
                                    {fieldErrors.duplicateWarnMaxCount}
                                  </small>
                                ) : null}
                              </div>
                            ) : null}
                          </article>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">
                                2. Предупреждение
                              </span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить предупреждение за повторы"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.duplicateWarnEnabled}
                                  onChange={(event) =>
                                    applyDuplicateFlowConfig({
                                      duplicateWarnEnabled: event.target.checked,
                                    })
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>

                          <div
                            className={cn(
                              'settings-native-toggle',
                              'settings-native-toggle--nested',
                              fieldErrors.duplicateMuteDurationHours && 'field--error',
                            )}
                          >
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">3. Мут</span>
                                <div className="settings-native-toggle__title-actions">
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-duration-editor__preset settings-duration-editor__preset--trigger',
                                      openMuteDurationKey === 'duplicateMuteDurationHours' &&
                                        'is-active',
                                    )}
                                    onClick={() =>
                                      toggleMuteDurationEditor('duplicateMuteDurationHours')
                                    }
                                  >
                                    <ClockIcon />
                                    <span>
                                      {formatMuteDurationCompact(
                                        Number(draft.duplicateMuteDurationHours),
                                      )}
                                    </span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить мут за повторы"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.duplicateMuteEnabled}
                                  onChange={(event) =>
                                    applyDuplicateFlowConfig({
                                      duplicateMuteEnabled: event.target.checked,
                                    })
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {renderMuteDurationEditor('duplicateMuteDurationHours', 'Срок мута')}

                            {fieldErrors.duplicateMuteDurationHours ? (
                              <small className="field__hint">
                                {fieldErrors.duplicateMuteDurationHours}
                              </small>
                            ) : null}
                          </div>

                          <div className="settings-native-toggle settings-native-toggle--nested">
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title">4. Бан</span>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить бан за повторы"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.duplicateBanEnabled}
                                  onChange={(event) =>
                                    applyDuplicateFlowConfig({
                                      duplicateBanEnabled: event.target.checked,
                                    })
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
              style={{ animationDelay: '225ms', order: 2 }}
              aria-label="Ограничения"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Ограничения"
                  summary={`${limitsRulesEnabledCount} ограничений активно`}
                  status={limitsCardStatus}
                  icon="shield"
                  tone="ink"
                  open={expandedSections.limits}
                  controls="settings-limits-content"
                  onClick={() => toggleSection('limits')}
                  hideChevron
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-limits-content"
                open={expandedSections.limits}
                title="Ограничения"
                summary={`${limitsRulesEnabledCount} ограничений активно`}
                tone="ink"
                className="settings-drilldown__panel--ladder settings-drilldown__panel--limits"
                onClose={() => toggleSection('limits')}
                confirmCloseWhen={isSectionDirty('limits')}
                onDiscardChanges={() => discardSectionChanges('limits')}
                footer={renderSectionSaveFooter('limits')}
              >
                <div
                  id="settings-limits-content"
                  className={cn('settings-section__collapse', expandedSections.limits && 'is-open')}
                >
                  {expandedSections.limits ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Анти-спам</span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'antiSpam' && 'is-open',
                              )}
                              aria-label="Пояснение для анти-спама"
                              aria-controls="anti-spam-hint"
                              aria-expanded={openHintKey === 'antiSpam'}
                              onClick={() => toggleHint('antiSpam')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label className="settings-native-switch" aria-label="Включить анти-спам">
                            <input
                              type="checkbox"
                              checked={draft.antiSpamEnabled}
                              onChange={(event) =>
                                setFieldValue('antiSpamEnabled', event.target.checked)
                              }
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'antiSpam' ? (
                          <p id="anti-spam-hint" className="settings-native-toggle__hint">
                            Системная защита от скоростного флуда: при опасном всплеске бот удаляет
                            сообщение и банит отправителя. Порог не настраивается через UI.
                          </p>
                        ) : null}
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Удалять спамеров</span>
                            <div className="settings-native-toggle__title-actions">
                              <span
                                className={cn(
                                  'settings-native-toggle__status',
                                  draft.deleteSpammersEnabled && 'is-active',
                                  spammerReviewMetricsQuery.data?.enforcementMode === 'shadow' &&
                                    draft.deleteSpammersEnabled &&
                                    'is-shadow',
                                )}
                              >
                                {deleteSpammersRuntimeStatus}
                              </span>
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'deleteSpammers' && 'is-open',
                                )}
                                aria-label="Пояснение для удаления спамеров"
                                aria-controls="delete-spammers-hint"
                                aria-expanded={openHintKey === 'deleteSpammers'}
                                onClick={() => toggleHint('deleteSpammers')}
                              >
                                <span aria-hidden>i</span>
                              </button>
                            </div>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить удаление спамеров"
                          >
                            <input
                              type="checkbox"
                              checked={draft.deleteSpammersEnabled}
                              onChange={(event) =>
                                setFieldValue('deleteSpammersEnabled', event.target.checked)
                              }
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'deleteSpammers' ? (
                          <p id="delete-spammers-hint" className="settings-native-toggle__hint">
                            Удаляются только подтвержденные.
                          </p>
                        ) : null}
                      </div>

                      <div
                        className={cn(
                          'settings-native-toggle',
                          (fieldErrors.messageCountLimitMessages ||
                            fieldErrors.messageCountLimitWindowHours) &&
                            'field--error',
                        )}
                      >
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Лимит сообщений</span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'messageCountLimit' && 'is-open',
                              )}
                              aria-label="Пояснение для лимита сообщений"
                              aria-controls="message-count-limit-hint"
                              aria-expanded={openHintKey === 'messageCountLimit'}
                              onClick={() => toggleHint('messageCountLimit')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить лимит сообщений"
                          >
                            <input
                              type="checkbox"
                              checked={draft.messageCountLimitEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('messageCountLimitEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {draft.messageCountLimitEnabled ? (
                          <>
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                                Сообщений
                              </span>
                              <output className="settings-length-limit__value" aria-live="polite">
                                {draft.messageCountLimitMessages}
                              </output>
                            </div>
                            <input
                              className="settings-length-limit__slider"
                              type="range"
                              min={MESSAGE_COUNT_LIMIT_MIN}
                              max={MESSAGE_COUNT_LIMIT_MAX}
                              step={1}
                              value={draft.messageCountLimitMessages}
                              onChange={(event) =>
                                setFieldValue(
                                  'messageCountLimitMessages',
                                  Number(
                                    event.target.value,
                                  ) as ChatSettings['messageCountLimitMessages'],
                                )
                              }
                              aria-label="Лимит сообщений за выбранный период"
                            />
                            <div className="settings-length-limit__labels" aria-hidden>
                              <span>{MESSAGE_COUNT_LIMIT_MIN}</span>
                              <span>{MESSAGE_COUNT_LIMIT_MAX}</span>
                            </div>

                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                                Период
                              </span>
                              <output className="settings-length-limit__value" aria-live="polite">
                                {draft.messageCountLimitWindowHours}ч
                              </output>
                            </div>
                            <input
                              className="settings-length-limit__slider"
                              type="range"
                              min={MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS}
                              max={MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS}
                              step={1}
                              value={draft.messageCountLimitWindowHours}
                              onChange={(event) =>
                                setFieldValue(
                                  'messageCountLimitWindowHours',
                                  Number(
                                    event.target.value,
                                  ) as ChatSettings['messageCountLimitWindowHours'],
                                )
                              }
                              aria-label="Период лимита сообщений в часах"
                            />
                            <div className="settings-length-limit__labels" aria-hidden>
                              <span>{MESSAGE_COUNT_LIMIT_WINDOW_MIN_HOURS}ч</span>
                              <span>{MESSAGE_COUNT_LIMIT_WINDOW_MAX_HOURS}ч</span>
                            </div>
                          </>
                        ) : null}

                        {fieldErrors.messageCountLimitMessages ? (
                          <small className="field__hint">
                            {fieldErrors.messageCountLimitMessages}
                          </small>
                        ) : fieldErrors.messageCountLimitWindowHours ? (
                          <small className="field__hint">
                            {fieldErrors.messageCountLimitWindowHours}
                          </small>
                        ) : openHintKey === 'messageCountLimit' ? (
                          <p id="message-count-limit-hint" className="settings-native-toggle__hint">
                            Ограничивает количество сообщений от одного пользователя в выбранное
                            окно времени. Срабатывает после превышения лимита.
                          </p>
                        ) : null}
                      </div>

                      <div
                        className={cn(
                          'settings-native-toggle',
                          fieldErrors.maxMessageLength && 'field--error',
                        )}
                      >
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Лимит длины сообщения
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'maxMessageLength' && 'is-open',
                              )}
                              aria-label="Пояснение для лимита длины сообщения"
                              aria-controls="max-message-length-hint"
                              aria-expanded={openHintKey === 'maxMessageLength'}
                              onClick={() => toggleHint('maxMessageLength')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить ограничение длины сообщения"
                          >
                            <input
                              type="checkbox"
                              checked={draft.maxMessageLengthEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('maxMessageLengthEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {draft.maxMessageLengthEnabled ? (
                          <MaxMessageLengthSlider
                            value={draft.maxMessageLength}
                            min={MESSAGE_LENGTH_MIN}
                            max={MESSAGE_LENGTH_MAX}
                            step={MESSAGE_LENGTH_STEP}
                            onCommit={(value) =>
                              setFieldValue(
                                'maxMessageLength',
                                value as ChatSettings['maxMessageLength'],
                              )
                            }
                          />
                        ) : null}

                        {openHintKey === 'maxMessageLength' ? (
                          <p id="max-message-length-hint" className="settings-native-toggle__hint">
                            Учитывается длина обычного текста и пересланных сообщений.
                          </p>
                        ) : null}

                        {fieldErrors.maxMessageLength ? (
                          <small className="field__hint">{fieldErrors.maxMessageLength}</small>
                        ) : null}
                      </div>

                      <div
                        className={cn(
                          'settings-native-toggle',
                          fieldErrors.photoMessageCooldownHours && 'field--error',
                        )}
                      >
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Фото: не чаще 1 раза
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'photoCooldown' && 'is-open',
                              )}
                              aria-label="Пояснение для ограничения частоты фото"
                              aria-controls="photo-cooldown-hint"
                              aria-expanded={openHintKey === 'photoCooldown'}
                              onClick={() => toggleHint('photoCooldown')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Ограничить отправку фото по времени"
                          >
                            <input
                              type="checkbox"
                              checked={draft.photoMessageCooldownEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('photoMessageCooldownEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {draft.photoMessageCooldownEnabled ? (
                          <>
                            <div className="settings-native-toggle__row">
                              <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                                Интервал
                              </span>
                              <output className="settings-length-limit__value" aria-live="polite">
                                {draft.photoMessageCooldownHours}ч
                              </output>
                            </div>
                            <input
                              className="settings-length-limit__slider"
                              type="range"
                              min={PHOTO_COOLDOWN_MIN_HOURS}
                              max={PHOTO_COOLDOWN_MAX_HOURS}
                              step={1}
                              value={draft.photoMessageCooldownHours}
                              onChange={(event) =>
                                setFieldValue(
                                  'photoMessageCooldownHours',
                                  Number(
                                    event.target.value,
                                  ) as ChatSettings['photoMessageCooldownHours'],
                                )
                              }
                              aria-label="Интервал отправки фото в часах"
                            />
                            <div className="settings-length-limit__labels" aria-hidden>
                              <span>{PHOTO_COOLDOWN_MIN_HOURS}ч</span>
                              <span>{PHOTO_COOLDOWN_MAX_HOURS}ч</span>
                            </div>
                          </>
                        ) : null}

                        {fieldErrors.photoMessageCooldownHours ? (
                          <small className="field__hint">
                            {fieldErrors.photoMessageCooldownHours}
                          </small>
                        ) : openHintKey === 'photoCooldown' ? (
                          <p id="photo-cooldown-hint" className="settings-native-toggle__hint">
                            При включении пользователь может отправить только одно сообщение с
                            фотографиями за выбранный интервал.
                          </p>
                        ) : null}
                      </div>

                      <div
                        className={cn(
                          'settings-native-toggle',
                          fieldErrors.stickerMessageCooldownMinutes && 'field--error',
                        )}
                      >
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">
                              Стикеры: не чаще 1 раза
                            </span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'stickerCooldown' && 'is-open',
                              )}
                              aria-label="Пояснение для ограничения частоты стикеров"
                              aria-controls="sticker-cooldown-hint"
                              aria-expanded={openHintKey === 'stickerCooldown'}
                              onClick={() => toggleHint('stickerCooldown')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Ограничить отправку стикеров по времени"
                          >
                            <input
                              type="checkbox"
                              checked={draft.stickerMessageCooldownEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('stickerMessageCooldownEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {draft.stickerMessageCooldownEnabled ? (
                          <div className="settings-native-toggle__row">
                            <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                              Интервал
                            </span>
                            <div
                              className="ban-duration-stepper"
                              role="group"
                              aria-label="Интервал отправки стикеров в минутах"
                            >
                              <button
                                type="button"
                                className="ban-duration-stepper__button"
                                onClick={() => adjustStickerMessageCooldown(-1)}
                                disabled={
                                  draft.stickerMessageCooldownMinutes <=
                                  STICKER_COOLDOWN_MIN_MINUTES
                                }
                                aria-label="Уменьшить интервал отправки стикеров"
                              >
                                -
                              </button>
                              <output className="ban-duration-stepper__value" aria-live="polite">
                                {draft.stickerMessageCooldownMinutes} мин
                              </output>
                              <button
                                type="button"
                                className="ban-duration-stepper__button"
                                onClick={() => adjustStickerMessageCooldown(1)}
                                disabled={
                                  draft.stickerMessageCooldownMinutes >=
                                  STICKER_COOLDOWN_MAX_MINUTES
                                }
                                aria-label="Увеличить интервал отправки стикеров"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {fieldErrors.stickerMessageCooldownMinutes ? (
                          <small className="field__hint">
                            {fieldErrors.stickerMessageCooldownMinutes}
                          </small>
                        ) : openHintKey === 'stickerCooldown' ? (
                          <p id="sticker-cooldown-hint" className="settings-native-toggle__hint">
                            Стикеры считаются отдельно и не попадают в лимит фото.
                          </p>
                        ) : null}
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">Разрешить фото</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Разрешить отправку фото"
                          >
                            <input
                              type="checkbox"
                              checked={draft.photoMessagesEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('photoMessagesEnabled', enabled);
                                if (!enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">Разрешить видео</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Разрешить отправку видео"
                          >
                            <input
                              type="checkbox"
                              checked={draft.videoMessagesEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('videoMessagesEnabled', enabled);
                                if (!enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">Разрешить файлы</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Разрешить отправку файлов"
                          >
                            <input
                              type="checkbox"
                              checked={draft.fileMessagesEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('fileMessagesEnabled', enabled);
                                if (!enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">Разрешить голосовые</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Разрешить отправку голосовых"
                          >
                            <input
                              type="checkbox"
                              checked={draft.voiceMessagesEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('voiceMessagesEnabled', enabled);
                                if (!enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">Разрешить телефоны</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Разрешить номера телефонов"
                          >
                            <input
                              type="checkbox"
                              checked={draft.phoneNumbersEnabled}
                              onChange={(event) =>
                                setFieldValue('phoneNumbersEnabled', event.target.checked)
                              }
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      <div
                        className="settings-subsection-divider"
                        role="separator"
                        aria-label="Блок действий бота"
                      >
                        <span>Действия бота</span>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Сообщение от бота</span>
                            <div className="settings-native-toggle__title-actions">
                              <EditToggleButton
                                label="Редактировать текст сообщения об ограничениях"
                                onClick={() => toggleBotMessageEditor('messageLimits')}
                                disabled={!draft.messageLimitsBotMessageEnabled}
                                isOpen={openBotEditorKey === 'messageLimits'}
                              />
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'messageLimitsBotMessage' && 'is-open',
                                )}
                                aria-label="Пояснение для тумблера сообщений в блоке ограничений"
                                aria-controls="message-limits-bot-message-hint"
                                aria-expanded={openHintKey === 'messageLimitsBotMessage'}
                                onClick={() => toggleHint('messageLimitsBotMessage')}
                              >
                                <span aria-hidden>i</span>
                              </button>
                            </div>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить сообщение от бота для ограничений сообщений"
                          >
                            <input
                              type="checkbox"
                              checked={draft.messageLimitsBotMessageEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('messageLimitsBotMessageEnabled', enabled);
                                if (!enabled) {
                                  setFieldValue('messageLimitsBotButtonEnabled', false);
                                  clearButtonGroupErrors(MESSAGE_LIMITS_BOT_BUTTON_GROUP);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'messageLimitsBotMessage' ? (
                          <p
                            id="message-limits-bot-message-hint"
                            className="settings-native-toggle__hint"
                          >
                            Бот отправляет пояснение при удалении сообщения по правилам этого блока.
                            Текст можно настроить вручную или вернуть к выбранному стилю.
                          </p>
                        ) : null}

                        {draft.messageLimitsBotMessageEnabled &&
                        openBotEditorKey === 'messageLimits' ? (
                          <LazyBotMessageEditor
                            editorKey="messageLimits"
                            {...botSpeechEditorProps!}
                            botSpeechPreviewContext={botSpeechPreviewContext}
                            value={draft.messageLimitsBotMessageText}
                            onChange={(nextValue) =>
                              setFieldValue(
                                'messageLimitsBotMessageText',
                                nextValue as ChatSettings['messageLimitsBotMessageText'],
                              )
                            }
                            onReset={() => setFieldValue('messageLimitsBotMessageText', '')}
                            onClose={() => setOpenBotEditorKey(null)}
                          />
                        ) : null}
                      </div>

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">2. Предупреждение</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить предупреждение за второе нарушение ограничений сообщений за 12 часов"
                          >
                            <input
                              type="checkbox"
                              checked={draft.messageLimitsWarnEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('messageLimitsWarnEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      {renderMuteStageToggle({
                        enabledKey: 'messageLimitsMuteEnabled',
                        durationKey: 'messageLimitsMuteDurationHours',
                        title: '3. Мут',
                        onEnable: () => {
                          setFieldValue('messageLimitsWarnEnabled', true);
                          setFieldValue('messageLimitsBotMessageEnabled', true);
                        },
                      })}

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">4. Бан</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить бан за повторные нарушения ограничений сообщений"
                          >
                            <input
                              type="checkbox"
                              checked={draft.messageLimitsBanEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('messageLimitsBanEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('messageLimitsWarnEnabled', true);
                                  setFieldValue('messageLimitsBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>

                      {draft.messageLimitsBotMessageEnabled ? (
                        <div
                          className={cn(
                            'settings-native-toggle',
                            'settings-native-toggle--nested',
                            hasMessageLimitsBotButtonError && 'field--error',
                          )}
                        >
                          <div className="settings-native-toggle__row">
                            <div className="settings-native-toggle__title-wrap">
                              <span className="settings-native-toggle__title">Добавить кнопку</span>
                              <button
                                type="button"
                                className={cn(
                                  'settings-info-button',
                                  openHintKey === 'messageLimitsBotButton' && 'is-open',
                                )}
                                aria-label="Пояснение для кнопки в сообщении ограничений"
                                aria-controls="message-limits-bot-button-hint"
                                aria-expanded={openHintKey === 'messageLimitsBotButton'}
                                onClick={() => toggleHint('messageLimitsBotButton')}
                              >
                                <span aria-hidden>i</span>
                              </button>
                            </div>

                            <label
                              className="settings-native-switch"
                              aria-label="Добавить кнопку в сообщение бота для ограничений сообщений"
                            >
                              <input
                                type="checkbox"
                                checked={draft.messageLimitsBotButtonEnabled}
                                onChange={(event) => {
                                  const enabled = event.target.checked;
                                  updateDraftButtonGroup(MESSAGE_LIMITS_BOT_BUTTON_GROUP, {
                                    enabled,
                                    ...(enabled && draft.messageLimitsBotButtons.length === 0
                                      ? { buttons: [createEmptyBroadcastLinkButton()] }
                                      : {}),
                                  });
                                }}
                              />
                              <span className="toggle-switch" aria-hidden>
                                <span className="toggle-switch__thumb" />
                              </span>
                            </label>
                          </div>

                          {renderInlineHint(
                            'messageLimitsBotButton',
                            'message-limits-bot-button-hint',
                            'Добавляет кнопку в сообщение бота с переходом на чат, канал или профиль.',
                            hasMessageLimitsBotButtonError,
                          )}

                          {draft.messageLimitsBotButtonEnabled ? (
                            <BroadcastLinkButtonsEditor
                              api={api}
                              buttons={draft.messageLimitsBotButtons}
                              errors={messageLimitsBotButtonErrors}
                              onChange={(nextButtons) =>
                                updateDraftButtonGroup(MESSAGE_LIMITS_BOT_BUTTON_GROUP, {
                                  buttons: nextButtons,
                                  enabled: nextButtons.length > 0,
                                })
                              }
                              urlPlaceholder="https://max.ru/channel/..."
                              textPlaceholder="Открыть"
                              title="Кнопки сообщения"
                              subtitle="Название и ссылка"
                            />
                          ) : null}
                        </div>
                      ) : null}

                      {draft.messageLimitsBotMessageEnabled
                        ? renderAdminContactToggle(
                            MESSAGE_LIMITS_ADMIN_CONTACT_BUTTON_GROUP,
                            'Добавить связь с админом в сообщения об ограничениях',
                          )
                        : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '214ms', order: 13 }}
              aria-label="Стоп-слова"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Стоп-слова"
                  summary={stopWordsHeaderSummary}
                  status={stopWordsCardStatus}
                  icon="keywords"
                  tone="rose"
                  open={expandedSections.stopWords}
                  controls="settings-stop-words-content"
                  onClick={() => toggleSection('stopWords')}
                  hideChevron
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-stop-words-content"
                open={expandedSections.stopWords}
                title="Стоп-слова"
                summary={stopWordsHeaderSummary}
                tone="rose"
                className="settings-drilldown__panel--board settings-drilldown__panel--stop-words"
                onClose={() => toggleSection('stopWords')}
                confirmCloseWhen={isSectionDirty('stopWords')}
                onDiscardChanges={() => discardSectionChanges('stopWords')}
                footer={renderSectionSaveFooter('stopWords')}
              >
                <div
                  id="settings-stop-words-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.stopWords && 'is-open',
                  )}
                >
                  {expandedSections.stopWords ? (
                    <div className="settings-section__collapse-inner">
                      <div
                        className={cn(
                          'settings-word-banlist',
                          stopWordsError && 'settings-word-banlist--error',
                        )}
                      >
                        <div className="settings-word-banlist__head">
                          <span className="settings-native-toggle__title">Стоп-слова</span>
                          {stopWordsTotalCount > 0 ? (
                            <span className="chip chip--danger">{stopWordsTotalCount}</span>
                          ) : null}
                        </div>

                        <SegmentedControl
                          value={stopWordsMode}
                          options={stopWordsSegmentOptions}
                          onChange={setStopWordsMode}
                          className="settings-word-banlist__segments"
                          ariaLabel="Список стоп-фильтра"
                        />

                        {stopWordsMode === 'words' ? (
                          <div
                            className="settings-word-banlist__mode-panel"
                            role="tabpanel"
                            aria-label="Стоп-слова"
                          >
                            <Suspense fallback={null}>
                              <LazyMessageLimitsBlockedWordPresets
                                selectedWords={draft.messageLimitsBlockedWords}
                                remainingSlots={messageLimitsBlockedWordsRemaining}
                                onApplyWords={applyMessageLimitsBlockedWords}
                              />
                            </Suspense>

                            <div className="settings-word-banlist__add-row">
                              <input
                                type="text"
                                value={messageLimitsBlockedWordsInput}
                                onChange={(event) => {
                                  setMessageLimitsBlockedWordsInput(event.target.value);
                                  clearFieldError('messageLimitsBlockedWords');
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ',') {
                                    event.preventDefault();
                                    addMessageLimitsBlockedWords();
                                  }
                                }}
                                placeholder="Слово, +слово или -слово"
                                maxLength={240}
                                aria-label="Изменить стоп-слова"
                              />
                              <button
                                type="button"
                                className="button button--accent settings-word-banlist__add-button"
                                onClick={addMessageLimitsBlockedWords}
                                disabled={isMessageLimitsBlockedWordsApplyDisabled}
                              >
                                Применить
                              </button>
                            </div>

                            {messageLimitsBlockedWords.length > 0 ? (
                              <>
                                <div className="settings-word-banlist__chips-head">
                                  <small className="settings-word-banlist__chips-caption">
                                    {messageLimitsBlockedWordsCaption}
                                  </small>
                                  {hasMessageLimitsBlockedWordsOverflow ? (
                                    <button
                                      type="button"
                                      className="settings-word-banlist__toggle"
                                      onClick={() =>
                                        setMessageLimitsBlockedWordsExpanded((current) => !current)
                                      }
                                      aria-expanded={messageLimitsBlockedWordsExpanded}
                                      aria-controls="settings-stop-words-list"
                                    >
                                      {messageLimitsBlockedWordsExpanded
                                        ? 'Свернуть'
                                        : `Показать все ${messageLimitsBlockedWords.length}`}
                                    </button>
                                  ) : null}
                                </div>

                                <div
                                  className="settings-word-banlist__chips"
                                  id="settings-stop-words-list"
                                  aria-label="Стоп-слова"
                                >
                                  {visibleMessageLimitsBlockedWords.map((word) => (
                                    <button
                                      key={word}
                                      type="button"
                                      className="settings-word-banlist__chip"
                                      onClick={() => removeMessageLimitsBlockedWord(word)}
                                      aria-label={`Удалить слово ${word}`}
                                    >
                                      <span>{word}</span>
                                      <span aria-hidden>×</span>
                                    </button>
                                  ))}
                                </div>
                              </>
                            ) : null}

                            <small className="field__hint">
                              {messageLimitsBlockedWordsError ?? 'Слово, +слово или -слово.'}
                            </small>
                          </div>
                        ) : (
                          <div
                            className="settings-word-banlist__mode-panel"
                            role="tabpanel"
                            aria-label="Запрещенные домены"
                          >
                            <div className="settings-word-banlist__mode-head">
                              <span className="settings-word-banlist__mode-title">
                                Ручное добавление
                              </span>
                              <SettingsHintAnchor
                                hintKey="stopWordsDomains"
                                openHintKey={openHintKey}
                                onToggleHint={toggleHint}
                                label="Как добавлять домены"
                              >
                                Можно ввести site.com или вставить ссылку. Сохраним только домен,
                                без пути и параметров. Поддомены тоже блокируются.
                              </SettingsHintAnchor>
                            </div>
                            <div className="settings-word-banlist__add-row">
                              <input
                                type="text"
                                value={messageLimitsBlockedDomainsInput}
                                onChange={(event) => {
                                  setMessageLimitsBlockedDomainsInput(event.target.value);
                                  clearFieldError('messageLimitsBlockedDomains');
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ',') {
                                    event.preventDefault();
                                    addMessageLimitsBlockedDomains();
                                  }
                                }}
                                placeholder="site.com или ссылка целиком"
                                maxLength={320}
                                aria-label="Изменить запрещенные домены"
                              />
                              <button
                                type="button"
                                className="button button--accent settings-word-banlist__add-button"
                                onClick={addMessageLimitsBlockedDomains}
                                disabled={isMessageLimitsBlockedDomainsApplyDisabled}
                              >
                                {hasMessageLimitsBlockedDomainsRemoveInputActions
                                  ? 'Применить'
                                  : 'Добавить'}
                              </button>
                            </div>

                            {messageLimitsBlockedDomains.length > 0 ? (
                              <>
                                <div className="settings-word-banlist__chips-head">
                                  <small className="settings-word-banlist__chips-caption">
                                    {messageLimitsBlockedDomainsCaption}
                                  </small>
                                  {hasMessageLimitsBlockedDomainsOverflow ? (
                                    <button
                                      type="button"
                                      className="settings-word-banlist__toggle"
                                      onClick={() =>
                                        setMessageLimitsBlockedDomainsExpanded(
                                          (current) => !current,
                                        )
                                      }
                                      aria-expanded={messageLimitsBlockedDomainsExpanded}
                                      aria-controls="settings-stop-domains-list"
                                    >
                                      {messageLimitsBlockedDomainsExpanded
                                        ? 'Свернуть'
                                        : `Показать все ${messageLimitsBlockedDomains.length}`}
                                    </button>
                                  ) : null}
                                </div>

                                <div
                                  className="settings-word-banlist__chips"
                                  id="settings-stop-domains-list"
                                  aria-label="Запрещенные домены"
                                >
                                  {visibleMessageLimitsBlockedDomains.map((domain) => (
                                    <button
                                      key={domain}
                                      type="button"
                                      className="settings-word-banlist__chip settings-word-banlist__chip--domain"
                                      onClick={() => removeMessageLimitsBlockedDomain(domain)}
                                      aria-label={`Удалить домен ${domain}`}
                                    >
                                      <span>{domain}</span>
                                      <span aria-hidden>×</span>
                                    </button>
                                  ))}
                                </div>
                              </>
                            ) : null}

                            <small className="field__hint">
                              {messageLimitsBlockedDomainsError ??
                                'Вводите домен руками или вставляйте ссылку.'}
                            </small>
                          </div>
                        )}
                      </div>

                      <div
                        className="settings-subsection-divider"
                        role="separator"
                        aria-label="Сообщения бота для стоп-слов"
                      >
                        <span>Сообщения бота</span>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">1. Объяснение</span>
                            <div className="settings-native-toggle__title-actions">
                              <EditToggleButton
                                label="Редактировать текст объяснения о стоп-словах"
                                onClick={() => toggleBotMessageEditor('stopWords')}
                                isOpen={openBotEditorKey === 'stopWords'}
                              />
                            </div>
                          </div>
                        </div>

                        {openBotEditorKey === 'stopWords' ? (
                          <LazyBotMessageEditor
                            editorKey="stopWords"
                            {...botSpeechEditorProps!}
                            botSpeechPreviewContext={botSpeechPreviewContext}
                            value={draft.messageLimitsBotMessageText}
                            onChange={(nextValue) =>
                              setFieldValue(
                                'messageLimitsBotMessageText',
                                nextValue as ChatSettings['messageLimitsBotMessageText'],
                              )
                            }
                            onReset={() => setFieldValue('messageLimitsBotMessageText', '')}
                            onClose={() => setOpenBotEditorKey(null)}
                          />
                        ) : null}
                      </div>

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">2. Предупреждение</span>
                            <div className="settings-native-toggle__title-actions">
                              <EditToggleButton
                                label="Редактировать текст предупреждения о стоп-словах"
                                onClick={() => toggleWarnMessageEditor('stopWordsWarn')}
                                isOpen={openWarnEditorKey === 'stopWordsWarn'}
                              />
                            </div>
                          </div>
                        </div>

                        {openWarnEditorKey === 'stopWordsWarn' ? (
                          <LazyWarnMessageEditor
                            editorKey="stopWordsWarn"
                            {...botSpeechEditorProps!}
                            botSpeechPreviewContext={botSpeechPreviewContext}
                            value={draft.messageLimitsWarnMessageText}
                            onChange={(nextValue) =>
                              setFieldValue(
                                'messageLimitsWarnMessageText',
                                nextValue as ChatSettings['messageLimitsWarnMessageText'],
                              )
                            }
                            onReset={() => setFieldValue('messageLimitsWarnMessageText', '')}
                            onClose={() => setOpenWarnEditorKey(null)}
                          />
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--list stagger-in"
              style={{ animationDelay: '250ms', order: 16 }}
              aria-label="Ночной режим"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Ночной режим"
                  summary={nightHeaderSummary}
                  status={nightCardStatus}
                  icon="moon"
                  tone="ink"
                  open={expandedSections.night}
                  controls="settings-night-content"
                  onClick={() => toggleSection('night')}
                  hideChevron
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-night-content"
                open={expandedSections.night}
                title="Ночной режим"
                summary={nightHeaderSummary}
                tone="ink"
                className="settings-drilldown__panel--time settings-drilldown__panel--night"
                onClose={() => toggleSection('night')}
                confirmCloseWhen={isSectionDirty('night')}
                onDiscardChanges={() => discardSectionChanges('night')}
                footer={renderSectionSaveFooter('night')}
              >
                <div
                  id="settings-night-content"
                  className={cn('settings-section__collapse', expandedSections.night && 'is-open')}
                >
                  {expandedSections.night ? (
                    <div className="settings-section__collapse-inner">
                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">Включить режим</span>
                            <button
                              type="button"
                              className={cn(
                                'settings-info-button',
                                openHintKey === 'nightModeEnabled' && 'is-open',
                              )}
                              aria-label="Пояснение для ночного режима"
                              aria-controls="night-mode-enabled-hint"
                              aria-expanded={openHintKey === 'nightModeEnabled'}
                              onClick={() => toggleHint('nightModeEnabled')}
                            >
                              <span aria-hidden>i</span>
                            </button>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить закрытие чата на ночь"
                          >
                            <input
                              type="checkbox"
                              checked={draft.nightModeEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setDraft((current) =>
                                  current ? applyNightModeEnabledChange(current, enabled) : current,
                                );
                                clearFieldError('nightModeEnabled');
                                if (!enabled) {
                                  clearFieldError('nightModeBotMessageEnabled');
                                  clearFieldError('nightModeCommentsEnabled');
                                  clearFieldError('nightModeBotButtonEnabled');
                                  clearFieldError('nightModeRulesButtonEnabled');
                                  clearButtonGroupErrors(NIGHT_MODE_BOT_BUTTON_GROUP);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openHintKey === 'nightModeEnabled' ? (
                          <p id="night-mode-enabled-hint" className="settings-native-toggle__hint">
                            Во время закрытия сообщения не-админов удаляются автоматически.
                          </p>
                        ) : null}
                      </div>

                      {draft.nightModeEnabled ? (
                        <div
                          className={cn(
                            'settings-native-toggle',
                            nightTimezoneError && 'field--error',
                          )}
                        >
                          <div className="night-window-grid">
                            <Suspense fallback={null}>
                              <LazySettingsTimeFields
                                kind="night"
                                startMinutes={draft.nightModeStartTimeMinutes}
                                endMinutes={draft.nightModeEndTimeMinutes}
                                onChange={(key, nextValue) =>
                                  setFieldValue(key, nextValue as ChatSettings[typeof key])
                                }
                              />
                            </Suspense>
                          </div>

                          <label className={cn('field', nightTimezoneError && 'field--error')}>
                            <span className="field__label">Часовой пояс России</span>
                            <select
                              value={draft.nightModeTimezone}
                              onChange={(event) =>
                                setFieldValue('nightModeTimezone', event.target.value)
                              }
                            >
                              {RUSSIAN_TIMEZONE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            {nightTimezoneError ? (
                              <small className="field__hint">{nightTimezoneError}</small>
                            ) : (
                              <small className="field__hint">
                                По умолчанию используется Москва (UTC+3).
                              </small>
                            )}
                          </label>
                        </div>
                      ) : null}

                      {draft.nightModeEnabled ? (
                        <>
                          <div
                            className="settings-subsection-divider"
                            role="separator"
                            aria-label="Блок действий бота для ночного режима"
                          >
                            <span>Действия бота</span>
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Сообщение от бота
                                </span>
                                <div className="settings-native-toggle__title-actions">
                                  <EditToggleButton
                                    label="Редактировать текст сообщения ночного режима"
                                    onClick={() => toggleBotMessageEditor('night')}
                                    disabled={!draft.nightModeBotMessageEnabled}
                                    isOpen={openBotEditorKey === 'night'}
                                  />
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'nightBotMessage' && 'is-open',
                                    )}
                                    aria-label="Пояснение для тумблера сообщений ночного режима"
                                    aria-controls="night-bot-message-hint"
                                    aria-expanded={openHintKey === 'nightBotMessage'}
                                    onClick={() => toggleHint('nightBotMessage')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить сообщение от бота для ночного режима"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.nightModeBotMessageEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setDraft((current) =>
                                      current
                                        ? applyNightModeBotMessageEnabledChange(current, enabled)
                                        : current,
                                    );
                                    clearFieldError('nightModeBotMessageEnabled');
                                    if (!enabled) {
                                      clearFieldError('nightModeCommentsEnabled');
                                      clearFieldError('nightModeBotButtonEnabled');
                                      clearFieldError('nightModeRulesButtonEnabled');
                                      clearButtonGroupErrors(NIGHT_MODE_BOT_BUTTON_GROUP);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'nightBotMessage' ? (
                              <p
                                id="night-bot-message-hint"
                                className="settings-native-toggle__hint"
                              >
                                Бот пишет, что чат закрыт на ночь, и поясняет удаление сообщения.
                              </p>
                            ) : null}

                            {draft.nightModeBotMessageEnabled && openBotEditorKey === 'night' ? (
                              <LazyBotMessageEditor
                                editorKey="night"
                                {...botSpeechEditorProps!}
                                botSpeechPreviewContext={botSpeechPreviewContext}
                                value={draft.nightModeBotMessageText}
                                onChange={(nextValue) =>
                                  setFieldValue(
                                    'nightModeBotMessageText',
                                    nextValue as ChatSettings['nightModeBotMessageText'],
                                  )
                                }
                                onReset={() => setFieldValue('nightModeBotMessageText', '')}
                                onClose={() => setOpenBotEditorKey(null)}
                              />
                            ) : null}
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Сообщение об открытии
                                </span>
                                <div className="settings-native-toggle__title-actions">
                                  <EditToggleButton
                                    label="Редактировать текст сообщения об открытии группы"
                                    onClick={() => toggleBotMessageEditor('nightOpen')}
                                    disabled={!draft.nightModeOpenMessageEnabled}
                                    isOpen={openBotEditorKey === 'nightOpen'}
                                  />
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'nightOpenMessage' && 'is-open',
                                    )}
                                    aria-label="Пояснение для сообщения об открытии группы"
                                    aria-controls="night-open-message-hint"
                                    aria-expanded={openHintKey === 'nightOpenMessage'}
                                    onClick={() => toggleHint('nightOpenMessage')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить сообщение об открытии группы после ночного режима"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.nightModeOpenMessageEnabled}
                                  onChange={(event) =>
                                    setFieldValue(
                                      'nightModeOpenMessageEnabled',
                                      event.target.checked,
                                    )
                                  }
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'nightOpenMessage' ? (
                              <p
                                id="night-open-message-hint"
                                className="settings-native-toggle__hint"
                              >
                                После окончания ночного режима бот пишет, что группа снова открыта,
                                и удаляет предыдущее ночное сообщение.
                              </p>
                            ) : null}

                            {draft.nightModeOpenMessageEnabled &&
                            openBotEditorKey === 'nightOpen' ? (
                              <LazyBotMessageEditor
                                editorKey="nightOpen"
                                {...botSpeechEditorProps!}
                                botSpeechPreviewContext={botSpeechPreviewContext}
                                value={draft.nightModeOpenMessageText}
                                onChange={(nextValue) =>
                                  setFieldValue(
                                    'nightModeOpenMessageText',
                                    nextValue as ChatSettings['nightModeOpenMessageText'],
                                  )
                                }
                                onReset={() => setFieldValue('nightModeOpenMessageText', '')}
                                onClose={() => setOpenBotEditorKey(null)}
                              />
                            ) : null}
                          </div>

                          {draft.nightModeBotMessageEnabled ? (
                            <div
                              className={cn(
                                'settings-native-toggle',
                                'settings-native-toggle--nested',
                              )}
                            >
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">Комментарии</span>
                                  <div className="settings-native-toggle__title-actions">
                                    <SettingsHintAnchor
                                      hintKey="nightComments"
                                      openHintKey={openHintKey}
                                      onToggleHint={toggleHint}
                                      label="Как работают комментарии под ночным сообщением"
                                    >
                                      Добавляет кнопку комментариев под сообщением о закрытии
                                      группы. Работает, если в чате включён блок «Комментарии».
                                    </SettingsHintAnchor>
                                  </div>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Добавить комментарии под сообщением ночного режима"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.nightModeCommentsEnabled}
                                    onChange={(event) =>
                                      setFieldValue(
                                        'nightModeCommentsEnabled',
                                        event.target.checked,
                                      )
                                    }
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>
                            </div>
                          ) : null}

                          {draft.nightModeBotMessageEnabled ? (
                            <div
                              className={cn(
                                'settings-native-toggle',
                                'settings-native-toggle--nested',
                                hasNightBotButtonError && 'field--error',
                              )}
                            >
                              <div className="settings-native-toggle__row">
                                <div className="settings-native-toggle__title-wrap">
                                  <span className="settings-native-toggle__title">
                                    Добавить кнопку
                                  </span>
                                  <button
                                    type="button"
                                    className={cn(
                                      'settings-info-button',
                                      openHintKey === 'nightBotButton' && 'is-open',
                                    )}
                                    aria-label="Пояснение для кнопки в сообщении ночного режима"
                                    aria-controls="night-bot-button-hint"
                                    aria-expanded={openHintKey === 'nightBotButton'}
                                    onClick={() => toggleHint('nightBotButton')}
                                  >
                                    <span aria-hidden>i</span>
                                  </button>
                                </div>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Добавить кнопку в сообщение бота для ночного режима"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.nightModeBotButtonEnabled}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      updateDraftButtonGroup(NIGHT_MODE_BOT_BUTTON_GROUP, {
                                        enabled,
                                        ...(enabled && draft.nightModeBotButtons.length === 0
                                          ? { buttons: [createEmptyBroadcastLinkButton()] }
                                          : {}),
                                      });
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>

                              {renderInlineHint(
                                'nightBotButton',
                                'night-bot-button-hint',
                                'Добавляет кнопку в сообщение о закрытии чата на ночь.',
                                hasNightBotButtonError,
                              )}

                              {draft.nightModeBotButtonEnabled ? (
                                <BroadcastLinkButtonsEditor
                                  api={api}
                                  buttons={draft.nightModeBotButtons}
                                  errors={nightBotButtonErrors}
                                  onChange={(nextButtons) =>
                                    updateDraftButtonGroup(NIGHT_MODE_BOT_BUTTON_GROUP, {
                                      buttons: nextButtons,
                                      enabled: nextButtons.length > 0,
                                    })
                                  }
                                  urlPlaceholder="https://max.ru/channel/..."
                                  textPlaceholder="Правила чата"
                                  title="Кнопки сообщения"
                                  subtitle="Название и ссылка"
                                />
                              ) : null}
                            </div>
                          ) : null}

                          {draft.nightModeBotMessageEnabled ? (
                            <PublishedRulesButtonToggleSlot
                              ariaLabel="Кнопка Правила в ночном режиме"
                              enabled={draft.nightModeRulesButtonEnabled}
                              hasRules={hasPublishedRules}
                              onChange={(enabled) =>
                                setFieldValue('nightModeRulesButtonEnabled', enabled)
                              }
                            />
                          ) : null}

                          <div
                            className="settings-subsection-divider"
                            role="separator"
                            aria-label="Блок ручного закрытия группы"
                          >
                            <span>Ручное закрытие</span>
                          </div>

                          <div className="settings-native-toggle">
                            <div className="settings-native-toggle__row">
                              <div className="settings-native-toggle__title-wrap">
                                <span className="settings-native-toggle__title">
                                  Закрыть группу
                                </span>
                                <button
                                  type="button"
                                  className={cn(
                                    'settings-info-button',
                                    openHintKey === 'nightForceClose' && 'is-open',
                                  )}
                                  aria-label="Пояснение для ручного закрытия группы"
                                  aria-controls="night-force-close-hint"
                                  aria-expanded={openHintKey === 'nightForceClose'}
                                  onClick={() => toggleHint('nightForceClose')}
                                >
                                  <span aria-hidden>i</span>
                                </button>
                              </div>

                              <label
                                className="settings-native-switch"
                                aria-label="Включить ручное закрытие группы"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.nightModeForceCloseEnabled}
                                  onChange={(event) => {
                                    const enabled = event.target.checked;
                                    setFieldValue('nightModeForceCloseEnabled', enabled);
                                    setFieldValue('nightModeForceCloseUntil', '');
                                    clearFieldError('nightModeForceCloseHours');
                                    clearFieldError('nightModeForceCloseDays');
                                    if (
                                      enabled &&
                                      !draft.nightModeForceCloseForever &&
                                      draft.nightModeForceCloseDays === 0 &&
                                      draft.nightModeForceCloseHours === 0
                                    ) {
                                      setFieldValue('nightModeForceCloseHours', 8);
                                    }
                                  }}
                                />
                                <span className="toggle-switch" aria-hidden>
                                  <span className="toggle-switch__thumb" />
                                </span>
                              </label>
                            </div>

                            {openHintKey === 'nightForceClose' ? (
                              <p
                                id="night-force-close-hint"
                                className="settings-native-toggle__hint"
                              >
                                Пока ручное закрытие активно, бот молча удаляет сообщения не-админов
                                без дополнительного текста.
                              </p>
                            ) : null}
                          </div>

                          {draft.nightModeForceCloseEnabled ? (
                            <div className="settings-native-toggle settings-native-toggle--nested">
                              <div className="settings-native-toggle__row">
                                <span className="settings-native-toggle__title">
                                  Включить бессрочно
                                </span>

                                <label
                                  className="settings-native-switch"
                                  aria-label="Включить бессрочное ручное закрытие группы"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.nightModeForceCloseForever}
                                    onChange={(event) => {
                                      const enabled = event.target.checked;
                                      setFieldValue('nightModeForceCloseForever', enabled);
                                      setFieldValue('nightModeForceCloseUntil', '');
                                      clearFieldError('nightModeForceCloseHours');
                                      clearFieldError('nightModeForceCloseDays');
                                      if (
                                        !enabled &&
                                        draft.nightModeForceCloseDays === 0 &&
                                        draft.nightModeForceCloseHours === 0
                                      ) {
                                        setFieldValue('nightModeForceCloseHours', 8);
                                      }
                                    }}
                                  />
                                  <span className="toggle-switch" aria-hidden>
                                    <span className="toggle-switch__thumb" />
                                  </span>
                                </label>
                              </div>
                            </div>
                          ) : null}

                          {draft.nightModeForceCloseEnabled && !draft.nightModeForceCloseForever ? (
                            <div
                              className={cn(
                                'settings-native-toggle',
                                'settings-native-toggle--nested',
                                hasNightForceCloseDurationError && 'field--error',
                              )}
                            >
                              <div className="settings-duration-stack">
                                <div className="settings-duration-stack__item">
                                  <div className="settings-native-toggle__row">
                                    <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                                      Часы
                                    </span>
                                    <output
                                      className="settings-length-limit__value"
                                      aria-live="polite"
                                    >
                                      {draft.nightModeForceCloseHours}ч
                                    </output>
                                  </div>
                                  <input
                                    className="settings-length-limit__slider"
                                    type="range"
                                    min={NIGHT_FORCE_CLOSE_MIN_HOURS}
                                    max={NIGHT_FORCE_CLOSE_MAX_HOURS}
                                    step={1}
                                    value={draft.nightModeForceCloseHours}
                                    onChange={(event) => {
                                      setFieldValue(
                                        'nightModeForceCloseHours',
                                        Number(
                                          event.target.value,
                                        ) as ChatSettings['nightModeForceCloseHours'],
                                      );
                                      setFieldValue('nightModeForceCloseUntil', '');
                                      clearFieldError('nightModeForceCloseDays');
                                    }}
                                    aria-label="Сколько часов держать группу закрытой"
                                  />
                                  <div className="settings-length-limit__labels" aria-hidden>
                                    <span>{NIGHT_FORCE_CLOSE_MIN_HOURS}ч</span>
                                    <span>{NIGHT_FORCE_CLOSE_MAX_HOURS}ч</span>
                                  </div>
                                </div>

                                <div className="settings-duration-stack__item">
                                  <div className="settings-native-toggle__row">
                                    <span className="settings-native-toggle__title settings-native-toggle__title--sub">
                                      Дни
                                    </span>
                                    <output
                                      className="settings-length-limit__value"
                                      aria-live="polite"
                                    >
                                      {draft.nightModeForceCloseDays}д
                                    </output>
                                  </div>
                                  <input
                                    className="settings-length-limit__slider"
                                    type="range"
                                    min={NIGHT_FORCE_CLOSE_MIN_DAYS}
                                    max={NIGHT_FORCE_CLOSE_MAX_DAYS}
                                    step={1}
                                    value={draft.nightModeForceCloseDays}
                                    onChange={(event) => {
                                      setFieldValue(
                                        'nightModeForceCloseDays',
                                        Number(
                                          event.target.value,
                                        ) as ChatSettings['nightModeForceCloseDays'],
                                      );
                                      setFieldValue('nightModeForceCloseUntil', '');
                                      clearFieldError('nightModeForceCloseHours');
                                    }}
                                    aria-label="Сколько дней держать группу закрытой"
                                  />
                                  <div className="settings-length-limit__labels" aria-hidden>
                                    <span>{NIGHT_FORCE_CLOSE_MIN_DAYS}д</span>
                                    <span>{NIGHT_FORCE_CLOSE_MAX_DAYS}д</span>
                                  </div>
                                </div>
                              </div>

                              {nightForceCloseHoursError || nightForceCloseDaysError ? (
                                <small className="field__hint">
                                  {nightForceCloseHoursError ?? nightForceCloseDaysError}
                                </small>
                              ) : (
                                <p className="settings-native-toggle__hint">
                                  Бот будет молча удалять новые сообщения весь выбранный срок.
                                </p>
                              )}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            {!legacyBroadcastWorkspaceRequested ? (
              <GlassCard
                className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
                style={{ animationDelay: '315ms', order: 5 }}
                aria-label="Посты"
                padding="sm"
              >
                <PublicationWorkspaceHandoff
                  entityType="chat"
                  entityId={chatId}
                  variant="settings-tile"
                />
              </GlassCard>
            ) : null}
            {legacyBroadcastWorkspaceRequested ? (
              <GlassCard
                className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
                style={{ animationDelay: '315ms', order: 5 }}
                aria-label="Ранее созданные посты"
              >
                <div
                  className={cn('settings-section__head', 'settings-section__head--interactive')}
                >
                  <SettingsSectionToggle
                    title="Автопостинг"
                    summary={mailingHeaderSummary}
                    status={mailingCardStatus}
                    icon="send"
                    tone="sky"
                    open={expandedSections.mailing}
                    controls="settings-mailing-content"
                    onClick={() => toggleSection('mailing')}
                    hideChevron
                  />
                </div>

                <SettingsDrilldownPanel
                  id="settings-mailing-content"
                  open={expandedSections.mailing}
                  title="Автопостинг"
                  summary={mailingHeaderSummary}
                  variant="screen"
                  tone="sky"
                  className="settings-drilldown__panel--campaign settings-drilldown__panel--mailing settings-drilldown__panel--broadcast-screen"
                  onClose={() => toggleSection('mailing')}
                  footer={activeMailingWorkspaceView === 'compose' ? mailingDrilldownFooter : null}
                >
                  <div
                    id="settings-mailing-content"
                    className={cn(
                      'settings-section__collapse',
                      expandedSections.mailing && 'is-open',
                    )}
                  >
                    {expandedSections.mailing ? (
                      <div className="settings-section__collapse-inner settings-mailing">
                        <div className="broadcast-studio-shell broadcast-studio-screen broadcast-studio-screen--chat">
                          <div className="broadcast-studio-screen__chrome">
                            <BroadcastWorkspaceChrome
                              showTabs={showMailingWorkspaceTabs && !handoffRequested}
                              value={activeMailingWorkspaceView}
                              autopostCount={orderedManagedAutopostRules.length}
                              historyCount={orderedManagedBroadcasts.length}
                              compatibilityOnly
                              disabled={isMailingBusy}
                              showReset={showMailingResetAction}
                              resetLabel={mailingResetActionLabel}
                              resetPending={clearBroadcastHandoffMutation.isPending}
                              onChange={setMailingWorkspaceView}
                              onReset={handleClearMailingComposer}
                            />
                          </div>

                          {activeMailingWorkspaceView === 'compose' ? (
                            <div className="broadcast-compose-flow broadcast-compose-flow--screen">
                              <div className="broadcast-stage-card broadcast-stage-card--message broadcast-stage-card--primary">
                                <div className="broadcast-stage-card__head">
                                  <div className="broadcast-stage-card__title-wrap">
                                    <strong>Сообщение</strong>
                                  </div>
                                  <span
                                    className={cn(
                                      'broadcast-stage-card__status',
                                      mailingContentReady ? 'is-ready' : 'is-pending',
                                    )}
                                  >
                                    {mailingContentReady
                                      ? 'Готов'
                                      : mailingImagesPreparing
                                        ? 'Фото...'
                                        : mailingHasDirectContent
                                          ? 'Проверка'
                                          : 'Пусто'}
                                  </span>
                                </div>

                                <div className="broadcast-stage-card__body">
                                  <Suspense fallback={null}>
                                    <LazyBroadcastContentComposer
                                      text={mailingText}
                                      maxLength={MAX_BROADCAST_TEXT_LENGTH}
                                      images={mailingImages}
                                      videoLabel={editingMailingHasVideo ? 'Видео' : null}
                                      disabled={isMailingBusy}
                                      textError={mailingTextError}
                                      imageError={mailingImageError}
                                      onTextChange={(nextText) => {
                                        setMailingText(nextText);
                                        if (mailingTextError) {
                                          setMailingTextError('');
                                        }
                                      }}
                                      onImagesChange={(nextImages) => {
                                        applyMailingImages(nextImages);
                                        if (nextImages.length > 0) {
                                          setMailingVideoCleared(true);
                                        }
                                        setMailingImageError('');
                                        if (mailingTextError) {
                                          setMailingTextError('');
                                        }
                                      }}
                                      onImagePreparationChange={setMailingImagesPreparing}
                                      onClearVideo={() => {
                                        setMailingVideoCleared(true);
                                      }}
                                      onError={(message) => {
                                        setMailingImageError(message);
                                        pushToast({
                                          tone: 'danger',
                                          title: 'Фото не добавлено',
                                          description: message,
                                        });
                                        maxNotify('error');
                                      }}
                                      buttons={normalizedMailingButtons}
                                      systemButtons={mailingSystemButtons}
                                      buttonsStatusLabel={mailingVisibleButtonStatus}
                                      buttonsActive={mailingHasVisibleButtons}
                                      buttonsError={!mailingButtonDraftValid}
                                      onOpenButtons={() => setMailingButtonsSheetOpen(true)}
                                    />
                                  </Suspense>
                                </div>
                              </div>

                              <div className="broadcast-stage-card broadcast-stage-card--scope">
                                <div className="broadcast-stage-card__head">
                                  <div className="broadcast-stage-card__title-wrap">
                                    <strong>Кому</strong>
                                  </div>
                                </div>

                                <div className="broadcast-stage-card__body">
                                  <Suspense fallback={null}>
                                    <LazyBroadcastAudienceControls
                                      targetMode={mailingTargetMode}
                                      currentChatId={chatId ?? ''}
                                      targetChatIds={mailingAudiencePayload.targetChatIds}
                                      favoriteUserId={meQuery.data?.userId ?? null}
                                      choices={mailingAudienceChoices}
                                      loading={mailingAudienceChoicesLoading}
                                      refreshing={chatsList.isRefreshing}
                                      remoteError={mailingAudienceChoicesError}
                                      validationError={mailingAudienceError || null}
                                      disabled={isMailingBusy}
                                      onToggleAllChats={handleMailingAllChatsToggle}
                                      onChangeScopedMode={handleMailingScopedTargetModeChange}
                                      onApplySelection={handleApplyMailingAudienceSelection}
                                      onClearValidationError={() => setMailingAudienceError('')}
                                      onRefreshChoices={handleRefreshMailingAudienceChoices}
                                    />
                                  </Suspense>
                                </div>
                              </div>

                              <div className="broadcast-stage-card broadcast-stage-card--planner">
                                <div className="broadcast-stage-card__head">
                                  <div className="broadcast-stage-card__title-wrap">
                                    <strong>Когда</strong>
                                  </div>
                                </div>

                                <div className="broadcast-stage-card__body">
                                  <Suspense fallback={null}>
                                    <LazyBroadcastSchedulePlanner
                                      resetKey={mailingPlannerResetKey}
                                      value={mailingScheduledSlots}
                                      occupiedSlots={mailingOccupiedSlots}
                                      error={mailingScheduleError || mailingCycleError}
                                      disabled={isMailingBusy}
                                      managedBroadcasts={managedBroadcasts}
                                      calendarSlots={mailingCalendarQuery.data?.slots ?? []}
                                      targetAwareAvailability
                                      sourceChatId={chatId}
                                      managedBroadcastsLoading={
                                        settingsScreenQuery.isLoading ||
                                        settingsScreenQuery.isFetching ||
                                        mailingCalendarQuery.isFetching
                                      }
                                      currentTargetLabel="Текущий чат"
                                      targetContextLabel={
                                        mailingHeaderTargetPresentation.compactLabel
                                      }
                                      calendarRefreshing={mailingCalendarQuery.isFetching}
                                      excludeBroadcastId={editingManagedBroadcast?.id ?? null}
                                      excludeAutopostRuleId={editingManagedAutopostRule?.id ?? null}
                                      onEditBroadcast={handleEditManagedBroadcastById}
                                      onDeleteBroadcast={handleDeleteManagedBroadcastById}
                                      pendingEditBroadcastId={
                                        openManagedBroadcastEditorMutation.isPending
                                          ? openManagedBroadcastEditorMutation.variables
                                          : null
                                      }
                                      pendingDeleteBroadcastId={
                                        cancelManagedBroadcastMutation.isPending
                                          ? cancelManagedBroadcastMutation.variables
                                          : null
                                      }
                                      timingMode={mailingTimingMode}
                                      cycle={mailingCycleDraft}
                                      onTimingModeChange={(nextMode) => {
                                        setMailingTimingMode(nextMode);
                                        setMailingScheduleError('');
                                        setMailingCycleError('');
                                      }}
                                      onCycleChange={(nextCycle) => {
                                        setMailingCycleDraft(nextCycle);
                                        setMailingCycleError('');
                                      }}
                                      onSelectionStateChange={handleMailingPlannerStateChange}
                                      onChange={(nextValue) => {
                                        setMailingScheduledSlots(nextValue);
                                        if (mailingScheduleError) {
                                          setMailingScheduleError('');
                                        }
                                      }}
                                    />
                                  </Suspense>
                                </div>
                              </div>
                            </div>
                          ) : activeMailingWorkspaceView === 'calendar' ? (
                            <div className="broadcast-stage-card broadcast-stage-card--planner broadcast-stage-card--calendar">
                              <div className="broadcast-stage-card__head">
                                <div className="broadcast-stage-card__title-wrap">
                                  <strong>Календарь</strong>
                                </div>
                              </div>

                              <div className="broadcast-stage-card__body">
                                <Suspense fallback={null}>
                                  <LazyBroadcastSchedulePlanner
                                    resetKey={`calendar-${mailingPlannerResetKey}`}
                                    value={[]}
                                    occupiedSlots={mailingOccupiedSlots}
                                    disabled={isMailingBusy}
                                    managedBroadcasts={managedBroadcasts}
                                    calendarSlots={mailingCalendarQuery.data?.slots ?? []}
                                    sourceChatId={chatId}
                                    managedBroadcastsLoading={
                                      settingsScreenQuery.isLoading ||
                                      settingsScreenQuery.isFetching ||
                                      mailingCalendarQuery.isFetching
                                    }
                                    currentTargetLabel="Текущий чат"
                                    targetContextLabel={
                                      mailingHeaderTargetPresentation.compactLabel
                                    }
                                    calendarRefreshing={mailingCalendarQuery.isFetching}
                                    excludeBroadcastId={editingManagedBroadcast?.id ?? null}
                                    excludeAutopostRuleId={editingManagedAutopostRule?.id ?? null}
                                    onEditBroadcast={handleEditManagedBroadcastById}
                                    onDeleteBroadcast={handleDeleteManagedBroadcastById}
                                    pendingEditBroadcastId={
                                      openManagedBroadcastEditorMutation.isPending
                                        ? openManagedBroadcastEditorMutation.variables
                                        : null
                                    }
                                    pendingDeleteBroadcastId={
                                      cancelManagedBroadcastMutation.isPending
                                        ? cancelManagedBroadcastMutation.variables
                                        : null
                                    }
                                    viewMode="calendar"
                                    onSelectionStateChange={handleMailingPlannerStateChange}
                                    onChange={(nextValue) => {
                                      setMailingTimingMode('scheduled');
                                      setMailingScheduledSlots(nextValue);
                                      setMailingScheduleError('');
                                      setMailingWorkspaceView('compose');
                                    }}
                                  />
                                </Suspense>
                              </div>
                            </div>
                          ) : activeMailingWorkspaceView === 'autoposts' ? (
                            <div className="broadcast-stage-card broadcast-stage-card--feed">
                              <div className="broadcast-stage-card__head">
                                <div className="broadcast-stage-card__title-wrap">
                                  <strong>Автопосты</strong>
                                  <small>
                                    {managedAutopostRulesQuery.isLoading
                                      ? 'Загрузка'
                                      : orderedManagedAutopostRules.length > 0
                                        ? `${orderedManagedAutopostRules.length} шт.`
                                        : 'Пусто'}
                                  </small>
                                </div>
                              </div>

                              <div className="broadcast-stage-card__body">
                                <div className="managed-broadcasts-list managed-broadcasts-list--autoposts">
                                  {orderedManagedAutopostRules.length === 0 &&
                                  !managedAutopostRulesQuery.isLoading ? (
                                    <div className="managed-broadcasts-list__empty">
                                      Автопостов пока нет.
                                    </div>
                                  ) : null}

                                  <Suspense fallback={<SkeletonCard lines={2} />}>
                                    {orderedManagedAutopostRules.map((rule) => (
                                      <LazyManagedAutopostRuleCard
                                        key={rule.id}
                                        rule={rule}
                                        nextLabel={formatCompactBroadcastDateTime(
                                          rule.nextSendAt,
                                          rule.scheduleTimezone,
                                        )}
                                        facts={buildManagedAutopostRuleFacts(rule, 'Текущий чат')}
                                        isBusy={isMailingBusy}
                                        onOpen={() =>
                                          openManagedAutopostRuleMutation.mutate(rule.id)
                                        }
                                        onPause={() =>
                                          updateManagedAutopostRuleMutation.mutate({
                                            ruleId: rule.id,
                                            status: 'PAUSED',
                                          })
                                        }
                                        onResume={() =>
                                          updateManagedAutopostRuleMutation.mutate({
                                            ruleId: rule.id,
                                            status: 'ACTIVE',
                                          })
                                        }
                                        onDelete={() => handleDeleteManagedAutopostRule(rule)}
                                      />
                                    ))}
                                  </Suspense>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="broadcast-stage-card broadcast-stage-card--feed">
                              <div className="broadcast-stage-card__head">
                                <div className="broadcast-stage-card__title-wrap">
                                  <strong>История</strong>
                                  <small>
                                    {managedBroadcastsQuery.isLoading
                                      ? 'Загрузка'
                                      : filteredManagedBroadcasts.length > 0
                                        ? `${filteredManagedBroadcasts.length} записей`
                                        : 'Пусто'}
                                  </small>
                                </div>
                              </div>

                              <div className="broadcast-stage-card__body">
                                <BroadcastHistoryFilterTabs
                                  value={mailingHistoryFilter}
                                  counts={mailingHistoryCounts}
                                  onChange={setMailingHistoryFilter}
                                />

                                <div className="managed-broadcasts-list">
                                  {filteredManagedBroadcasts.length === 0 &&
                                  !managedBroadcastsQuery.isLoading ? (
                                    <div className="managed-broadcasts-list__empty">
                                      История пока пустая.
                                    </div>
                                  ) : null}

                                  <Suspense fallback={<SkeletonCard lines={2} />}>
                                    {filteredManagedBroadcasts.map((broadcast) => {
                                      const cardTone = resolveManagedBroadcastCardTone(broadcast);
                                      const cardMetric = resolveManagedBroadcastMetric(
                                        broadcast,
                                        mailingNowMs,
                                      );
                                      const cardFacts = buildManagedBroadcastFactChips(broadcast);
                                      const canEditBroadcastSchedule =
                                        broadcast.scheduleMode === 'calendar' &&
                                        broadcast.status !== 'COMPLETED' &&
                                        broadcast.status !== 'CANCELED';
                                      const canCancelBroadcast =
                                        broadcast.status !== 'COMPLETED' &&
                                        broadcast.status !== 'CANCELED';
                                      const isDeletingBroadcast =
                                        cancelManagedBroadcastMutation.isPending &&
                                        cancelManagedBroadcastMutation.variables === broadcast.id;
                                      const isOpeningBroadcastEditor =
                                        openManagedBroadcastEditorMutation.isPending &&
                                        openManagedBroadcastEditorMutation.variables ===
                                          broadcast.id;
                                      const isRetryingBroadcast =
                                        retryManagedBroadcastMutation.isPending &&
                                        retryManagedBroadcastMutation.variables === broadcast.id;
                                      const cardBadge = isOpeningBroadcastEditor
                                        ? 'Открываем'
                                        : resolveManagedBroadcastCardBadge(broadcast);

                                      return (
                                        <LazyManagedBroadcastHistoryCard
                                          key={broadcast.id}
                                          broadcast={broadcast}
                                          tone={cardTone}
                                          badge={cardBadge}
                                          title={resolveManagedBroadcastCardTitle(broadcast)}
                                          metric={cardMetric}
                                          facts={cardFacts}
                                          canEdit={canEditBroadcastSchedule}
                                          canCancel={canCancelBroadcast}
                                          isBusy={isMailingBusy}
                                          isDeleting={isDeletingBroadcast}
                                          isRetrying={isRetryingBroadcast}
                                          onEdit={() => handleEditManagedBroadcast(broadcast)}
                                          onRetry={() =>
                                            retryManagedBroadcastMutation.mutate(broadcast.id)
                                          }
                                          onDelete={() => handleDeleteManagedBroadcast(broadcast)}
                                        />
                                      );
                                    })}
                                  </Suspense>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </SettingsDrilldownPanel>
              </GlassCard>
            ) : null}

            {shouldShowVkParsingSection ? (
              <GlassCard
                className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
                style={{ animationDelay: '326ms', order: 6 }}
                aria-label="ВК-парсинг"
              >
                <div
                  className={cn('settings-section__head', 'settings-section__head--interactive')}
                >
                  <SettingsSectionToggle
                    title="ВК-парсинг"
                    summary=""
                    status="Импорт"
                    icon="links"
                    tone="ink"
                    open={expandedSections.vkParsing}
                    controls="settings-vk-parsing-content"
                    onClick={() => toggleSection('vkParsing')}
                    hideChevron
                  />
                </div>

                <SettingsDrilldownPanel
                  id="settings-vk-parsing-content"
                  open={expandedSections.vkParsing}
                  title="ВК-парсинг"
                  tone="ink"
                  className="settings-drilldown__panel--campaign settings-drilldown__panel--vk-parsing"
                  onClose={() => toggleSection('vkParsing')}
                >
                  <div
                    id="settings-vk-parsing-content"
                    className={cn(
                      'settings-section__collapse',
                      expandedSections.vkParsing && 'is-open',
                    )}
                  >
                    {expandedSections.vkParsing ? (
                      <div className="settings-section__collapse-inner">
                        {canAccessVkParsing ? (
                          <Suspense fallback={null}>
                            <LazyVkParsingCard
                              api={api}
                              chatId={chatId ?? ''}
                              active={expandedSections.vkParsing}
                              entityType="chat"
                            />
                          </Suspense>
                        ) : vkParsingCapability ? (
                          <StatusState
                            tone="warning"
                            title="VK-парсинг не настроен"
                            description={
                              vkParsingCapability.reason ??
                              'VK-парсинг временно недоступен. Обратитесь к администратору сервиса.'
                            }
                            action={
                              <button
                                type="button"
                                className="button button--ghost"
                                disabled={vkParsingCapabilityQuery.isFetching}
                                onClick={() => void vkParsingCapabilityQuery.refetch()}
                              >
                                Проверить снова
                              </button>
                            }
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </SettingsDrilldownPanel>
              </GlassCard>
            ) : null}

            <SettingsCommentsSection
              draft={draft}
              expanded={expandedSections.comments}
              summary={commentsCardSummary}
              status={commentsCardStatus}
              openHintKey={openHintKey}
              isSaving={isSavingComments}
              canSave={isCommentsDirty()}
              onToggleSection={() => toggleSection('comments')}
              onToggleHint={toggleHint}
              onSave={() => void handleSaveComments()}
              onDiscardChanges={discardCommentsChanges}
              onToggleCommentsEnabled={(enabled) =>
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        commentsEnabled: enabled,
                        commentsAdminsEnabled:
                          enabled &&
                          !current.commentsAdminsEnabled &&
                          !current.commentsChatBroadcastsEnabled
                            ? true
                            : current.commentsAdminsEnabled,
                        commentsAllEnabled: false,
                      }
                    : current,
                )
              }
              onFieldChange={(key, value) => setFieldValue(key, value)}
            />

            <GlassCard
              className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
              style={{ animationDelay: '360ms', order: 4 }}
              aria-label="Подписка на чат или канал"
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Подписка"
                  summary={requiredSubscriptionHeaderSummary}
                  status={requiredSubscriptionCardStatus}
                  icon="subscription"
                  tone="sky"
                  open={expandedSections.requiredSubscription}
                  controls="settings-required-subscription-content"
                  onClick={() => toggleSection('requiredSubscription')}
                  hideChevron
                />
              </div>

              <SettingsDrilldownPanel
                id="settings-required-subscription-content"
                open={expandedSections.requiredSubscription}
                title="Обязательная подписка"
                summary={requiredSubscriptionHeaderSummary}
                tone="sky"
                className="settings-drilldown__panel--ladder settings-drilldown__panel--required-subscription"
                onClose={() => toggleSection('requiredSubscription')}
                confirmCloseWhen={isSectionDirty('requiredSubscription')}
                onDiscardChanges={() => discardSectionChanges('requiredSubscription')}
                footer={renderSectionSaveFooter('requiredSubscription', {
                  applyToAllLabel: 'Выбрать чаты',
                  emphasize: 'save',
                })}
              >
                <div
                  id="settings-required-subscription-content"
                  className={cn(
                    'settings-section__collapse',
                    expandedSections.requiredSubscription && 'is-open',
                  )}
                >
                  {expandedSections.requiredSubscription ? (
                    <div className="settings-section__collapse-inner managed-giveaway required-subscription__workspace">
                      <div className="managed-giveaway__section required-subscription__board">
                        <div className="managed-giveaway__title-row">
                          <div className="managed-giveaway__section-copy">
                            <strong>Источники подписки</strong>
                            <small>
                              {requiredSubscriptionSelectedCount}/
                              {REQUIRED_SUBSCRIPTION_MAX_CHANNELS}
                            </small>
                          </div>
                        </div>

                        <label className="field settings-text-field required-subscription__button-label">
                          <span>Название кнопки</span>
                          <input
                            type="text"
                            value={draft.requiredSubscriptionButtonText}
                            onChange={(event) =>
                              setFieldValue('requiredSubscriptionButtonText', event.target.value)
                            }
                            maxLength={32}
                            placeholder="По умолчанию: канал"
                          />
                        </label>

                        {requiredSubscriptionStaleCount > 0 ? (
                          <p
                            className={cn(
                              'settings-native-toggle__hint',
                              'settings-native-toggle__hint--danger',
                            )}
                          >
                            Есть недоступные ссылки. Исправьте или удалите их.
                          </p>
                        ) : null}

                        {requiredSubscriptionSelectedCount === 0 ? (
                          <div className="required-subscription__selection-empty">
                            <strong>Источники пока не выбраны</strong>
                          </div>
                        ) : null}

                        {selectedRequiredSubscriptionChannels.length > 0 ? (
                          <div className="required-subscription__selection-list">
                            {selectedRequiredSubscriptionChannels.map((channel) => {
                              const linkPreview = formatRequiredSubscriptionLinkPreview(
                                channel.link,
                              );

                              return (
                                <div
                                  key={`required-subscription-channel-${channel.id}`}
                                  className="required-subscription__selection-card"
                                >
                                  <EntityAvatar
                                    title={channel.title}
                                    entityType={channel.entityType}
                                    avatarUrl={channel.avatarUrl}
                                    className="required-subscription__selection-avatar"
                                  />
                                  <div
                                    className="required-subscription__selection-body"
                                    title={channel.link || channel.title}
                                  >
                                    <div className="required-subscription__selection-meta">
                                      <span className="required-subscription__selection-kind">
                                        {formatRequiredSubscriptionEntityLabel(channel.entityType)}
                                      </span>
                                      {linkPreview ? (
                                        <span className="required-subscription__selection-link">
                                          {linkPreview}
                                        </span>
                                      ) : null}
                                    </div>
                                    <strong className="required-subscription__selection-title">
                                      {channel.title}
                                    </strong>
                                  </div>
                                  <button
                                    type="button"
                                    className="required-subscription__selection-remove"
                                    onClick={() => removeRequiredSubscriptionChannel(channel.id)}
                                    aria-label={`Удалить ${formatRequiredSubscriptionEntityLabel(channel.entityType).toLowerCase()} ${channel.title}`}
                                  >
                                    <TrashIcon />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}

                        {selectedUnavailableRequiredSubscriptionChannels.length > 0 ? (
                          <div className="required-subscription__selection-list">
                            {selectedUnavailableRequiredSubscriptionChannels.map(
                              (channel, index) => (
                                <div
                                  key={`required-subscription-stale-${channel.id}`}
                                  className={cn(
                                    'required-subscription__selection-card',
                                    'is-warning',
                                  )}
                                >
                                  <span className="required-subscription__selection-rank">
                                    {selectedRequiredSubscriptionChannels.length + index + 1}
                                  </span>
                                  <div
                                    className="required-subscription__selection-body"
                                    title={channel.description}
                                  >
                                    <div className="required-subscription__selection-meta">
                                      <span className="required-subscription__selection-state">
                                        Недоступно
                                      </span>
                                    </div>
                                    <strong className="required-subscription__selection-title">
                                      {channel.title}
                                    </strong>
                                    <small className="required-subscription__selection-detail">
                                      {channel.description}
                                    </small>
                                  </div>
                                  <button
                                    type="button"
                                    className="required-subscription__selection-remove"
                                    onClick={() => removeRequiredSubscriptionChannel(channel.id)}
                                    aria-label={`Удалить недоступный чат или канал ${channel.title}`}
                                  >
                                    <TrashIcon />
                                  </button>
                                </div>
                              ),
                            )}
                          </div>
                        ) : null}

                        {requiredSubscriptionChannelsError ? (
                          <small className="field__hint">{requiredSubscriptionChannelsError}</small>
                        ) : null}

                        <Suspense
                          fallback={
                            <div className="required-subscription__source-picker">
                              <div className="required-subscription__source-skeleton" aria-hidden>
                                <span />
                                <span />
                                <span />
                              </div>
                            </div>
                          }
                        >
                          <LazyRequiredSubscriptionSourcePicker
                            choices={availableRequiredSubscriptionChannelChoices}
                            selectedCount={requiredSubscriptionSelectedCount}
                            maxSelectedCount={REQUIRED_SUBSCRIPTION_MAX_CHANNELS}
                            loading={requiredSubscriptionEntitiesLoading}
                            syncing={requiredSubscriptionEntitiesSyncing}
                            error={
                              requiredSubscriptionEntitiesError
                                ? formatApiError(requiredSubscriptionEntitiesError)
                                : null
                            }
                            backoffActive={requiredSubscriptionEntitiesBackoffActive}
                            emptyState={requiredSubscriptionPickerEmptyState}
                            onAdd={addRequiredSubscriptionChannel}
                            onRefresh={refreshRequiredSubscriptionChannels}
                          />
                        </Suspense>

                        {unavailableManagedRequiredSubscriptionChannels.length > 0 ? (
                          <>
                            <small className="field__hint">Недоступные элементы</small>
                            <div className="managed-giveaway__prize-editor-list">
                              {unavailableManagedRequiredSubscriptionChannels.map(
                                (channel, index) => (
                                  <div
                                    key={`required-subscription-unavailable-${channel.id}`}
                                    className="managed-giveaway__prize-editor-row"
                                  >
                                    <span className="managed-giveaway__prize-position">
                                      {index + 1}
                                    </span>
                                    <span
                                      className={cn(
                                        'managed-giveaway__selected-channel',
                                        'managed-giveaway__selected-channel--multiline',
                                      )}
                                      title={channel.description}
                                    >
                                      <strong className="managed-giveaway__selected-channel-label">
                                        {channel.title}
                                      </strong>
                                      <small className="managed-giveaway__selected-channel-detail">
                                        {channel.description}
                                      </small>
                                    </span>
                                  </div>
                                ),
                              )}
                            </div>
                          </>
                        ) : null}

                        <div className="required-subscription__external-source">
                          <div className="managed-giveaway__editor-grid">
                            <label
                              className={cn(
                                'field settings-text-field',
                                requiredSubscriptionExternalChannelError && 'field--error',
                              )}
                            >
                              <span>Ссылка на чат или канал</span>
                              <input
                                type="text"
                                value={requiredSubscriptionExternalChannelValue}
                                onChange={(event) => {
                                  setRequiredSubscriptionExternalChannelValue(event.target.value);
                                  if (requiredSubscriptionExternalChannelError) {
                                    setRequiredSubscriptionExternalChannelError('');
                                  }
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault();
                                    handleResolveRequiredSubscriptionExternalChannel();
                                  }
                                }}
                                placeholder="https://max.ru/... или id чата/канала"
                                disabled={isResolvingRequiredSubscriptionChannel}
                              />
                              {requiredSubscriptionExternalChannelError ? (
                                <small className="field__hint">
                                  {requiredSubscriptionExternalChannelError}
                                </small>
                              ) : null}
                            </label>
                            <div className="managed-giveaway__section-actions managed-giveaway__section-actions--align-end">
                              <button
                                type="button"
                                className="button button--ghost managed-giveaway__channel-action"
                                disabled={
                                  isResolvingRequiredSubscriptionChannel ||
                                  requiredSubscriptionSelectedCount >=
                                    REQUIRED_SUBSCRIPTION_MAX_CHANNELS
                                }
                                onClick={handleResolveRequiredSubscriptionExternalChannel}
                              >
                                {isResolvingRequiredSubscriptionChannel
                                  ? 'Проверяем...'
                                  : 'Добавить'}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div
                        className="settings-subsection-divider"
                        role="separator"
                        aria-label="Действия бота для обязательной подписки"
                      >
                        <span>Действия</span>
                      </div>

                      <div className="settings-native-toggle">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">1. Объяснение</span>
                            <div className="settings-native-toggle__title-actions">
                              <EditToggleButton
                                label="Редактировать объяснение об обязательной подписке"
                                onClick={() => toggleBotMessageEditor('requiredSubscription')}
                                isOpen={openBotEditorKey === 'requiredSubscription'}
                              />
                            </div>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить объяснение для обязательной подписки"
                          >
                            <input
                              type="checkbox"
                              checked={draft.requiredSubscriptionBotMessageEnabled}
                              onChange={(event) => {
                                setFieldValue(
                                  'requiredSubscriptionBotMessageEnabled',
                                  event.target.checked,
                                );
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {draft.requiredSubscriptionBotMessageEnabled &&
                        openBotEditorKey === 'requiredSubscription' ? (
                          <LazyBotMessageEditor
                            editorKey="requiredSubscription"
                            {...botSpeechEditorProps!}
                            botSpeechPreviewContext={botSpeechPreviewContext}
                            value={draft.requiredSubscriptionBotMessageText}
                            onChange={(nextValue) =>
                              setFieldValue(
                                'requiredSubscriptionBotMessageText',
                                nextValue as ChatSettings['requiredSubscriptionBotMessageText'],
                              )
                            }
                            onReset={() => setFieldValue('requiredSubscriptionBotMessageText', '')}
                            onClose={() => setOpenBotEditorKey(null)}
                          />
                        ) : null}
                      </div>

                      {draft.requiredSubscriptionBotMessageEnabled
                        ? renderAdminContactToggle(
                            REQUIRED_SUBSCRIPTION_ADMIN_CONTACT_BUTTON_GROUP,
                            'Добавить связь с админом в сообщения об обязательной подписке',
                          )
                        : null}

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <div className="settings-native-toggle__title-wrap">
                            <span className="settings-native-toggle__title">2. Предупреждение</span>
                            <div className="settings-native-toggle__title-actions">
                              <EditToggleButton
                                label="Редактировать предупреждение об обязательной подписке"
                                onClick={() => toggleWarnMessageEditor('requiredSubscriptionWarn')}
                                isOpen={openWarnEditorKey === 'requiredSubscriptionWarn'}
                              />
                            </div>
                          </div>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить предупреждение за второе сообщение без подписки"
                          >
                            <input
                              type="checkbox"
                              checked={draft.requiredSubscriptionWarnEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('requiredSubscriptionWarnEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('requiredSubscriptionBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>

                        {openWarnEditorKey === 'requiredSubscriptionWarn' ? (
                          <LazyWarnMessageEditor
                            editorKey="requiredSubscriptionWarn"
                            {...botSpeechEditorProps!}
                            botSpeechPreviewContext={botSpeechPreviewContext}
                            value={draft.requiredSubscriptionWarnMessageText}
                            onChange={(nextValue) =>
                              setFieldValue(
                                'requiredSubscriptionWarnMessageText',
                                nextValue as ChatSettings['requiredSubscriptionWarnMessageText'],
                              )
                            }
                            onReset={() => setFieldValue('requiredSubscriptionWarnMessageText', '')}
                            onClose={() => setOpenWarnEditorKey(null)}
                          />
                        ) : null}
                      </div>

                      {renderMuteStageToggle({
                        enabledKey: 'requiredSubscriptionMuteEnabled',
                        durationKey: 'requiredSubscriptionMuteDurationHours',
                        title: '3. Мут',
                        onEnable: () => {
                          setFieldValue('requiredSubscriptionWarnEnabled', true);
                          setFieldValue('requiredSubscriptionBotMessageEnabled', true);
                        },
                      })}

                      <div className="settings-native-toggle settings-native-toggle--nested">
                        <div className="settings-native-toggle__row">
                          <span className="settings-native-toggle__title">4. Бан</span>

                          <label
                            className="settings-native-switch"
                            aria-label="Включить бан за повторные сообщения без подписки"
                          >
                            <input
                              type="checkbox"
                              checked={draft.requiredSubscriptionBanEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setFieldValue('requiredSubscriptionBanEnabled', enabled);
                                if (enabled) {
                                  setFieldValue('requiredSubscriptionWarnEnabled', true);
                                  setFieldValue('requiredSubscriptionBotMessageEnabled', true);
                                }
                              }}
                            />
                            <span className="toggle-switch" aria-hidden>
                              <span className="toggle-switch__thumb" />
                            </span>
                          </label>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </SettingsDrilldownPanel>
            </GlassCard>

            <Suspense fallback={null}>
              <LazySettingsAdminCommandsSection
                draft={draft}
                expanded={expandedSections.commands}
                fieldErrors={fieldErrors}
                openHintKey={openHintKey}
                footer={renderSectionSaveFooter('commands')}
                hasChanges={isSectionDirty('commands')}
                onDiscardChanges={() => discardSectionChanges('commands')}
                onToggleSection={() => toggleSection('commands')}
                onToggleHint={toggleHint}
                onFieldChange={(key, value) => setFieldValue(key, value)}
              />
            </Suspense>

            <SettingsExtraSection
              draft={draft}
              expanded={expandedSections.extra}
              summary={extraHeaderSummary}
              status={extraCardStatus}
              openHintKey={openHintKey}
              fieldErrors={fieldErrors}
              footer={renderSectionSaveFooter('extra')}
              hasChanges={isSectionDirty('extra')}
              onDiscardChanges={() => discardSectionChanges('extra')}
              onToggleSection={() => toggleSection('extra')}
              onToggleHint={toggleHint}
              onFieldChange={(key, value) => setFieldValue(key, value)}
              onAdjustDeleteBotMessagesDelay={adjustDeleteBotMessagesDelay}
            />

            <GlassCard
              className="settings-section settings-home-entry stagger-in"
              style={{ order: 32 }}
            >
              <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
                <SettingsSectionToggle
                  title="Стиль речи"
                  summary=""
                  status=""
                  icon="comments"
                  tone="mint"
                  open={speechStylePanelOpen}
                  controls="settings-bot-speech-style"
                  onClick={() => {
                    setPendingSpeechStyle(activeSpeechStyle ?? 'ROBOT');
                    setSpeechStylePanelOpen(true);
                  }}
                />
              </div>
            </GlassCard>
          </div>
        </section>
      ) : null}

      {!settingsQuery.isLoading && !settingsQuery.error && !draft ? (
        <GlassCard>
          <StatusState
            tone="warning"
            title="Настройки не найдены"
            description="Повторите загрузку страницы."
          />
        </GlassCard>
      ) : null}

      <Suspense fallback={null}>
        <LazyBroadcastButtonsSheet
          open={rulesButtonsSheetOpen}
          api={api}
          enabled={rulesButtonEnabled}
          buttons={rulesDraft?.buttons ?? []}
          errors={rulesButtonErrors}
          revealNextStepSignal={rulesButtonRevealSignal}
          disabled={isRulesBusy}
          urlPlaceholder="https://max.ru/channel/rules"
          textPlaceholder={DEFAULT_RULES_POST_BUTTON_TEXT}
          onEnabledChange={handleRulesButtonsEnabledChange}
          onChange={(nextButtons) => {
            setRulesButtonFieldsTouched(true);
            setRulesButtonErrors([]);
            const buttonState = buildBroadcastLinkButtonLegacyFields(nextButtons);
            setRulesDraft((current) =>
              current
                ? {
                    ...current,
                    buttons: nextButtons,
                    buttonEnabled: nextButtons.length > 0,
                    buttonUrl: buttonState.buttonUrl,
                    buttonText: buttonState.buttonText,
                  }
                : current,
            );
          }}
          onClose={() => setRulesButtonsSheetOpen(false)}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyBroadcastButtonsSheet
          open={mailingButtonsSheetOpen}
          api={api}
          enabled={mailingButtonEnabled}
          buttons={mailingButtons}
          errors={mailingButtonErrors}
          revealNextStepSignal={mailingButtonRevealSignal}
          disabled={isMailingBusy}
          urlPlaceholder="https://max.ru/channel/..."
          textPlaceholder="Открыть"
          onEnabledChange={handleMailingButtonsEnabledChange}
          onChange={(nextButtons) => {
            setMailingButtons(nextButtons);
            if (mailingButtonErrors.length > 0) {
              setMailingButtonErrors([]);
            }
          }}
          onClose={() => setMailingButtonsSheetOpen(false)}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyBroadcastPublishReviewSheet
          id="mailing-publish-review"
          open={pendingMailingPublishReview !== null}
          text={pendingMailingReviewPayload?.text ?? ''}
          hasMedia={Boolean(
            pendingMailingReviewPayload?.imageEnabled ||
            pendingMailingReviewPayload?.mediaType === 'video',
          )}
          facts={pendingMailingReviewFacts}
          confirmLabel={mailingPrimaryActionLabel}
          confirmBusyLabel={
            updateManagedBroadcastMutation.isPending ? 'Сохраняем...' : 'Публикуем...'
          }
          isBusy={
            updateManagedBroadcastMutation.isPending || sendBroadcastHandoffMutation.isPending
          }
          extraActionBusy={sendBroadcastTestMutation.isPending}
          extraActionDisabled={!mailingTestReady}
          onExtraAction={handleSendBroadcastTest}
          onClose={handleCloseMailingPublishReview}
          onConfirm={confirmMailingPublishReview}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyActionConfirmSheet
          id="mailing-slot-conflict"
          open={pendingMailingSlotConflict !== null}
          title="Время занято"
          summary="Можно заменить только эту отправку."
          previewTitle={
            pendingMailingConflictPreviewSlot
              ? formatCompactBroadcastDateTime(
                  pendingMailingConflictPreviewSlot,
                  pendingMailingSlotConflict?.payload.scheduleTimezone,
                )
              : 'Занято'
          }
          previewMeta={
            pendingMailingConflictSlots.length > 1
              ? formatRussianCountLabel(
                  pendingMailingConflictSlots.length,
                  'занятая отправка',
                  'занятые отправки',
                  'занятых отправок',
                )
              : 'Заменим, если получатели свободны.'
          }
          confirmLabel="Заменить"
          cancelLabel="Другое время"
          tone="accent"
          onClose={handleCloseMailingSlotConflict}
          onConfirm={confirmMailingSlotReplacement}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyActionConfirmSheet
          id="managed-broadcast-delete"
          open={managedBroadcastDeleteTarget !== null}
          title="Отменить отправки?"
          previewTitle={
            managedBroadcastDeleteTarget ? (
              <LazyActionConfirmMarkdownPreview
                value={managedBroadcastDeleteTarget.textPreview}
                fallback={
                  managedBroadcastDeleteTarget.textPreview ||
                  (managedBroadcastDeleteTarget.hasImage ? 'Фото без текста' : null)
                }
              />
            ) : undefined
          }
          previewMeta={
            managedBroadcastDeleteTarget
              ? managedBroadcastDeleteTarget.nextSendAt
                ? `Следующая отправка · ${formatCompactBroadcastDateTime(
                    managedBroadcastDeleteTarget.nextSendAt,
                    managedBroadcastDeleteTarget.scheduleTimezone,
                  )}`
                : 'Будущие отправки будут сняты.'
              : undefined
          }
          confirmLabel="Отменить"
          confirmBusyLabel="Отменяем..."
          tone="danger"
          isBusy={cancelManagedBroadcastMutation.isPending}
          onClose={() => setManagedBroadcastDeleteTarget(null)}
          onConfirm={confirmDeleteManagedBroadcast}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyActionConfirmSheet
          id="managed-autopost-rule-delete"
          open={managedAutopostRuleDeleteTarget !== null}
          title="Отменить автопост?"
          previewTitle={
            managedAutopostRuleDeleteTarget ? (
              <LazyActionConfirmMarkdownPreview
                value={managedAutopostRuleDeleteTarget.textPreview}
                fallback={
                  managedAutopostRuleDeleteTarget.textPreview ||
                  (managedAutopostRuleDeleteTarget.hasVideo
                    ? 'Видео без текста'
                    : managedAutopostRuleDeleteTarget.hasImage
                      ? 'Фото без текста'
                      : 'Пусто')
                }
              />
            ) : undefined
          }
          previewMeta={
            managedAutopostRuleDeleteTarget?.nextSendAt
              ? `Следующий · ${formatCompactBroadcastDateTime(
                  managedAutopostRuleDeleteTarget.nextSendAt,
                  managedAutopostRuleDeleteTarget.scheduleTimezone,
                )}`
              : undefined
          }
          confirmLabel="Отменить"
          confirmBusyLabel="Отменяем..."
          tone="danger"
          isBusy={deleteManagedAutopostRuleMutation.isPending}
          onClose={() => setManagedAutopostRuleDeleteTarget(null)}
          onConfirm={confirmDeleteManagedAutopostRule}
        />
      </Suspense>
    </div>
  );
}
