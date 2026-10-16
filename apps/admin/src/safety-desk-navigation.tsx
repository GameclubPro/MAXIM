import type { DeskView } from './safety-desk-model';

const sections = [
  ['review', 'Публикации'],
  ['support', 'Обращения'],
  ['deletes', 'Удаления'],
  ['commercial', 'Коммерческий фильтр'],
  ['retention', 'Очистка'],
  ['observations', 'Наблюдения'],
] as const satisfies ReadonlyArray<readonly [DeskView, string]>;

export function SafetyDeskNavigation({
  view,
  disabled,
  onSelect,
}: {
  view: DeskView;
  disabled: boolean;
  onSelect: (view: DeskView) => void;
}) {
  return (
    <div className="view-switch" aria-label="Раздел">
      {sections.map(([section, label]) => (
        <button
          key={section}
          className={view === section ? 'is-active' : ''}
          type="button"
          aria-pressed={view === section}
          disabled={disabled}
          onClick={() => onSelect(section)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
