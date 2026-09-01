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

  it('passes Publisher profile to channel comments and their mutations', () => {
    const dialogService = {
      getChannelDialog: jest.fn().mockReturnValue({ ok: true }),
      createChannelDialogMessage: jest.fn().mockReturnValue({ ok: true }),
      toggleChannelDialogReaction: jest.fn().mockReturnValue({ ok: true }),
    };
    const controller = new AdminDialogController(dialogService as never);

    controller.getChannelDialog('channel-1', 'comments', user, 'token-1', 'publisher');
    controller.createChannelDialogMessage(
      'channel-1',
      'comments',
      user,
      { token: 'token-1', text: 'Комментарий' },
      'publisher',
    );
    controller.toggleChannelDialogReaction(
      'channel-1',
      'comments',
      'comment-1',
      user,
      { token: 'token-1', emoji: 'like' },
      'publisher',
    );

    expect(dialogService.getChannelDialog).toHaveBeenCalledWith(
      'channel-1',
      user,
      'comments',
      'token-1',
      'publisher',
    );
    expect(dialogService.createChannelDialogMessage).toHaveBeenCalledWith(
      'channel-1',
      user,
      'comments',
      { token: 'token-1', text: 'Комментарий' },
      'publisher',
    );
    expect(dialogService.toggleChannelDialogReaction).toHaveBeenCalledWith(
      'channel-1',
      user,
      'comments',
      'comment-1',
      { token: 'token-1', emoji: 'like' },
      'publisher',
    );
  });

  it('rejects unsupported Publisher channel and chat dialog routes', () => {
    const controller = new AdminDialogController({} as never);

    expect(() =>
      controller.getChannelDialog('channel-1', 'rules', user, 'token-1', 'publisher'),
    ).toThrow(MiniappProfileForbiddenException);
    expect(() =>
      controller.getChatDialog('chat-1', 'suggest', user, 'token-1', 'publisher'),
    ).toThrow(MiniappProfileForbiddenException);
  });
});
