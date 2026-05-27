import {
  PRIVACY_POLICY_URL,
  USER_AGREEMENT_URL,
  buildPrivacyPolicyUrl,
  buildUserAgreementShortNotice,
  buildUserAgreementStartNotice,
  buildUserAgreementUrl,
} from './user-agreement-notice';

describe('user agreement notice', () => {
  it('uses public mini app legal documents by default', () => {
    expect(USER_AGREEMENT_URL).toBe('https://maxim.play-team.ru/app/legal/agreement');
    expect(PRIVACY_POLICY_URL).toBe('https://maxim.play-team.ru/app/legal/privacy');
  });

  it('builds legal links from APP_BASE_URL for prefixed deployments', () => {
    const appBaseUrl = 'https://maxim.play-team.ru/custom/';

    expect(buildUserAgreementUrl(appBaseUrl)).toBe(
      'https://maxim.play-team.ru/custom/app/legal/agreement',
    );
    expect(buildPrivacyPolicyUrl(appBaseUrl)).toBe(
      'https://maxim.play-team.ru/custom/app/legal/privacy',
    );
  });

  it('renders start and menu notices with both legal documents', () => {
    expect(buildUserAgreementStartNotice('https://example.test')).toContain(
      '[пользовательское соглашение](https://example.test/app/legal/agreement)',
    );
    expect(buildUserAgreementStartNotice('https://example.test')).toContain(
      '[политику обработки данных](https://example.test/app/legal/privacy)',
    );
    expect(buildUserAgreementShortNotice('https://example.test')).toContain('Документы:');
  });
});
