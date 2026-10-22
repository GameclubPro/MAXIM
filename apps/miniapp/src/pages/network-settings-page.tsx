import { Suspense, lazy, useState } from 'react';
import type { NetworkSettingsOperationResponse } from '@maxim/contracts/network-settings';
import type { ApiTransport } from '../lib/api/transport';
import {
  useNetworkSettingsController,
  carryNetworkSettingsRetryDraft,
} from '../features/network-settings/network-settings-controller';
import { createNetworkSettingsFieldAdapter } from '../features/network-settings/network-settings-field-bindings';
import type {
  ChatSettingsFieldValues,
  ChannelSettingsFieldValues,
} from '../features/network-settings/field-model';
import {
  createNetworkSettingsScope,
  readNetworkSettingsScope,
  type NetworkSettingsEditorScope,
  type NetworkChannelSettingsSection,
} from '../lib/network-settings-workspace-state';
import {
  useManagedEntityLeaveGuard,
  useManagedEntityNavigation,
} from '../lib/managed-entity-navigation';
import { recoverableLazyNamedComponent } from '../lib/recoverable-lazy';
import type { NetworkSettingsReviewProps } from '../features/network-settings/network-settings-review';
import type { NetworkSettingsOperationPanelProps } from '../features/network-settings/network-settings-operation-panel';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import { SettingsSectionIcon } from '../components/ui/settings-section-toggle';
import { getNetworkSettingsSectionPresentation } from './settings/settings-workspace-sections';
import { isSupplementaryChatSettingsSection } from '../features/network-settings/field-paths';
import '../styles/settings-drilldown-core.css';
import '../styles/settings-policy-controls.css';
import '../styles/settings-native-controls.css';
import '../styles/settings-link-allowlist.css';
import '../styles/settings-drilldown-polish.css';
import '../styles/settings-duration-editor.css';
import '../styles/settings-route-polish.css';
import '../styles/settings-interaction-polish.css';
import '../styles/settings-native-polish.css';
import '../styles/settings-experience.css';
import '../styles/channel-post-signature.css';
import './network-settings-page.css';
export type { NetworkSettingsEditorScope, NetworkChannelSettingsSection };
export interface NetworkSettingsPageProps {
  api: ApiTransport;
  userId: string;
  scopeId: string;
  scope: NetworkSettingsEditorScope;
  title: string;
  returnTo: string;
  resumeOperationId?: string;
  onOperationChange?: (operation: NetworkSettingsOperationResponse | null) => void;
  onClose: () => void;
}
export type NetworkSettingsEditorProps = NetworkSettingsPageProps;
const SharedChatSettingsSection = lazy(() =>
  import('./settings/shared-chat-settings-section').then((module) => ({
    default: module.SharedChatSettingsSection,
  })),
);
const ChannelQuickButtonsFields = lazy(() =>
  import('./settings/channel-quick-buttons-fields').then((module) => ({
    default: module.ChannelQuickButtonsFields,
  })),
);
const ChannelCommentsFields = lazy(() =>
  import('./settings/channel-comments-fields').then((module) => ({
    default: module.ChannelCommentsFields,
  })),
);
const ChannelPostSuggestionsFields = lazy(() =>
  import('./settings/channel-post-suggestions-fields').then((module) => ({
    default: module.ChannelPostSuggestionsFields,
  })),
);
const SharedSupplementaryChatSettingsFields = lazy(() =>
  import('./settings/shared-supplementary-chat-settings-fields').then((module) => ({
    default: module.SharedSupplementaryChatSettingsFields,
  })),
);
const ChannelPostSignatureFields = lazy(() =>
  import('./settings/channel-post-signature-fields').then((module) => ({
    default: module.ChannelPostSignatureFields,
  })),
);
const NetworkSettingsMetadataFields = lazy(() =>
  import('../features/network-settings/network-settings-metadata-fields').then((module) => ({
    default: module.NetworkSettingsMetadataFields,
  })),
);
const NetworkSettingsReview = recoverableLazyNamedComponent<NetworkSettingsReviewProps>(
  () => import('../features/network-settings/network-settings-review'),
  'NetworkSettingsReview',
);
const NetworkSettingsOperationPanel =
  recoverableLazyNamedComponent<NetworkSettingsOperationPanelProps>(
    () => import('../features/network-settings/network-settings-operation-panel'),
    'NetworkSettingsOperationPanel',
  );
