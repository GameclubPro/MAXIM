import {
  claimManagedGiveawayResponseSchema,
  managedGiveawayParticipantStateSchema,
  managedGiveawayPublicSchema,
  type ClaimManagedGiveawayResponse,
  type ManagedGiveawayParticipantState,
  type ManagedGiveawayPublic,
} from '@maxim/contracts/giveaway';
import type { ApiTransport } from './transport';

export async function getPublicGiveaway(
  api: ApiTransport,
  giveawayId: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ManagedGiveawayPublic> {
  const response = await api.request(`/giveaways/${giveawayId}`, request);
  return managedGiveawayPublicSchema.parse(response);
}

export async function getGiveawayParticipantState(
  api: ApiTransport,
  giveawayId: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ManagedGiveawayParticipantState> {
  const response = await api.request(`/giveaways/${giveawayId}/me`, request);
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

export async function claimGiveaway(
  api: ApiTransport,
  giveawayId: string,
): Promise<ClaimManagedGiveawayResponse> {
  const response = await api.request(`/giveaways/${giveawayId}/claim`, {
    method: 'POST',
  });
  return claimManagedGiveawayResponseSchema.parse(response);
}
