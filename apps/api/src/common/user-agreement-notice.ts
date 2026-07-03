const DEFAULT_APP_BASE_URL = 'https://major-maksimov.ru';

export const USER_AGREEMENT_PATH = '/app/legal/agreement';
export const PRIVACY_POLICY_PATH = '/app/legal/privacy';

export const USER_AGREEMENT_URL = `${DEFAULT_APP_BASE_URL}${USER_AGREEMENT_PATH}`;
export const PRIVACY_POLICY_URL = `${DEFAULT_APP_BASE_URL}${PRIVACY_POLICY_PATH}`;

export const USER_AGREEMENT_MARKDOWN_LINK = buildUserAgreementMarkdownLink();
export const PRIVACY_POLICY_MARKDOWN_LINK = buildPrivacyPolicyMarkdownLink();

export const USER_AGREEMENT_START_NOTICE = buildUserAgreementStartNotice();

export const USER_AGREEMENT_SHORT_NOTICE = buildUserAgreementShortNotice();

export function buildUserAgreementUrl(appBaseUrl?: string | null): string {
  return buildLegalDocumentUrl(USER_AGREEMENT_PATH, appBaseUrl);
}

export function buildPrivacyPolicyUrl(appBaseUrl?: string | null): string {
  return buildLegalDocumentUrl(PRIVACY_POLICY_PATH, appBaseUrl);
}

export function buildUserAgreementMarkdownLink(appBaseUrl?: string | null): string {
  return `[пользовательское соглашение](${buildUserAgreementUrl(appBaseUrl)})`;
}

export function buildPrivacyPolicyMarkdownLink(appBaseUrl?: string | null): string {
  return `[политику обработки данных](${buildPrivacyPolicyUrl(appBaseUrl)})`;
}

export function buildUserAgreementStartNotice(appBaseUrl?: string | null): string {
  return `Продолжая пользоваться ботом, вы принимаете ${buildUserAgreementMarkdownLink(
    appBaseUrl,
  )} и ${buildPrivacyPolicyMarkdownLink(appBaseUrl)}.`;
}

export function buildUserAgreementShortNotice(appBaseUrl?: string | null): string {
  return `Документы: ${buildUserAgreementMarkdownLink(appBaseUrl)} и ${buildPrivacyPolicyMarkdownLink(
    appBaseUrl,
  )}`;
}

function buildLegalDocumentUrl(path: string, appBaseUrl?: string | null): string {
  const baseUrl = normalizeAppBaseUrl(appBaseUrl) ?? DEFAULT_APP_BASE_URL;
  return `${baseUrl}${path}`;
}

function normalizeAppBaseUrl(value?: string | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/\/+$/u, '');
  if (!normalized || !/^https?:\/\//iu.test(normalized)) {
    return null;
  }

  return normalized;
}
