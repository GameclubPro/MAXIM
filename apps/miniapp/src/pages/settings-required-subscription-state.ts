import type { ChatSummary, ManagedEntityHeader } from '@maxim/contracts';

export type RequiredSubscriptionSelectedChannel = {
  id: string;
  title: string;
  link: string;
  entityType: 'chat' | 'channel';
};

export type RequiredSubscriptionUnavailableChannelReason = 'unavailable';

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
    entityType: channel.entityType,
    link: normalizeLink(channel.link),
    participantsCount: null,
    avatarUrl: channel.avatarUrl ?? null,
    primaryBotId: channel.primaryBotId ?? null,
    assignedBots: channel.assignedBots ?? [],
    sharedMode: channel.sharedMode ?? 'owned',
    accessDiagnostics: {
      state: 'ok',
      lastDetectedAt: null,
      lostBots: [],
    },
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
  managedChats: readonly ChatSummary[] | null | undefined;
  managedChannels: readonly ChatSummary[] | null | undefined;
  resolvedChannels: readonly ManagedEntityHeader[];
  selectedChannelIds: readonly string[] | null | undefined;
}): RequiredSubscriptionChannelCollections {
  const availableChoiceById = new Map<string, ManagedEntityHeader>();
  const selectedChannelById = new Map<string, ManagedEntityHeader>();
  const selectedIds = new Set(params.selectedChannelIds ?? []);

  for (const channel of params.managedChats ?? []) {
    if (channel.entityType !== 'chat') {
      continue;
    }

    selectedChannelById.set(channel.id, toManagedEntityHeader(channel));
  }

  for (const channel of params.managedChannels ?? []) {
    if (channel.entityType !== 'channel') {
      continue;
    }

    const header = toManagedEntityHeader(channel);
    availableChoiceById.set(channel.id, header);
    selectedChannelById.set(channel.id, header);
  }

  for (const channel of params.resolvedChannels) {
    const existingChannel = selectedChannelById.get(channel.id);
    if (!existingChannel || (!normalizeLink(existingChannel.link) && normalizeLink(channel.link))) {
      selectedChannelById.set(channel.id, {
        ...channel,
        link: normalizeLink(channel.link),
      });
    }
  }

  const selectedChannels: RequiredSubscriptionSelectedChannel[] = [];
  const selectedUnavailableChannels: RequiredSubscriptionUnavailableChannel[] = [];
  for (const channelId of params.selectedChannelIds ?? []) {
    const availableChannel = selectedChannelById.get(channelId);
    if (availableChannel) {
      selectedChannels.push({
        id: availableChannel.id,
        title: availableChannel.title,
        link: normalizeLink(availableChannel.link) ?? '',
        entityType: availableChannel.entityType,
      });
      continue;
    }

    selectedUnavailableChannels.push(createUnavailableChannel(channelId));
  }

  const unavailableManagedChannels: RequiredSubscriptionUnavailableChannel[] = [];
  const availableChoices = [...availableChoiceById.values()].filter(
    (channel) => !selectedIds.has(channel.id),
  );

  return {
    selectedChannels,
    selectedUnavailableChannels,
    unavailableManagedChannels,
    availableChoices,
  };
}
