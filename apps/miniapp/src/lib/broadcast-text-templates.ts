export type BroadcastTextTemplate = {
  id: string;
  label: string;
  text: string;
  createdAt: string;
  updatedAt: string;
};

const BROADCAST_TEXT_TEMPLATES_VERSION = 1;
const BROADCAST_TEXT_TEMPLATES_LIMIT = 12;
const BROADCAST_TEXT_TEMPLATE_TEXT_LIMIT = 2_000;

function buildStorageKey(scope: string): string {
  const normalizedScope = scope.trim() || 'default';
  return `maxim:broadcast-text-templates:v${BROADCAST_TEXT_TEMPLATES_VERSION}:${normalizedScope}`;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalizeTemplateText(value: string): string {
  return value.trim().slice(0, BROADCAST_TEXT_TEMPLATE_TEXT_LIMIT);
}

function buildTemplateLabel(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/u)
      .map((line) => line.replace(/[*_`>#-]+/gu, ' ').trim())
      .find(Boolean) ?? 'Шаблон';
  return firstLine.length > 28 ? `${firstLine.slice(0, 27).trim()}...` : firstLine;
}

function sanitizeTemplate(value: unknown): BroadcastTextTemplate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const text = typeof record.text === 'string' ? normalizeTemplateText(record.text) : '';
  if (!id || !text) {
    return null;
  }

  const now = new Date().toISOString();
  return {
    id,
    label:
      typeof record.label === 'string' && record.label.trim()
        ? record.label.trim().slice(0, 32)
        : buildTemplateLabel(text),
    text,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now,
  };
}

export function readBroadcastTextTemplates(scope: string): BroadcastTextTemplate[] {
  if (!canUseStorage()) {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(buildStorageKey(scope));
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(sanitizeTemplate)
      .filter((template): template is BroadcastTextTemplate => template !== null)
      .slice(0, BROADCAST_TEXT_TEMPLATES_LIMIT);
  } catch {
    return [];
  }
}

export function saveBroadcastTextTemplates(
  scope: string,
  templates: readonly BroadcastTextTemplate[],
): void {
  if (!canUseStorage()) {
    return;
  }

  const sanitized = templates
    .map(sanitizeTemplate)
    .filter((template): template is BroadcastTextTemplate => template !== null)
    .slice(0, BROADCAST_TEXT_TEMPLATES_LIMIT);

  try {
    window.localStorage.setItem(buildStorageKey(scope), JSON.stringify(sanitized));
  } catch {
    // Ignore unavailable local storage.
  }
}

export function createBroadcastTextTemplate(
  scope: string,
  text: string,
): { templates: BroadcastTextTemplate[]; template: BroadcastTextTemplate | null } {
  const normalizedText = normalizeTemplateText(text);
  if (!normalizedText) {
    return { templates: readBroadcastTextTemplates(scope), template: null };
  }

  const existingTemplates = readBroadcastTextTemplates(scope);
  const now = new Date().toISOString();
  const duplicate = existingTemplates.find((template) => template.text === normalizedText);
  const template: BroadcastTextTemplate = duplicate
    ? {
        ...duplicate,
        updatedAt: now,
      }
    : {
        id: `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        label: buildTemplateLabel(normalizedText),
        text: normalizedText,
        createdAt: now,
        updatedAt: now,
      };
  const nextTemplates = [
    template,
    ...existingTemplates.filter((item) => item.id !== template.id),
  ].slice(0, BROADCAST_TEXT_TEMPLATES_LIMIT);
  saveBroadcastTextTemplates(scope, nextTemplates);
  return { templates: nextTemplates, template };
}

export function deleteBroadcastTextTemplate(
  scope: string,
  templateId: string,
): BroadcastTextTemplate[] {
  const nextTemplates = readBroadcastTextTemplates(scope).filter(
    (template) => template.id !== templateId,
  );
  saveBroadcastTextTemplates(scope, nextTemplates);
  return nextTemplates;
}
