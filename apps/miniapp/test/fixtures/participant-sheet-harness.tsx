import { createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatParticipantSheet } from '../../src/components/dashboard/chat-participant-sheet';
import { runNativeBackHandlers } from '../../src/lib/native-back';
import '../../src/styles.css';
import '../../src/styles/settings-drilldown-core.css';
import '../../src/styles/settings-experience.css';
import '../../src/styles/moderation-workspace.css';

type Props = ComponentProps<typeof ChatParticipantSheet>;
type Options = Partial<
  Pick<Props, 'item' | 'isSavingImmunity' | 'isApplyingModeration' | 'isOpeningProfile'>
>;

const actions: Array<{ kind: string; payload?: unknown }> = [];
const participant: NonNullable<Props['item']> = {
  userId: '123456',
  userDisplayName: 'Александра Константиновна',
  username: 'alexandra',
  role: 'member',
  isBot: false,
  avatarUrl: null,
  profileUrl: null,
  profileHandoffUrl: null,
  violationCount: 3,
  immunity: null,
};

let options: Options = {};
const root = createRoot(document.getElementById('root')!);
const render = (next: Options = {}) => {
  options = { ...options, ...next };
  root.render(
    createElement(ChatParticipantSheet, {
      open: true,
      rangeLabel: 'за 7 дней',
      item: participant,
      isSavingImmunity: false,
      isApplyingModeration: false,
      isOpeningProfile: false,
      ...options,
      onClose: () => actions.push({ kind: 'close' }),
      onSaveImmunity: (payload) => {
        actions.push({ kind: 'save', payload });
        render({ isSavingImmunity: true });
      },
      onClearImmunity: () => {
        actions.push({ kind: 'clear' });
        render({ isSavingImmunity: true });
      },
      onMute: (payload) => actions.push({ kind: 'mute', payload }),
      onBan: () => actions.push({ kind: 'ban' }),
      onProfileActivate: () => actions.push({ kind: 'profile' }),
      onSpammerDiagnostics: () => actions.push({ kind: 'check' }),
    }),
  );
};

document.body.dataset.miniappProfile = 'moderation';
Object.assign(window, {
  participantSheetTest: { actions, participant, render, back: runNativeBackHandlers },
});
render();