export function NetworkSettingsPage(props: NetworkSettingsPageProps) {
  const controller = useNetworkSettingsController(props);
  const navigation = useManagedEntityNavigation();
  const [freshEditorError, setFreshEditorError] = useState<string | null>(null);
  const scope = props.scope;
  const section = scope.initialSection;
  const presentation = getNetworkSettingsSectionPresentation(scope.entityType, section);
  const binding = {
    entityType: scope.entityType,
    section,
    fields: controller.read?.fields ?? {},
    changes: controller.changes,
    errors: controller.errors,
    readOnly: controller.readOnly,
    onChanges: controller.setChanges,
    onError: controller.setFieldError,
  };
  const chatFields = createNetworkSettingsFieldAdapter<ChatSettingsFieldValues>(binding);
  const channelFields = createNetworkSettingsFieldAdapter<ChannelSettingsFieldValues>(binding);
  useManagedEntityLeaveGuard({
    dirty: controller.dirty,
    saving: controller.phase === 'apply',
    discardOnly: true,
    save: async () => false,
    discard: controller.discard,
  });
  const retry = () => {
    if (!controller.failedRecipients.length || controller.failedRecipients.length > 500) return;
    const previous = readNetworkSettingsScope({
      userId: props.userId,
      scopeId: props.scopeId,
      entityType: scope.entityType,
    });
    const newScope = createNetworkSettingsScope({
      userId: props.userId,
      title: props.title,
      returnTo: props.returnTo,
      origin: previous?.origin,
      scope: { ...scope, target: { mode: 'selected', entityIds: controller.failedRecipients } },
    });
    carryNetworkSettingsRetryDraft(
      newScope.scopeId,
      controller.retryChanges,
      controller.navigationAllowlist,
    );
    navigation.requestNavigation(
      '/networks/' + scope.entityType + '/settings/' + section + '?scope=' + newScope.scopeId,
    );
  };
  const startAgain = () => {
    if (!controller.canStartAgain) return;
    try {
      const previous = readNetworkSettingsScope({
        userId: props.userId,
        scopeId: props.scopeId,
        entityType: scope.entityType,
      });
      const fresh = createNetworkSettingsScope({
        userId: props.userId,
        title: props.title,
        returnTo: props.returnTo,
        origin: previous?.origin,
        scope,
      });
      setFreshEditorError(null);
      navigation.requestNavigation(
        '/networks/' + scope.entityType + '/settings/' + section + '?scope=' + fresh.scopeId,
      );
    } catch (cause) {
      setFreshEditorError(
        cause instanceof Error ? cause.message : 'Не удалось открыть новые настройки.',
      );
    }
  };
  const recipientTitles = new Map(
    (controller.preview?.recipients ?? controller.read?.recipients ?? []).map((row) => [
      row.entityId,
      row.title,
    ]) ?? [],
  );
  const footer = (
    <>
      {controller.preview ? (
        <p className="settings-drilldown__footer-note">
          Получателей: {controller.preview.recipients.length}. Проверьте выбранные изменения перед
          применением.
        </p>
      ) : controller.read && controller.read.recipientCount > 0 ? (
        <p className="settings-drilldown__footer-note">Изменятся только заданные вами параметры.</p>
      ) : null}
      <div className="settings-drilldown__footer-actions is-single-action">
        {controller.preview ? (
          <button
            type="button"
            className="button button--accent"
            disabled={!controller.canApply || controller.phase !== 'idle'}
            aria-busy={controller.phase === 'apply' || undefined}
            onClick={() => void controller.apply()}
          >
            Применить к выбранным
          </button>
        ) : (
          <button
            type="button"
            className="button button--accent"
            disabled={
              controller.readOnly ||
              (!controller.changes.length && !controller.navigationAllowlist) ||
              Object.keys(controller.errors).length > 0
            }
            aria-busy={controller.phase === 'preview' || undefined}
            onClick={() => void controller.prepare()}
          >
            Проверить изменения
          </button>
        )}
      </div>
    </>
  );
  return (
    <SettingsDrilldownPanel
      id={'network-settings-' + scope.entityType + '-' + section}
      open
      title={presentation.title}
      icon={
        presentation.panelIcon === false ? undefined : (
          <SettingsSectionIcon name={presentation.icon} />
        )
      }
      tone={presentation.tone}
      variant={presentation.variant}
      overlayClassName={presentation.overlayClassName}
      summary={
        controller.read
          ? props.title + ' · Выбрано: ' + controller.read.recipientCount
          : props.title
      }
      className={presentation.panelClassName + ' network-settings-editor'}
      onClose={props.onClose}
      confirmCloseWhen={false}
      footer={footer}
      keepFooterVisibleWhenKeyboardOpen
    >
      <div className="network-settings-editor__content" aria-busy={controller.phase !== 'idle'}>
        {controller.phase === 'loading' ? (
          <p className="network-settings-editor__status" role="status">
            Загружаем настройки: {controller.progress.loaded}
            {controller.progress.total ? ' из ' + controller.progress.total : ''}
          </p>
        ) : null}
        {controller.error ? (
          <div className="network-settings-page__error" role="alert">
            <p>{controller.error}</p>
            {!controller.read ? (
              <button type="button" className="button button--ghost" onClick={controller.reload}>
                Загрузить заново
              </button>
            ) : null}
          </div>
        ) : null}
        {freshEditorError ? (
          <p className="network-settings-page__error" role="alert">
            {freshEditorError}
          </p>
        ) : null}
        {controller.read?.recipientCount === 0 ? (
          <p className="network-settings-editor__status">
            В выбранной категории пока нет сообществ.
          </p>
        ) : null}
        {controller.read && controller.read.recipientCount > 0 ? (
          <Suspense fallback={<p role="status">Загружаем раздел…</p>}>
            {scope.entityType === 'chat' ? (
              <NetworkSettingsMetadataFields
                api={props.api}
                scopeId={props.scopeId}
                read={controller.read}
                fields={chatFields}
                navigationAllowlist={controller.navigationAllowlist}
                onNavigationAllowlist={controller.setNavigationAllowlist}
              >
                {(context) =>
                  isSupplementaryChatSettingsSection(scope.initialSection) ? (
                    <SharedSupplementaryChatSettingsFields
                      section={scope.initialSection}
                      fields={chatFields}
                      context={context}
                    />
                  ) : (
                    <SharedChatSettingsSection
                      section={scope.initialSection}
                      fields={chatFields}
                      context={context}
                    />
                  )
                }
              </NetworkSettingsMetadataFields>
            ) : section === 'quickButtons' ? (
              <ChannelQuickButtonsFields fields={channelFields} />
            ) : section === 'comments' || section === 'postSuggestions' ? (
              <div className="settings-section__collapse is-open">
                <div className="settings-section__collapse-inner">
                  {section === 'comments' ? (
                    <ChannelCommentsFields fields={channelFields} />
                  ) : (
                    <ChannelPostSuggestionsFields fields={channelFields} />
                  )}
                </div>
              </div>
            ) : (
              <div className="settings-section__collapse channel-post-signature is-open">
                <div className="settings-section__collapse-inner channel-post-signature__panel-body">
                  <ChannelPostSignatureFields fields={channelFields} />
                </div>
              </div>
            )}
          </Suspense>
        ) : null}
        {controller.changes.length > 0 || controller.navigationAllowlist ? (
          <Suspense fallback={<p role="status">Загружаем список изменений…</p>}>
            <NetworkSettingsReview controller={controller} recipientTitles={recipientTitles} />
          </Suspense>
        ) : null}
        {controller.operation ? (
          <Suspense fallback={<p role="status">Загружаем результат операции…</p>}>
            <NetworkSettingsOperationPanel
              operation={controller.operation}
              controller={controller}
              recipientTitles={recipientTitles}
              resumeOperationId={props.resumeOperationId}
              onStartAgain={startAgain}
              onRetry={retry}
            />
          </Suspense>
        ) : null}
      </div>
    </SettingsDrilldownPanel>
  );
}
export { NetworkSettingsPage as NetworkSettingsEditor };
