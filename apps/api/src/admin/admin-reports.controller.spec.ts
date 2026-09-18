import { AdminReportsController } from './admin-reports.controller';

describe('report journal access', () => {
  const actor = { userId: 'admin' } as never;
  it.each(['list', 'detail', 'dismiss'] as const)(
    'requires chat-admin authorization for %s',
    async (operation) => {
      const access = { assertChatAdminAccess: jest.fn().mockRejectedValue(new Error('forbidden')) };
      const reports = { list: jest.fn(), detail: jest.fn(), dismiss: jest.fn() };
      const controller = new AdminReportsController(access as never, reports as never);
      const result =
        operation === 'list'
          ? controller.list('chat', actor)
          : controller[operation]('chat', 'case', actor);
      await expect(result).rejects.toThrow('forbidden');
      expect(reports[operation]).not.toHaveBeenCalled();
    },
  );
  it('keeps the authenticated actor on dismiss', async () => {
    const access = { assertChatAdminAccess: jest.fn() };
    const reports = { dismiss: jest.fn().mockResolvedValue({ id: 'case' }) };
    await new AdminReportsController(access as never, reports as never).dismiss(
      'chat',
      'case',
      actor,
    );
    expect(reports.dismiss).toHaveBeenCalledWith('chat', 'case', 'admin');
  });
});
