import { createHash } from 'node:crypto';
import { selectMaxMessageCandidate } from '../../max/max-message-candidate.util';

import type {
  MaxNavigationAttachmentKind,
  MaxNavigationAttachmentView,
  MaxNavigationButtonView,
  MaxNavigationContentView,
  MaxNavigationMarkupView,
  MaxNavigationMessageView,
  NavigationDiagnostic,
  NavigationEvidenceProvenance,
} from './navigation-evidence.types';

const KNOWN_NON_NAVIGATION_ATTACHMENTS = new Set([
  'audio',
  'contact',
  'file',
  'image',
  'location',
  'photo',
  'sticker',
  'video',
  'voice',
]);

type MessageCandidate = {
  path: string;
  value: Record<string, unknown>;
};

export function adaptMaxWebhookNavigationView(rawUpdate: unknown): MaxNavigationMessageView {
  const root = asRecord(rawUpdate);
  if (!root) {
    return emptyMessageView('MESSAGE_VIEW_NOT_FOUND', '$');
  }

  const candidates = collectExplicitMessageCandidates(root);
  const type = String(root.type ?? root.update_type ?? root.event_type ?? 'unknown');
  const selected = selectMaxMessageCandidate(root, type);
  if (!selected) {
    if (looksLikeMessage(root)) {
      return adaptMaxMessageNavigationView(root, '$');
    }
    return emptyMessageView('MESSAGE_VIEW_NOT_FOUND', '$');
  }

  const view = adaptMaxMessageNavigationView(selected.node, selected.path);
  if (candidates.length > 1) {
    view.diagnostics.unshift(
      diagnostic('ambiguous', 'AMBIGUOUS_MESSAGE_PATH', selected.path, null, null, null),
    );
  }
  return view;
}

export function adaptMaxMessageNavigationView(
  rawMessage: unknown,
  messagePath = 'message',
): MaxNavigationMessageView {
  const message = asRecord(rawMessage);
  if (!message) {
    return emptyMessageView('MESSAGE_VIEW_NOT_FOUND', messagePath);
  }

  const diagnostics: NavigationDiagnostic[] = [];
  const direct = adaptContent(message, messagePath, 'direct');
  const link = asRecord(message.link);
  if (!link) {
    return {
      messagePath,
      direct,
      visibleForward: null,
      replyStopped: false,
      diagnostics,
    };
  }

  const linkType = readLowerString(link.type);
  if (linkType === 'reply') {
    return {
      messagePath,
      direct,
      visibleForward: null,
      replyStopped: true,
      diagnostics,
    };
  }

  const linkedMessage = asRecord(link.message);
  const linkedBody = asRecord(link.body);
  if (linkType !== 'forward') {
    if (linkedMessage || linkedBody) {
      diagnostics.push(
        diagnostic('unknown', 'UNKNOWN_LINK_TYPE', `${messagePath}.link`, null, null, linkType),
      );
    }
    return {
      messagePath,
      direct,
      visibleForward: null,
      replyStopped: false,
      diagnostics,
    };
  }

  if (linkedMessage && linkedBody) {
    diagnostics.push(
      diagnostic(
        'ambiguous',
        'AMBIGUOUS_FORWARD_PAYLOAD',
        `${messagePath}.link`,
        'visible_forward',
        null,
        null,
      ),
    );
  }

  const forwardMessage = linkedMessage ?? linkedBody;
  const forwardPath = linkedMessage ? `${messagePath}.link.message` : `${messagePath}.link.body`;

  return {
    messagePath,
    direct,
    visibleForward: forwardMessage
      ? adaptContent(forwardMessage, forwardPath, 'visible_forward')
      : null,
    replyStopped: false,
    diagnostics,
  };
}

function collectExplicitMessageCandidates(root: Record<string, unknown>): MessageCandidate[] {
  const candidates: MessageCandidate[] = [];
  addCandidate(candidates, 'message', root.message);
  addEnvelopeMessageCandidates(candidates, 'message_created', root.message_created);
  addEnvelopeMessageCandidates(candidates, 'message_edited', root.message_edited);

  const data = asRecord(root.data);
  if (data) {
    addCandidate(candidates, 'data.message', data.message);
  }

  const event = asRecord(root.event);
  if (event) {
    addCandidate(candidates, 'event.message', event.message);
  }

  return candidates;
}

function addEnvelopeMessageCandidates(
  candidates: MessageCandidate[],
  path: 'message_created' | 'message_edited',
  value: unknown,
): void {
  const envelope = asRecord(value);
  if (!envelope) {
    return;
  }

  const nestedMessage = asRecord(envelope.message);
  if (nestedMessage) {
    addCandidate(candidates, `${path}.message`, nestedMessage);
  }

  const nestedData = asRecord(envelope.data);
  const nestedDataMessage = asRecord(nestedData?.message);
  if (nestedDataMessage) {
    addCandidate(candidates, `${path}.data.message`, nestedDataMessage);
  }

  if (!nestedMessage && !nestedDataMessage && looksLikeMessage(envelope)) {
    addCandidate(candidates, path, envelope);
  }
}

function addCandidate(candidates: MessageCandidate[], path: string, value: unknown): void {
  const record = asRecord(value);
  if (!record || candidates.some((candidate) => candidate.value === record)) {
    return;
  }
  candidates.push({ path, value: record });
}

function looksLikeMessage(value: Record<string, unknown>): boolean {
  return (
    'body' in value ||
    'content' in value ||
    'link' in value ||
    'text' in value ||
    'markup' in value ||
    'attachments' in value
  );
}

