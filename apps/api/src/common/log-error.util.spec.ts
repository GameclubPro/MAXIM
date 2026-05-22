import { sanitizeErrorForLogs } from './log-error.util';

describe('sanitizeErrorForLogs', () => {
  it('keeps Axios diagnostics without leaking authorization headers', () => {
    const error = {
      name: 'AxiosError',
      message: 'timeout of 700ms exceeded',
      code: 'ECONNABORTED',
      config: {
        method: 'get',
        url: 'https://platform-api.max.ru/chats/chat-1/members?count=100',
        timeout: 700,
        headers: {
          Authorization: 'secret-token',
        },
      },
      request: {
        _header:
          'GET /chats/chat-1/members HTTP/1.1\r\nAuthorization: secret-token\r\nHost: platform-api.max.ru\r\n',
      },
    };

    const sanitized = sanitizeErrorForLogs(error);

    expect(sanitized).toEqual({
      type: 'AxiosError',
      message: 'timeout of 700ms exceeded',
      code: 'ECONNABORTED',
      method: 'GET',
      url: 'https://platform-api.max.ru/chats/chat-1/members',
      timeout: 700,
    });
    expect(JSON.stringify(sanitized)).not.toContain('secret-token');
    expect(JSON.stringify(sanitized)).not.toContain('Authorization');
  });
});
