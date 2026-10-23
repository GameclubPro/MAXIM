import { useEffect, useState } from 'react';

type SettingsOverviewFilterOptions = {
  query: string;
  containerId: string;
  entrySelector: string;
  groupSelector?: string;
};

function normalizeSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
}

function readEntrySearchText(entry: HTMLElement): string {
  const title = entry.querySelector<HTMLElement>(
    '.settings-section__title, .settings-speech-style-card__title',
  );
  const nestedSearchText = Array.from(
    entry.querySelectorAll<HTMLElement>('[data-settings-search]'),
    (element) => element.dataset.settingsSearch,
  );
  return normalizeSearchValue(
    [
      entry.dataset.settingsSearch,
      ...nestedSearchText,
      entry.getAttribute('aria-label'),
      title?.textContent,
      entry.textContent,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

export function useSettingsOverviewFilter({
  query,
  containerId,
  entrySelector,
  groupSelector,
}: SettingsOverviewFilterOptions): number {
  const [matchCount, setMatchCount] = useState(0);

  useEffect(() => {
    const container = document.getElementById(containerId);
    if (!container) {
      return undefined;
    }

    const applyFilter = () => {
      const normalizedQuery = normalizeSearchValue(query);
      const entries = Array.from(container.querySelectorAll<HTMLElement>(entrySelector));
      const matchedOrders: number[] = [];
      let nextMatchCount = 0;

      for (const entry of entries) {
        const matches = !normalizedQuery || readEntrySearchText(entry).includes(normalizedQuery);
        entry.hidden = !matches;
        if (matches) {
          nextMatchCount += 1;
          matchedOrders.push(Number.parseInt(entry.style.order || '0', 10) || 0);
        }
      }

      if (groupSelector) {
        const readGroupOrder = (group: HTMLElement) =>
          Number.parseInt(
            group.style.order || group.style.getPropertyValue('--settings-group-order') || '0',
            10,
          ) || 0;
        const groups = Array.from(container.querySelectorAll<HTMLElement>(groupSelector)).sort(
          (left, right) => readGroupOrder(left) - readGroupOrder(right),
        );
        for (const [index, group] of groups.entries()) {
          const groupOrder = readGroupOrder(group);
          const nextGroup = groups[index + 1];
          const nextGroupOrder = nextGroup ? readGroupOrder(nextGroup) : Number.POSITIVE_INFINITY;
          group.hidden = !matchedOrders.some(
            (entryOrder) => entryOrder >= groupOrder && entryOrder < nextGroupOrder,
          );
        }
      }

      for (const group of container.querySelectorAll<HTMLElement>('.settings-overview-group')) {
        group.hidden = !Array.from(group.querySelectorAll<HTMLElement>(entrySelector)).some(
          (entry) => !entry.hidden,
        );
      }

      setMatchCount((current) => (current === nextMatchCount ? current : nextMatchCount));
    };

    applyFilter();
    const observer = new MutationObserver(applyFilter);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [containerId, entrySelector, groupSelector, query]);

  return matchCount;
}
