import {
  managedGiveawayParticipantStateSchema,
  managedGiveawayPublicSchema,
  type ManagedGiveawayParticipantState,
  type ManagedGiveawayPublic,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

export async function getPublicGiveaway(
  api: ApiTransport,
  giveawayId: string,
): Promise<ManagedGiveawayPublic> {
  const response = await api.request(`/giveaways/${giveawayId}`);
  return managedGiveawayPublicSchema.parse(response);
}

export async function getGiveawayParticipantState(
  api: ApiTransport,
  giveawayId: string,
): Promise<ManagedGiveawayParticipantState> {
  const response = await api.request(`/giveaways/${giveawayId}/me`);
  return managedGiveawayParticipantStateSchema.parse(response);
}

export async function enterGiveaway(
  api: ApiTransport,
  giveawayId: string,
): Promise<ManagedGiveawayParticipantState> {
  const response = await api.request(`/giveaways/${giveawayId}/enter`, {
    method: 'POST',
  });
  return managedGiveawayParticipantStateSchema.parse(response);
}

export async function claimGiveaway(api: ApiTransport, giveawayId: string): Promise<void> {
  await api.request(`/giveaways/${giveawayId}/claim`, {
    method: 'POST',
  });
}
