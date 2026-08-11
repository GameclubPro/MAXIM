export type MaxMessageCandidate = {
  node: Record<string, unknown>;
  path: string;
  score: number;
};

export function selectMaxMessageCandidate(
  payload: Record<string, unknown>,
  type: string,
): MaxMessageCandidate | null {
  const directMessage = asRecord(payload.message);
  if (directMessage) {
    return { node: directMessage, path: 'message', score: scoreMaxMessageCandidate(directMessage) };
  }

  const envelopeKeys = [
    type,
    payload.update_type,
    payload.event_type,
    payload.type,
    'data',
    'event',
  ];
  const declaredEventEnvelopeKeys = new Set(
    [type, payload.update_type, payload.event_type, payload.type].filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    ),
  );
  for (const key of envelopeKeys) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      continue;
    }

    const envelope = asRecord(payload[key]);
    if (!envelope) {
      continue;
    }

    const nestedMessage = asRecord(envelope.message);
    if (nestedMessage) {
      return {
        node: nestedMessage,
        path: `${key}.message`,
        score: scoreMaxMessageCandidate(nestedMessage),
      };
    }

    const nestedData = asRecord(envelope.data);
    const nestedDataMessage = asRecord(nestedData?.message);
    if (nestedDataMessage) {
      return {
        node: nestedDataMessage,
        path: `${key}.data.message`,
        score: scoreMaxMessageCandidate(nestedDataMessage),
      };
    }

    if (declaredEventEnvelopeKeys.has(key) && isDirectMaxMessageEnvelope(envelope)) {
      return {
        node: envelope,
        path: key,
        score: scoreMaxMessageCandidate(envelope),
      };
    }

    const bestInEnvelope = findBestMaxMessageCandidate(envelope, key);
    if (bestInEnvelope && bestInEnvelope.score >= 4) {
      return bestInEnvelope;
    }
  }

  const bestInPayload = findBestMaxMessageCandidate(payload, '$');
  return bestInPayload && bestInPayload.score >= 4 ? bestInPayload : null;
}

export function findBestMaxMessageCandidate(
  node: unknown,
  path = '$',
  depth = 0,
): MaxMessageCandidate | null {
  if (depth > 8 || node === null || node === undefined) {
    return null;
  }

  if (Array.isArray(node)) {
    let best: MaxMessageCandidate | null = null;
    node.forEach((item, index) => {
      const candidate = findBestMaxMessageCandidate(item, `${path}[${index}]`, depth + 1);
      if (candidate && (!best || candidate.score > best.score)) {
        best = candidate;
      }
    });
    return best;
  }

  const row = asRecord(node);
  if (!row) {
    return null;
  }

  const currentScore = scoreMaxMessageCandidate(row);
  const currentIsMessage = hasMaxMessageIdentity(row) && hasMaxMessageContent(row);
  let best: MaxMessageCandidate | null = currentIsMessage
    ? { node: row, path, score: currentScore }
    : null;

  for (const [key, value] of Object.entries(row)) {
    if (
      currentIsMessage &&
      (key === 'body' ||
        key === 'content' ||
        key === 'link' ||
        key === 'attachments' ||
        key === 'markup')
    ) {
      continue;
    }
    const candidate = findBestMaxMessageCandidate(value, childPath(path, key), depth + 1);
    if (candidate && (!best || candidate.score > best.score)) {
      best = candidate;
    }
  }
  return best;
}

function isDirectMaxMessageEnvelope(row: Record<string, unknown>): boolean {
  return hasMaxMessageIdentity(row) && hasMaxMessageContent(row);
}

function hasMaxMessageContent(row: Record<string, unknown>): boolean {
  const link = asRecord(row.link);
  const linkType = typeof link?.type === 'string' ? link.type.trim().toLowerCase() : '';
  const hasMessageLink =
    Boolean(link) &&
    (linkType === 'forward' ||
      linkType === 'reply' ||
      Boolean(asRecord(link?.message) || asRecord(link?.body)));
  return (
    Boolean(asRecord(row.body) || asRecord(row.content)) ||
    hasMessageLink ||
    typeof row.text === 'string' ||
    typeof row.caption === 'string' ||
    Array.isArray(row.markup) ||
    Array.isArray(row.attachments)
  );
}

function hasMaxMessageIdentity(row: Record<string, unknown>): boolean {
  const body = asRecord(row.body);
  const content = asRecord(row.content);
  return [
    row.message_id,
    row.messageId,
    row.mid,
    row.seq,
    row.id,
    body?.message_id,
    body?.messageId,
    body?.mid,
    body?.seq,
    body?.id,
    content?.message_id,
    content?.messageId,
    content?.mid,
    content?.seq,
    content?.id,
  ].some((value) => typeof value === 'string' || typeof value === 'number');
}

function scoreMaxMessageCandidate(row: Record<string, unknown>): number {
  let score = 0;

  if (hasMaxMessageIdentity(row)) {
    score += 2;
  }
  if (typeof row.chat_id === 'string' || typeof row.chat_id === 'number') {
    score += 3;
  }
  if (typeof row.chatId === 'string' || typeof row.chatId === 'number') {
    score += 3;
  }

  const chat = asRecord(row.chat);
  if (chat && (typeof chat.id === 'string' || typeof chat.id === 'number')) {
    score += 3;
  }
  const recipient = asRecord(row.recipient);
  if (
    recipient &&
    (typeof recipient.chat_id === 'string' ||
      typeof recipient.chat_id === 'number' ||
      typeof recipient.chatId === 'string' ||
      typeof recipient.chatId === 'number' ||
      typeof recipient.id === 'string' ||
      typeof recipient.id === 'number')
  ) {
    score += 3;
  }

  if (
    typeof row.sender_id === 'string' ||
    typeof row.sender_id === 'number' ||
    typeof row.senderId === 'string' ||
    typeof row.senderId === 'number'
  ) {
    score += 2;
  }
  const sender = asRecord(row.sender);
  const from = asRecord(row.from);
  if (
    (sender &&
      (typeof sender.id === 'string' ||
        typeof sender.id === 'number' ||
        typeof sender.user_id === 'string' ||
        typeof sender.user_id === 'number' ||
        typeof sender.userId === 'string' ||
        typeof sender.userId === 'number')) ||
    (from &&
      (typeof from.id === 'string' ||
        typeof from.id === 'number' ||
        typeof from.user_id === 'string' ||
        typeof from.user_id === 'number' ||
        typeof from.userId === 'string' ||
        typeof from.userId === 'number'))
  ) {
    score += 2;
  }

  if (typeof row.text === 'string' || typeof row.caption === 'string') {
    score += 1;
  }
  if (
    typeof row.title === 'string' ||
    typeof row.chat_title === 'string' ||
    typeof row.chatTitle === 'string'
  ) {
    score += 1;
  }
  if (asRecord(row.body) || asRecord(row.content) || Array.isArray(row.attachments)) {
    score += 1;
  }
  if (
    typeof row.created_at === 'string' ||
    typeof row.createdAt === 'string' ||
    typeof row.timestamp === 'string' ||
    typeof row.timestamp === 'number'
  ) {
    score += 1;
  }
  return score;
}

function childPath(path: string, key: string): string {
  return path === '$' ? `$.${key}` : `${path}.${key}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
