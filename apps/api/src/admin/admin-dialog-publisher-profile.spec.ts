import { MiniappProfileForbiddenException } from '../auth/miniapp-profile.error';
import { AdminDialogController } from './admin-dialog.controller';

const user = { userId: 'user-1', username: null, displayName: null };

describe('AdminDialogController Publisher profile boundary', () => {
  it('passes Publisher profile to its channel suggestion dialog', () => {
    const dialogService = { getChannelDialog: jest.fn().mockReturnValue({ ok: true }) };
    const controller = new AdminDialogController(dialogService as never);

    controller.getChannelDialog('channel-1', 'suggest', user, 'token-1', 'publisher');

    expect(dialogService.getChannelDialog).toHaveBeenCalledWith(
      'channel-1',
      user,
      'suggest',
      'token-1',
      'publisher',
    );
  });

  it('rejects Publisher channel comments and chat suggestion routes', () => {
    const controller = new AdminDialogController({} as never);

    expect(() =>
      controller.getChannelDialog('channel-1', 'comments', user, 'token-1', 'publisher'),
    ).toThrow(MiniappProfileForbiddenException);
    expect(() =>
      controller.getChatDialog('chat-1', 'suggest', user, 'token-1', 'publisher'),
    ).toThrow(MiniappProfileForbiddenException);
  });
});
