export type RequiredSubscriptionHeroProps = {
  maxChannels: number;
  muteDays: number;
  muteEnabled: boolean;
  selectedCount: number;
  stagesEnabledCount: number;
};

function formatDayLabel(value: number): string {
  const safeValue = Math.max(1, Math.trunc(value));
  const mod10 = safeValue % 10;
  const mod100 = safeValue % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return `${safeValue} день`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${safeValue} дня`;
  }
  return `${safeValue} дней`;
}

export default function RequiredSubscriptionHero({
  maxChannels,
  muteDays,
  muteEnabled,
  selectedCount,
  stagesEnabledCount,
}: RequiredSubscriptionHeroProps) {
  return (
    <div className="required-subscription__hero">
      <div className="required-subscription__hero-copy">
        <span className="required-subscription__eyebrow">Подписка • Mobile 2026</span>
        <strong>Проверка подписки до первого сообщения</strong>
        <p>Каналы, объяснение и санкции собраны в один короткий мобильный поток.</p>
      </div>

      <div className="required-subscription__hero-metrics" aria-hidden="true">
        <div className="required-subscription__metric">
          <span>Выбор</span>
          <strong>
            {selectedCount}/{maxChannels}
          </strong>
          <small>каналы и ссылки</small>
        </div>
        <div className="required-subscription__metric">
          <span>Ступени</span>
          <strong>{stagesEnabledCount}/4</strong>
          <small>объяснение, мут, бан</small>
        </div>
        <div className="required-subscription__metric required-subscription__metric--duration">
          <span>Мут</span>
          <strong>{muteEnabled ? formatDayLabel(muteDays) : 'Не включён'}</strong>
          <small>{muteEnabled ? 'срок ограничения' : 'включается позже'}</small>
        </div>
      </div>
    </div>
  );
}
