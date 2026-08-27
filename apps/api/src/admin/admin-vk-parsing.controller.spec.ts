import { MINIAPP_PROFILES_METADATA } from '../auth/miniapp-profile';
import { AdminVkParsingController } from './admin-vk-parsing.controller';

describe('AdminVkParsingController profile boundary', () => {
  it('exposes VK import only inside the Publik mini app profile', () => {
    expect(Reflect.getMetadata(MINIAPP_PROFILES_METADATA, AdminVkParsingController)).toEqual([
      'publisher',
    ]);
  });
});
