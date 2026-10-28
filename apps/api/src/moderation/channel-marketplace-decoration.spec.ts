import {
  channelDecorationStart,
  channelSettingsForSource,
  marketplacePostIsEligible,
} from './channel-marketplace-decoration';

const settings = {
  postSignatureEnabled: false,
  quickButtonsEnabled: false,
  commentsEnabled: false,
  postSuggestionsEnabled: false,
  updatedAt: new Date('2026-10-28T10:00:00Z'),
};
const enabled = new Date('2026-10-28T09:00:00Z');

describe('independent channel decoration activation', () => {
  it('admits a marketplace-only post without enabling another decorator', () => {
    expect(channelDecorationStart(settings, enabled)).toBe(enabled.getTime());
    expect(channelDecorationStart(settings, null)).toBeNull();
    expect(marketplacePostIsEligible('2026-10-28T09:00:00Z', enabled)).toBe(true);
    expect(marketplacePostIsEligible('2026-10-28T08:59:59Z', enabled)).toBe(false);
    expect(marketplacePostIsEligible(undefined, enabled)).toBe(false);
    expect(marketplacePostIsEligible('not-a-date', enabled)).toBe(false);
  });
  it('keeps independent activation dates when an unrelated setting changes later', () => {
    const both = { ...settings, commentsEnabled: true };
    expect(channelDecorationStart(both, enabled)).toBe(enabled.getTime());
    expect(channelSettingsForSource(both, '2026-10-28T09:30:00Z')).toEqual(settings);
    expect(channelSettingsForSource(both, '2026-10-28T10:00:00Z')).toEqual(both);
    expect(marketplacePostIsEligible('2026-10-28T09:30:00Z', enabled)).toBe(true);
    expect(channelDecorationStart(both, new Date('2026-10-28T11:00:00Z'))).toBe(
      settings.updatedAt.getTime(),
    );
  });
  it('keeps legacy recovery settings without inventing a marketplace source timestamp', () => {
    const legacy = { ...settings, postSignatureEnabled: true };
    expect(channelSettingsForSource(legacy, undefined)).toBe(legacy);
    expect(marketplacePostIsEligible(undefined, enabled)).toBe(false);
  });
});
