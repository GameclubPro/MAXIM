import type { ChatSummary, ManagedEntityHeader } from '@maxim/contracts';

export type RequiredSubscriptionSelectedChannel = {
  id: string;
  title: string;
  link: string;
};

export type RequiredSubscriptionUnavailableChannelReason = 'missing_link' | 'unavailable';

export type RequiredSubscriptionUnavailableChannel = {
  id: string;
  title: string;
  reason: RequiredSubscriptionUnavailableChannelReason;
  description: string;
};

export type RequiredSubscriptionChannelCollections = {
  selectedChannels: RequiredSubscriptionSelectedChannel[];
  selectedUnavailableChannels: RequiredSubscriptionUnavailableChannel[];
  unavailableManagedChannels: RequiredSubscriptionUnavailableChannel[];
  availableChoices: ManagedEntityHeader[];
};

function normalizeLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string') {
    return null;
  }

  const normalized = link.trim();
  return normalized.length > 0 ? normalized : null;
}

function toManagedEntityHeader(channel: ChatSummary): ManagedEntityHeader {
  return {
    id: channel.id,
    title: channel.title,
    entityType: 'channel',
    link: normalizeLink(channel.link),
    participantsCount: null,
    avatarUrl: channel.avatarUrl ?? null,
    primaryBotId: channel.primaryBotId ?? null,
    assignedBots: channel.assignedBots ?? [],
    sharedMode: channel.sharedMode ?? 'owned',
  };
}

function createMissingLinkChannel(channel: ChatSummary): RequiredSubscriptionUnavailableChannel {
  return {
    id: channel.id,
    title: channel.title,
    reason: 'missing_link',
    description: 'Нужна публичная ссылка для проверки подписки.',
  };
}

function createUnavailableChannel(channelId: string): RequiredSubscriptionUnavailableChannel {
  return {
    id: channelId,
    title: channelId,
    reason: 'unavailable',
    description: 'Обновите список и проверьте права.',
  };
}

export function buildRequiredSubscriptionChannelCollections(params: {
  managedChannels: readonly ChatSummary[] | null | undefined;
  resolvedChannels: readonly ManagedEntityHeader[];
  selectedChannelIds: readonly string[] | null | undefined;
}): RequiredSubscriptionChannelCollections {
  const availableChannelById = new Map<string, ManagedEntityHeader>();
  const unavailableManagedChannelById = new Map<string, RequiredSubscriptionUnavailableChannel>();
  const selectedIds = new Set(params.selectedChannelIds ?? []);

  for (const channel of params.managedChannels ?? []) {
    if (channel.entityType !== 'channel') {
      continue;
    }

    const normalizedLink = normalizeLink(channel.link);
    if (!normalizedLink) {
      unavailableManagedChannelById.set(channel.id, createMissingLinkChannel(channel));
      continue;
    }

    const header = toManagedEntityHeader({
      ...channel,
      link: normalizedLink,
    });
    availableChannelById.set(channel.id, header);
  }

  for (const channel of params.resolvedChannels) {
    const existingChannel = availableChannelById.get(channel.id);
    if (!existingChannel || !normalizeLink(existingChannel.link)) {
      availableChannelById.set(channel.id, {
        ...channel,
        link: normalizeLink(channel.link),
      });
    }
    unavailableManagedChannelById.delete(channel.id);
  }

  const selectedChannels: RequiredSubscriptionSelectedChannel[] = [];
  const selectedUnavailableChannels: RequiredSubscriptionUnavailableChannel[] = [];
  for (const channelId of params.selectedChannelIds ?? []) {
    const availableChannel = availableChannelById.get(channelId);
    if (availableChannel) {
      selectedChannels.push({
        id: availableChannel.id,
        title: availableChannel.title,
        link: normalizeLink(availableChannel.link) ?? '',
      });
      continue;
    }

    selectedUnavailableChannels.push(
      unavailableManagedChannelById.get(channelId) ?? createUnavailableChannel(channelId),
    );
  }

  const unavailableManagedChannels = [...unavailableManagedChannelById.values()].filter(
    (channel) => !selectedIds.has(channel.id),
  );
  const availableChoices = [...availableChannelById.values()].filter(
    (channel) => !selectedIds.has(channel.id),
  );

  return {
    selectedChannels,
    selectedUnavailableChannels,
    unavailableManagedChannels,
    availableChoices,
  };
}
