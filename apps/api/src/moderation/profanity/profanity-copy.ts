import type { ProfanitySensitivity } from '@maxim/contracts';

export function resolvePublishedProfanityRuleText(
  sensitivity: ProfanitySensitivity,
): string {
  if (sensitivity === 'CORE_ONLY') {
    return 'Пожалуйста, без мата.';
  }
  if (sensitivity === 'STRICT') {
    return 'Пожалуйста, без мата, грубой лексики и оскорблений.';
  }
  return 'Пожалуйста, без мата и грубой лексики.';
}