function adaptContent(
  message: Record<string, unknown>,
  messagePath: string,
  provenance: NavigationEvidenceProvenance,
): MaxNavigationContentView {
  const body = asRecord(message.body);
  const content = asRecord(message.content);
  const source = body ?? content ?? message;
  const path = body ? `${messagePath}.body` : content ? `${messagePath}.content` : messagePath;
  const text = readText(source.text) ?? readText(source.caption) ?? '';
  const markup = adaptMarkup(source, path);
  const attachments = adaptAttachments(source.attachments, `${path}.attachments`);
  const nonNavigationUrls = attachments.flatMap((attachment) =>
    attachment.kind === 'known_non_navigation' && typeof attachment.payloadUrl === 'string'
      ? [attachment.payloadUrl]
      : [],
  );
  const fingerprintInput = {
    text,
    markup: markup.map((item) => ({
      type: item.type,
      from: item.from,
      length: item.length,
      url: item.url,
      userLink: item.userLink,
      userId: item.userId,
    })),
    attachments: attachments.map((item) => ({
      kind: item.kind,
      rawType: item.rawType,
      payloadUrl: item.kind === 'share' ? item.payloadUrl : undefined,
      buttons: item.buttons.map((button) => ({
        type: button.type,
        url: button.url,
        webApp: button.webApp,
        contactId: button.contactId,
        chatTitle: button.chatTitle,
        chatDescription: button.chatDescription,
        startPayload: button.startPayload,
        uuid: button.uuid,
      })),
    })),
  };

  return {
    path,
    provenance,
    text,
    markup,
    attachments,
    nonNavigationUrls,
    contentFingerprint: createHash('sha256')
      .update('max-navigation-content:v1\0')
      .update(stableStringify(fingerprintInput))
      .digest('hex'),
  };
}

function adaptMarkup(
  source: Record<string, unknown>,
  sourcePath: string,
): MaxNavigationMarkupView[] {
  const candidates: Array<{ key: string; value: unknown }> = [
    { key: 'markup', value: source.markup },
    { key: 'text_markup', value: source.text_markup },
    { key: 'caption_markup', value: source.caption_markup },
  ];
  const selected = candidates.find((candidate) => Array.isArray(candidate.value));
  if (!selected || !Array.isArray(selected.value)) {
    return [];
  }

  return selected.value.map((value, index) => {
    const row = asRecord(value);
    return {
      path: `${sourcePath}.${selected.key}[${index}]`,
      type: readLowerString(row?.type),
      from: row?.from,
      length: row?.length,
      url: row?.url,
      userLink: row?.user_link ?? row?.userLink,
      userId: row?.user_id ?? row?.userId,
    };
  });
}

function adaptAttachments(value: unknown, sourcePath: string): MaxNavigationAttachmentView[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item, index) => {
    const path = `${sourcePath}[${index}]`;
    const row = asRecord(item);
    const rawType = readLowerString(row?.type);
    const kind = resolveAttachmentKind(rawType);
    const payload = asRecord(row?.payload);
    return {
      path,
      kind,
      rawType,
      payloadUrl: kind === 'share' || kind === 'known_non_navigation' ? payload?.url : undefined,
      buttons:
        kind === 'inline_keyboard' ? adaptButtons(payload?.buttons, `${path}.payload.buttons`) : [],
    };
  });
}

function resolveAttachmentKind(rawType: string | null): MaxNavigationAttachmentKind {
  if (rawType === 'share') {
    return 'share';
  }
  if (rawType === 'inline_keyboard') {
    return 'inline_keyboard';
  }
  if (rawType && KNOWN_NON_NAVIGATION_ATTACHMENTS.has(rawType)) {
    return 'known_non_navigation';
  }
  return 'unknown';
}

function adaptButtons(value: unknown, sourcePath: string): MaxNavigationButtonView[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const buttons: MaxNavigationButtonView[] = [];
  value.forEach((rowValue, rowIndex) => {
    if (!Array.isArray(rowValue)) {
      return;
    }
    rowValue.forEach((buttonValue, columnIndex) => {
      const button = asRecord(buttonValue);
      buttons.push({
        path: `${sourcePath}[${rowIndex}][${columnIndex}]`,
        type: readLowerString(button?.type),
        url: button?.url,
        webApp: button?.web_app ?? button?.webApp,
        contactId: button?.contact_id ?? button?.contactId,
        chatTitle: button?.chat_title ?? button?.chatTitle,
        chatDescription: button?.chat_description ?? button?.chatDescription,
        startPayload: button?.start_payload ?? button?.startPayload,
        uuid: button?.uuid,
      });
    });
  });
  return buttons;
}

function stableStringify(value: unknown): string {
  if (typeof value === 'undefined') {
    return '"[undefined]"';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function emptyMessageView(
  code: 'MESSAGE_VIEW_NOT_FOUND',
  sourcePath: string,
): MaxNavigationMessageView {
  return {
    messagePath: null,
    direct: null,
    visibleForward: null,
    replyStopped: false,
    diagnostics: [diagnostic('unknown', code, sourcePath, null, null, null)],
  };
}

function diagnostic(
  category: NavigationDiagnostic['category'],
  code: NavigationDiagnostic['code'],
  sourcePath: string,
  provenance: NavigationDiagnostic['provenance'],
  contentFingerprint: string | null,
  rawType: string | null,
): NavigationDiagnostic {
  return { category, code, sourcePath, provenance, contentFingerprint, rawType };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readLowerString(value: unknown): string | null {
  const normalized = readString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
