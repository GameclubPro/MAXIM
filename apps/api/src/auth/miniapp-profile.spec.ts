import { buildMiniappProfileProjection } from './miniapp-profile';

describe('mini app profile projection', () => {
  it('keeps the server route compatible while the publisher client owns its catalog home', () => {
    expect(buildMiniappProfileProjection('publisher')).toEqual({
      profile: 'publisher',
      capabilities: ['publisher_workspace', 'publisher_entities', 'chat_comments'],
      homeRoute: '/',
    });
  });

  it('keeps moderation launches on the managed entity home', () => {
    expect(buildMiniappProfileProjection('moderation')).toEqual({
      profile: 'moderation',
      capabilities: ['moderation_workspace', 'publisher_policy_write'],
      homeRoute: '/',
    });
  });
});
