import type {
  ManagedEntityAssignedBot,
  ManagedEntityBotCapability,
  ManagedEntityBotExecutionPlan,
} from '@maxim/contracts';

const CAPABILITY_LABELS: Record<ManagedEntityBotCapability, string> = {
  background_scans: 'Фоновые сканы',
  channel_stats: 'Статистика',
  suggestion_delivery: 'Доставка идей',
  membership_prewarm: 'Membership prewarm',
  access_prewarm: 'Access prewarm',
};

function describePersona(bot: ManagedEntityAssignedBot): string {
  if (bot.speechPersona === 'female') {
    return 'Женская persona';
  }
  if (bot.speechPersona === 'neutral') {
    return 'Нейтральная persona';
  }
  return 'Мужская persona';
}

function toneClassForBot(bot: ManagedEntityAssignedBot): string {
  if (bot.membershipStatus === 'removed') {
    return 'chip chip--danger';
  }
  if (bot.role === 'primary') {
    return 'chip chip--success';
  }
  if (bot.lifecycleState === 'dormant' || bot.lifecycleState === 'draining') {
    return 'chip chip--warning';
  }
  return 'chip';
}

function modeLabel(mode: ManagedEntityBotExecutionPlan['sharedMode']): string {
  switch (mode) {
    case 'shared-assist':
      return 'Shared assist';
    case 'shared-failover':
      return 'Shared failover';
    case 'shared-standby':
      return 'Shared standby';
    default:
      return 'Owned';
  }
}

export function BotExecutionPanel({
  plan,
  isRefreshing,
  pendingPrimaryBotId,
  pendingAssistBotId,
  onRefresh,
  onMakePrimary,
  onToggleAssist,
}: {
  plan: ManagedEntityBotExecutionPlan;
  isRefreshing: boolean;
  pendingPrimaryBotId: string | null;
  pendingAssistBotId: string | null;
  onRefresh: () => void;
  onMakePrimary: (botId: string) => void;
  onToggleAssist: (botId: string, enabled: boolean) => void;
}) {
  return (
    <section className="bot-execution-panel">
      <div className="bot-execution-panel__hero">
        <div>
          <p className="bot-execution-panel__eyebrow">Команда ботов</p>
          <h3>Execution planner</h3>
          <p className="bot-execution-panel__summary">
            Owner ведёт user-facing path, partner подключается только в безопасных assist-lane’ах.
          </p>
        </div>
        <div className="bot-execution-panel__hero-actions">
          <span className="chip">{modeLabel(plan.sharedMode)}</span>
          <button
            type="button"
            className="button button--ghost"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            {isRefreshing ? 'Обновляю права…' : 'Обновить права'}
          </button>
        </div>
      </div>

      <div className="bot-execution-panel__routing-grid">
        <div className="bot-execution-panel__routing-item">
          <small>Owner / speaker</small>
          <strong>{plan.speakerBotId ?? 'Не назначен'}</strong>
        </div>
        <div className="bot-execution-panel__routing-item">
          <small>Partner</small>
          <strong>{plan.partnerBotId ?? 'Нет partner-бота'}</strong>
        </div>
        <div className="bot-execution-panel__routing-item">
          <small>Mini app / deep links</small>
          <strong>{plan.linkBotId ?? 'Не назначен'}</strong>
        </div>
      </div>

      <div className="bot-execution-panel__explanations">
        {plan.reasons.map((reason) => (
          <p key={reason} className="bot-execution-panel__reason">
            {reason}
          </p>
        ))}
        {plan.warnings.map((warning) => (
          <p key={warning} className="bot-execution-panel__warning">
            {warning}
          </p>
        ))}
      </div>

      <div className="bot-execution-panel__bots">
        {plan.assignedBots.map((bot) => {
          const canMakePrimary =
            bot.role !== 'primary' &&
            bot.membershipStatus === 'active' &&
            bot.lifecycleState !== 'disabled' &&
            bot.lifecycleState !== 'dormant';
          const assistEnabled = bot.capabilities.length > 0;
          const canToggleAssist =
            bot.role !== 'primary' &&
            bot.membershipStatus === 'active' &&
            bot.lifecycleState !== 'disabled';

          return (
            <article key={bot.botId} className="bot-execution-panel__bot-card">
              <div className="bot-execution-panel__bot-main">
                <div>
                  <div className="bot-execution-panel__bot-title-row">
                    <strong>{bot.characterName ?? bot.label}</strong>
                    <span className={toneClassForBot(bot)}>
                      {bot.role === 'primary' ? 'Owner' : 'Standby'}
                    </span>
                  </div>
                  <p className="bot-execution-panel__bot-meta">
                    {bot.label} · {describePersona(bot)}
                  </p>
                </div>

                <div className="bot-execution-panel__bot-actions">
                  {canMakePrimary ? (
                    <button
                      type="button"
                      className="button button--accent"
                      disabled={pendingPrimaryBotId === bot.botId}
                      onClick={() => onMakePrimary(bot.botId)}
                    >
                      {pendingPrimaryBotId === bot.botId ? 'Переключаю…' : 'Сделать owner'}
                    </button>
                  ) : null}
                  {canToggleAssist ? (
                    <button
                      type="button"
                      className="button button--ghost"
                      disabled={pendingAssistBotId === bot.botId}
                      onClick={() => onToggleAssist(bot.botId, !assistEnabled)}
                    >
                      {pendingAssistBotId === bot.botId
                        ? 'Обновляю…'
                        : assistEnabled
                          ? 'Выключить assist'
                          : 'Включить assist'}
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="bot-execution-panel__chip-row">
                <span className="chip">{bot.membershipStatus === 'removed' ? 'Removed' : 'Active'}</span>
                <span className="chip">{bot.lifecycleState}</span>
                {bot.permissionsSummary?.isOwner ? (
                  <span className="chip chip--success">Owner rights</span>
                ) : bot.permissionsSummary?.isAdmin ? (
                  <span className="chip chip--success">Admin rights</span>
                ) : (
                  <span className="chip chip--warning">Права не подтверждены</span>
                )}
              </div>

              {bot.capabilities.length > 0 ? (
                <div className="bot-execution-panel__chip-row">
                  {bot.capabilities.map((capability) => (
                    <span key={capability} className="chip chip--success">
                      {CAPABILITY_LABELS[capability]}
                    </span>
                  ))}
                </div>
              ) : null}

              {bot.permissionsSummary?.permissions?.length ? (
                <p className="bot-execution-panel__permissions">
                  Permissions: {bot.permissionsSummary.permissions.join(', ')}
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
