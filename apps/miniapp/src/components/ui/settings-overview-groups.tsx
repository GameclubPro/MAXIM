import { Children, isValidElement, type CSSProperties, type ReactNode } from 'react';

type SettingsOverviewEntryProps = {
  order: number;
  children: ReactNode;
};

type SettingsOverviewGroup = {
  order: number;
  title?: string;
};

export const CHAT_SETTINGS_OVERVIEW_GROUPS = [
  { order: 0 },
  { order: 10, title: 'Защита' },
  { order: 20, title: 'Контент' },
] as const satisfies readonly SettingsOverviewGroup[];

const SINGLE_GROUP = [{ order: 0 }] as const;

export function SettingsOverviewEntry({ children }: SettingsOverviewEntryProps) {
  return <>{children}</>;
}

export function SettingsOverviewGroups({
  children,
  groups = SINGLE_GROUP,
}: {
  children: ReactNode;
  groups?: readonly SettingsOverviewGroup[];
}) {
  const entries = Children.toArray(children);
  const readOrder = (entry: ReactNode) =>
    isValidElement<SettingsOverviewEntryProps>(entry) && entry.type === SettingsOverviewEntry
      ? entry.props.order
      : 0;

  return groups.map((group, index) => {
    const nextOrder = groups[index + 1]?.order ?? Number.POSITIVE_INFINITY;
    const groupEntries = entries
      .filter((entry) => readOrder(entry) >= group.order && readOrder(entry) < nextOrder)
      .sort((left, right) => readOrder(left) - readOrder(right));

    return (
      <div className="settings-overview-group" key={group.order}>
        {group.title ? (
          <div
            className="settings-home-group-head stagger-in"
            style={{ '--settings-group-order': group.order } as CSSProperties}
          >
            <h2 className="settings-home-group-head__title">{group.title}</h2>
          </div>
        ) : null}
        <div className="settings-overview-group__entries">{groupEntries}</div>
      </div>
    );
  });
}
