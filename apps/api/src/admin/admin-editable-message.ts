import { isMaxMessageMissingError } from './admin-chat-rules';

export function shouldRecreateEditableMessage(error: unknown): boolean {
  if (isMaxMessageMissingError(error)) {
    return true;
  }

  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status !== 400 && status !== 403) {
    return false;
  }

  const responseData = (error as { response?: { data?: unknown } })?.response?.data;
  const normalized = JSON.stringify(responseData ?? '').toLowerCase();
  return (
    normalized.includes('edit') ||
    normalized.includes('update') ||
    normalized.includes('too old') ||
    normalized.includes('24') ||
    normalized.includes("can't be edited") ||
    normalized.includes('cannot edit') ||
    normalized.includes('cant edit') ||
    normalized.includes('message.not.updated')
  );
}
