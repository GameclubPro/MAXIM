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
    '.settings-section__toggle-main h3, .settings-speech-style-card__title',
  );
  return normalizeSearchValue(
    [entry.dataset.settingsSearch, entry.getAttribute('aria-label'), title?.textContent]
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
        const groups = Array.from(container.querySelectorAll<HTMLElement>(groupSelector)).sort(
          (left, right) =>
            (Number.parseInt(left.style.order || '0', 10) || 0) -
            (Number.parseInt(right.style.order || '0', 10) || 0),
        );
        for (const [index, group] of groups.entries()) {
          const groupOrder = Number.parseInt(group.style.order || '0', 10) || 0;
          const nextGroup = groups[index + 1];
          const nextGroupOrder = nextGroup
            ? Number.parseInt(nextGroup.style.order || '0', 10) || Number.POSITIVE_INFINITY
            : Number.POSITIVE_INFINITY;
          group.hidden = !matchedOrders.some(
            (entryOrder) => entryOrder >= groupOrder && entryOrder < nextGroupOrder,
          );
        }
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
