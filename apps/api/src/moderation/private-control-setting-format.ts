import { compactPrivateText } from './private-control-launcher-renderer';
import type { SettingFieldType } from './private-control.types';

export function formatPrivateControlTime(minutes: number): string {
  const normalized = Math.max(0, Math.min(1439, Math.trunc(minutes)));
  const hours = Math.floor(normalized / 60)
    .toString()
    .padStart(2, '0');
  const mins = (normalized % 60).toString().padStart(2, '0');
  return `${hours}:${mins}`;
}

export function formatPrivateControlSettingValue(value: unknown, type: SettingFieldType): string {
  if (type === 'boolean') {
    return value ? 'Включено' : 'Выключено';
  }

  if (type === 'time' && typeof value === 'number') {
    return formatPrivateControlTime(value);
  }

  if (type === 'enum' && typeof value === 'string') {
    return formatPrivateControlEnumValue(value);
  }

  if (value === null || value === undefined) {
    return '—';
  }

  if (typeof value === 'string') {
    return value.trim() ? compactPrivateText(value, 64) : '—';
  }

  return String(value);
}

export function formatPrivateControlEnumValue(value: string): string {
  if (value === 'MESSAGE') return 'Сообщение целиком';
  if (value === 'TEXT') return 'Текст и подпись';
  if (value === 'ALLOWLIST_ONLY') {
    return 'Разрешать только цели из списка разрешённых';
  }
  if (value === 'BLOCKLIST_ONLY') {
    return 'Удалять все кликабельные ссылки';
  }
  if (value === 'ALERT_ONLY') {
    return 'Только предупреждать';
  }
  if (value === 'CORE_ONLY') {
    return 'Только мат';
  }
  if (value === 'BALANCED') {
    return 'Сбалансированный';
  }
  if (value === 'STRICT') {
    return 'Строгий';
  }
  if (value === 'SAME_IMAGE') {
    return 'Та же картинка';
  }
  if (value === 'MINOR_EDITS') {
    return 'С небольшими изменениями';
  }
  if (value === 'SAME_AUTHOR') {
    return 'У одного автора';
  }
  if (value === 'CHAT') {
    return 'Во всём чате';
  }
  return value;
}
