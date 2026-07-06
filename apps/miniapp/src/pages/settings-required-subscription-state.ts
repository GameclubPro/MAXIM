import type { ChatSummary, ManagedEntityHeader } from '@maxim/contracts';
import {
  chatSummaryToManagedEntityHeader,
  normalizeManagedEntityLink,
} from '../lib/managed-entity-header';

export type RequiredSubscriptionSelectedChannel = {
  id: string;
  title: string;
  link: string;
  entityType: 'chat' | 'channel';
  avatarUrl: string | null;
  participantsCount: number | null;
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
  selectedHeaders: ManagedEntityHeader[];
  selectedUnavailableChannels: RequiredSubscriptionUnavailableChannel[];
  unavailableManagedChannels: RequiredSubscriptionUnavailableChannel[];
  availableChoices: ManagedEntityHeader[];
};

function normalizeLink(link: string | null | undefined): string | null {
  return normalizeManagedEntityLink(link);
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

    const header = chatSummaryToManagedEntityHeader(channel);
    availableChoiceById.set(channel.id, header);
    selectedChannelById.set(channel.id, header);
  }

  for (const channel of params.managedChannels ?? []) {
    if (channel.entityType !== 'channel') {
      continue;
    }

    const header = chatSummaryToManagedEntityHeader(channel);
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
  const selectedHeaders: ManagedEntityHeader[] = [];
  const selectedUnavailableChannels: RequiredSubscriptionUnavailableChannel[] = [];
  for (const channelId of params.selectedChannelIds ?? []) {
    const availableChannel = selectedChannelById.get(channelId);
    if (availableChannel) {
      selectedHeaders.push(availableChannel);
      selectedChannels.push({
        id: availableChannel.id,
        title: availableChannel.title,
        link: normalizeLink(availableChannel.link) ?? '',
        entityType: availableChannel.entityType,
        avatarUrl: availableChannel.avatarUrl ?? null,
        participantsCount: availableChannel.participantsCount ?? null,
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
    selectedHeaders,
    selectedUnavailableChannels,
    unavailableManagedChannels,
    availableChoices,
  };
}
