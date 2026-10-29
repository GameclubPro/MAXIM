import { openMaxBotLink } from './max-bridge';

/** A bridge call does not acknowledge launch; keep Major open for retry and return. */
export function openKaravanStorefront(url: string): boolean {
  try {
    const target = new URL(url);
    if (
      target.origin !== 'https://max.ru' ||
      target.username ||
      target.password ||
      !/^\/[A-Za-z0-9_]{3,64}\/?$/u.test(target.pathname)
    )
      return false;
    return openMaxBotLink(target.href) !== 'noop';
  } catch {
    return false;
  }
}
