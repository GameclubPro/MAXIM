import { Suspense, type ReactNode } from 'react';
import type { ApplySectionKey } from '../settings-page-state';
import type { ApiTransport } from '../../lib/api/transport';
import type {
  ChatScalarFieldPath,
  ChatSettingsFieldAdapter,
} from '../../features/network-settings/field-model';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { Spinner } from '../../components/ui/spinner';

export type SharedChatSettingsContext = {
  mode: 'single' | 'network';
  api: ApiTransport;
  sectionTools?: Partial<Record<ApplySectionKey, ReactNode>>;
  navigationAllowlist?: ReactNode;
  requiredSubscriptionSources?: ReactNode;
  renderAdminContact?: (input: {
    enabledPath: ChatScalarFieldPath;
    urlPath: ChatScalarFieldPath;
    label: string;
    ariaLabel?: string;
    presentation?: 'rules';
  }) => ReactNode;
  runtimeNotes?: Partial<Record<ApplySectionKey, ReactNode>>;
  invitationActivationAvailable?: boolean;
  reportsActivationAvailable?: boolean;
};

export type SharedChatSettingsSectionProps = {
  section: ApplySectionKey;
  fields: ChatSettingsFieldAdapter;
  context: SharedChatSettingsContext;
};

const LazySharedChatSettingsFields = recoverableLazyNamedComponent<SharedChatSettingsSectionProps>(
  () => import('./shared-chat-settings-fields'),
  'SharedChatSettingsFields',
);

export function SharedChatSettingsSection(props: SharedChatSettingsSectionProps) {
  return (
    <Suspense fallback={<Spinner label="Загружаем настройки" />}>
      <LazySharedChatSettingsFields {...props} />
    </Suspense>
  );
}
