import { AdminReportsService } from './admin-reports.service';

describe('admin report participant profiles', () => {
  function fixture() {
    const detail = {
      id: 'case',
      authorId: 'author',
      authorName: null,
      reporters: [{ userId: 'reporter', displayName: null, createdAt: new Date().toISOString() }],
    };
    const reports = {
      list: jest.fn().mockResolvedValue({ items: [] }),
      detail: jest.fn().mockResolvedValue(detail),
      dismiss: jest.fn().mockResolvedValue({ ...detail, status: 'DISMISSED' }),
    };
    const profiles = {
      resolveChatUserProfiles: jest.fn().mockResolvedValue(
        new Map([
          [
            'author',
            {
              displayName: 'Александр Соколов',
              profileUrl: 'https://max.ru/alexander',
              profileHandoffUrl: 'https://max.ru/test_bot?start=pm2_author',
            },
          ],
          [
            'reporter',
            {
              displayName: 'Мария Волкова',
              profileUrl: null,
              profileHandoffUrl: 'https://max.ru/test_bot?start=pm2_reporter',
            },
          ],
        ]),
      ),
    };
    return {
      detail,
      reports,
      profiles,
      service: new AdminReportsService(reports as never, profiles as never),
    };
  }
  it('loads profiles in one batch only when the authorized case is opened', async () => {
    const { service, profiles } = fixture();
    await service.list('chat');
    expect(profiles.resolveChatUserProfiles).not.toHaveBeenCalled();
    expect(await service.detail('chat', 'case')).toMatchObject({
      authorName: 'Александр Соколов',
      authorProfileUrl: 'https://max.ru/alexander',
      reporters: [
        {
          userId: 'reporter',
          displayName: 'Мария Волкова',
          profileHandoffUrl: 'https://max.ru/test_bot?start=pm2_reporter',
        },
      ],
    });
    expect(profiles.resolveChatUserProfiles).toHaveBeenCalledWith('chat', ['author', 'reporter']);
  });
  it('does not resolve identities when the report is not found in the requested chat', async () => {
    const { service, reports, profiles } = fixture();
    reports.detail.mockRejectedValueOnce(new Error('not found'));
    await expect(service.detail('other-chat', 'case')).rejects.toThrow('not found');
    expect(profiles.resolveChatUserProfiles).not.toHaveBeenCalled();
  });
  it('does not hide a committed dismissal when profile enrichment fails', async () => {
    const { service, profiles, reports } = fixture();
    profiles.resolveChatUserProfiles.mockRejectedValueOnce(new Error('lookup unavailable'));
    await expect(service.dismiss('chat', 'case', 'admin')).resolves.toMatchObject({
      status: 'DISMISSED',
    });
    expect(reports.dismiss).toHaveBeenCalledWith('chat', 'case', 'admin');
  });
});
