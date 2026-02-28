import { BadRequestException, Injectable } from '@nestjs/common';
import { maxUpdateSchema, type MaxUpdate } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';

@Injectable()
export class WebhookParser {
  parse(payload: Record<string, unknown>): MaxUpdate {
    const type = this.extractUpdateType(payload);
    const message = this.extractMessageNode(payload, type);
    const messageId = this.extractMessageId(message, payload);
    const chatId = this.extractChatId(message, payload);
    const senderId = this.extractSenderId(message, payload);
    const senderName = this.extractSenderName(message, payload);
    const chatTitle = this.extractChatTitle(message);
    const messageText = this.extractMessageText(message);
    const createdAt = this.extractCreatedAt(message, payload);
    const hasMessage = Boolean(message && messageId && chatId && senderId);

    const normalized: MaxUpdate = {
      updateId: String(
        payload.updateId ?? payload.update_id ?? payload.eventId ?? payload.event_id ?? randomUUID(),
      ),
      type,
      message:
        hasMessage
          ? {
              messageId,
              chatId,
              ...(chatTitle ? { chatTitle } : {}),
              senderId,
              ...(senderName ? { senderName } : {}),
              text: messageText,
              createdAt,
            }
          : undefined,
      raw: payload,
    };

    const parsed = maxUpdateSchema.safeParse(normalized);
    if (!parsed.success) {
      throw new BadRequestException('Invalid webhook payload format');
    }

    return parsed.data;
  }

  private extractUpdateType(payload: Record<string, unknown>): string {
    const value = payload.type ?? payload.update_type ?? payload.event_type ?? 'unknown';
    return String(value);
  }

  private extractMessageNode(
    payload: Record<string, unknown>,
    type: string,
  ): Record<string, unknown> | undefined {
    const directMessage = this.asRecord(payload.message);
    if (directMessage) {
      return directMessage;
    }

    const envelopeKeys = [type, payload.update_type, payload.event_type, payload.type, 'data', 'event'];
    for (const key of envelopeKeys) {
      if (typeof key !== 'string' || key.trim().length === 0) {
        continue;
      }

      const envelope = this.asRecord(payload[key]);
      if (!envelope) {
        continue;
      }

      const nestedMessage = this.asRecord(envelope.message);
      if (nestedMessage) {
        return nestedMessage;
      }

      const nestedData = this.asRecord(envelope.data);
      const nestedDataMessage = nestedData ? this.asRecord(nestedData.message) : undefined;
      if (nestedDataMessage) {
        return nestedDataMessage;
      }

      const bestInEnvelope = this.findBestMessageCandidate(envelope);
      if (bestInEnvelope && bestInEnvelope.score >= 4) {
        return bestInEnvelope.node;
      }
    }

    const bestInPayload = this.findBestMessageCandidate(payload);
    return bestInPayload && bestInPayload.score >= 4 ? bestInPayload.node : undefined;
  }

  private extractMessageId(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): string {
    if (!message) {
      return '';
    }

    const body = this.asRecord(message.body);
    const data = this.asRecord(message.data);

    const candidates = [
      message.messageId,
      message.message_id,
      message.id,
      body?.mid,
      body?.seq,
      body?.message_id,
      body?.messageId,
      body?.id,
      data?.message_id,
      data?.messageId,
      data?.id,
      payload.message_id,
      payload.messageId,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
    }

    return '';
  }

  private extractChatId(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): string {
    if (!message) {
      return '';
    }

    const chat = this.asRecord(message.chat);
    const recipient = this.asRecord(message.recipient);
    const conversation = this.asRecord(message.conversation);
    const payloadChat = this.asRecord(payload.chat);

    const candidates = [
      message.chatId,
      message.chat_id,
      chat?.chatId,
      chat?.chat_id,
      chat?.id,
      recipient?.chatId,
      recipient?.chat_id,
      recipient?.id,
      conversation?.chat_id,
      conversation?.chatId,
      conversation?.id,
      payload.chat_id,
      payload.chatId,
      payloadChat?.chat_id,
      payloadChat?.chatId,
      payloadChat?.id,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
    }

    return '';
  }

  private extractSenderId(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): string {
    if (!message) {
      return '';
    }

    const sender = this.asRecord(message.sender);
    const from = this.asRecord(message.from);
    const user = this.asRecord(message.user);
    const actor = this.asRecord(message.actor);
    const payloadSender = this.asRecord(payload.sender);

    const candidates = [
      message.senderId,
      message.sender_id,
      sender?.id,
      sender?.user_id,
      sender?.userId,
      from?.id,
      from?.user_id,
      from?.userId,
      user?.id,
      user?.user_id,
      user?.userId,
      actor?.id,
      actor?.user_id,
      actor?.userId,
      payload.sender_id,
      payload.senderId,
      payloadSender?.id,
      payloadSender?.user_id,
      payloadSender?.userId,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
    }

    return '';
  }

  private extractSenderName(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): string | undefined {
    if (!message) {
      return undefined;
    }

    const sender = this.asRecord(message.sender);
    const from = this.asRecord(message.from);
    const user = this.asRecord(message.user);
    const actor = this.asRecord(message.actor);
    const payloadSender = this.asRecord(payload.sender);

    const directCandidates = [
      message.sender_name,
      message.senderName,
      message.display_name,
      message.displayName,
      sender?.display_name,
      sender?.displayName,
      sender?.name,
      sender?.full_name,
      sender?.fullName,
      sender?.nickname,
      from?.display_name,
      from?.displayName,
      from?.name,
      from?.full_name,
      from?.fullName,
      user?.display_name,
      user?.displayName,
      user?.name,
      user?.full_name,
      user?.fullName,
      actor?.display_name,
      actor?.displayName,
      actor?.name,
      actor?.full_name,
      actor?.fullName,
      payloadSender?.display_name,
      payloadSender?.displayName,
      payloadSender?.name,
      payloadSender?.full_name,
      payloadSender?.fullName,
    ];

    for (const value of directCandidates) {
      const text = this.readString(value);
      if (text) {
        return text;
      }
    }

    const nameNodes = [sender, from, user, actor, payloadSender].filter(
      (item): item is Record<string, unknown> => Boolean(item),
    );

    for (const node of nameNodes) {
      const firstName = this.readString(
        node.first_name ?? node.firstName ?? node.given_name ?? node.givenName,
      );
      const lastName = this.readString(
        node.last_name ?? node.lastName ?? node.family_name ?? node.familyName,
      );

      const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
      if (fullName.length > 0) {
        return fullName;
      }
    }

    return undefined;
  }

  private extractCreatedAt(
    message: Record<string, unknown> | undefined,
    payload: Record<string, unknown>,
  ): string {
    const candidates = [
      message?.createdAt,
      message?.created_at,
      message?.timestamp,
      payload.timestamp,
      payload.created_at,
      payload.createdAt,
    ];

    for (const value of candidates) {
      if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
        continue;
      }

      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }

    return new Date().toISOString();
  }

  private extractChatTitle(message: Record<string, unknown> | undefined): string | undefined {
    if (!message) {
      return undefined;
    }

    const recipient = this.asRecord(message.recipient);
    const chat = this.asRecord(message.chat);
    const candidates = [
      message.chatTitle,
      message.chat_title,
      message.chatName,
      message.chat_name,
      chat?.title,
      chat?.name,
      recipient?.title,
      recipient?.chat_title,
      recipient?.chatTitle,
      recipient?.name,
      recipient?.display_name,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    return undefined;
  }

  private extractMessageText(message: Record<string, unknown> | undefined): string {
    if (!message) {
      return '';
    }

    const body = this.asRecord(message.body);
    const content = this.asRecord(message.content);
    const payload = this.asRecord(message.payload);
    const messageNode = this.asRecord(message.message);

    const directCandidates = [
      message.text,
      message.caption,
      message.message_text,
      message.messageText,
      body?.text,
      body?.plain,
      content?.text,
      content?.caption,
      payload?.text,
      messageNode?.text,
    ];

    let directText = '';
    for (const value of directCandidates) {
      if (typeof value === 'string' && value.trim().length > 0) {
        directText = value.trim();
        break;
      }
    }

    const supplementalTextSnippets = this.collectSupplementalTextSnippets(message);
    const supplementalLinkUrls = this.collectSupplementalLinkUrls(message);

    if (!directText) {
      const textOnly = this.mergeTextSnippets([], supplementalTextSnippets);
      if (textOnly.length > 0) {
        return textOnly.join(' ');
      }

      if (supplementalLinkUrls.length > 0) {
        return supplementalLinkUrls.join(' ');
      }

      return '';
    }

    const knownDirectUrls = new Set(
      this.extractUrlsFromString(directText).map((url) => this.normalizeUrlForCompare(url)),
    );
    const filteredSupplementalSnippets: string[] = [];
    for (const snippet of supplementalTextSnippets) {
      const normalizedSnippet = snippet.replace(/\s+/g, ' ').trim();
      if (!normalizedSnippet) {
        continue;
      }

      const snippetUrls = this.extractUrlsFromString(normalizedSnippet);
      const hasNewUrl = snippetUrls.some(
        (url) => !knownDirectUrls.has(this.normalizeUrlForCompare(url)),
      );
      const snippetWithoutUrls = this.stripUrlsFromText(normalizedSnippet).trim();

      if (!hasNewUrl && snippetWithoutUrls.length === 0) {
        continue;
      }

      if (!hasNewUrl && snippetWithoutUrls.length > 0) {
        filteredSupplementalSnippets.push(snippetWithoutUrls);
        continue;
      }

      filteredSupplementalSnippets.push(normalizedSnippet);
      for (const url of snippetUrls) {
        knownDirectUrls.add(this.normalizeUrlForCompare(url));
      }
    }

    let composedText = this.mergeTextSnippets([directText], filteredSupplementalSnippets).join(' ');
    if (supplementalLinkUrls.length === 0) {
      return composedText;
    }

    const composedUrls = new Set(
      this.extractUrlsFromString(composedText).map((url) => this.normalizeUrlForCompare(url)),
    );
    const missingUrls = supplementalLinkUrls.filter(
      (url) => !composedUrls.has(this.normalizeUrlForCompare(url)),
    );

    if (missingUrls.length === 0) {
      return composedText;
    }

    composedText = `${composedText} ${missingUrls.join(' ')}`.trim();
    return composedText;
  }

  private collectSupplementalTextSnippets(message: Record<string, unknown>): string[] {
    const body = this.asRecord(message.body);
    const content = this.asRecord(message.content);
    const payload = this.asRecord(message.payload);
    const messageNode = this.asRecord(message.message);

    const candidates: unknown[] = [
      message.markup,
      message.attachments,
      message.link,
      message.forward,
      message.forwarded_message,
      message.forwardedMessage,
      body?.markup,
      body?.attachments,
      body?.link,
      body?.forward,
      body?.forwarded_message,
      body?.forwardedMessage,
      content?.markup,
      content?.attachments,
      content?.link,
      content?.forward,
      content?.forwarded_message,
      content?.forwardedMessage,
      payload?.markup,
      payload?.attachments,
      payload?.link,
      payload?.forward,
      payload?.forwarded_message,
      payload?.forwardedMessage,
      messageNode?.link,
      messageNode?.markup,
      messageNode?.attachments,
      messageNode?.forward,
      messageNode?.forwarded_message,
      messageNode?.forwardedMessage,
    ];

    const acc = new Set<string>();
    for (const candidate of candidates) {
      this.collectTextSnippetsFromNode(candidate, acc);
    }

    return [...acc];
  }

  private collectSupplementalLinkUrls(message: Record<string, unknown>): string[] {
    const body = this.asRecord(message.body);
    const content = this.asRecord(message.content);
    const payload = this.asRecord(message.payload);
    const messageNode = this.asRecord(message.message);
    const candidates: unknown[] = [
      message.link,
      message.markup,
      message.attachments,
      body?.link,
      body?.markup,
      body?.attachments,
      content?.link,
      content?.markup,
      content?.attachments,
      payload?.link,
      payload?.markup,
      payload?.attachments,
      messageNode?.link,
      messageNode?.markup,
      messageNode?.attachments,
    ];

    const acc = new Set<string>();
    for (const candidate of candidates) {
      this.collectLinkUrlsFromEntities(candidate, acc);
    }

    return [...acc];
  }

  private mergeTextSnippets(base: string[], supplemental: string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();

    for (const value of [...base, ...supplemental]) {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (!normalized) {
        continue;
      }

      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(normalized);
    }

    return merged;
  }

  private normalizeUrlForCompare(url: string): string {
    return url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  private collectTextSnippetsFromNode(
    node: unknown,
    acc: Set<string>,
    parentKey = '',
    depth = 0,
  ) {
    if (depth > 8 || node === null || node === undefined) {
      return;
    }

    if (typeof node === 'string') {
      if (!this.isContentTextKey(parentKey)) {
        return;
      }

      const normalized = node.trim();
      if (normalized.length > 0) {
        acc.add(normalized);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectTextSnippetsFromNode(item, acc, parentKey, depth + 1);
      }
      return;
    }

    const row = this.asRecord(node);
    if (!row) {
      return;
    }

    for (const [key, value] of Object.entries(row)) {
      this.collectTextSnippetsFromNode(value, acc, key, depth + 1);
    }
  }

  private collectLinkUrlsFromEntities(
    node: unknown,
    acc: Set<string>,
    parentKey = '',
    depth = 0,
    trustedLinkContext = false,
  ) {
    if (depth > 8 || node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectLinkUrlsFromEntities(item, acc, parentKey, depth + 1, trustedLinkContext);
      }
      return;
    }

    const row = this.asRecord(node);
    if (!row) {
      return;
    }

    const type = this.readLowerString(row.type ?? row.kind ?? row.entity_type ?? row.entityType);
    const parent = parentKey.toLowerCase();
    const isExplicitLinkEntity =
      type === 'link' ||
      type === 'url' ||
      type === 'hyperlink' ||
      parent === 'link' ||
      parent === 'links' ||
      parent === 'markup' ||
      parent === 'entity' ||
      parent === 'entities';
    const hasLinkContext = trustedLinkContext || isExplicitLinkEntity;

    if (hasLinkContext) {
      const linkCandidates = [
        row.url,
        row.href,
        row.link,
        row.link_url,
        row.linkUrl,
        row.target_url,
        row.targetUrl,
        row.uri,
      ];

      for (const candidate of linkCandidates) {
        if (typeof candidate !== 'string') {
          continue;
        }

        for (const url of this.extractUrlsFromString(candidate)) {
          acc.add(url);
        }
      }
    }

    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string' && this.isContentTextKey(key)) {
        for (const url of this.extractUrlsFromString(value)) {
          acc.add(url);
        }
      }

      if (typeof value === 'string' && hasLinkContext && this.isLinkFieldKey(key)) {
        for (const url of this.extractUrlsFromString(value)) {
          acc.add(url);
        }
      }

      if (value && (typeof value === 'object' || Array.isArray(value))) {
        this.collectLinkUrlsFromEntities(value, acc, key, depth + 1, hasLinkContext);
      }
    }
  }

  private isContentTextKey(value: string): boolean {
    const key = value.toLowerCase();
    return (
      key === 'text' ||
      key === 'caption' ||
      key === 'plain' ||
      key === 'message_text' ||
      key === 'messagetext' ||
      key === 'description'
    );
  }

  private isLinkFieldKey(value: string): boolean {
    const key = value.toLowerCase();
    return (
      key === 'url' ||
      key === 'href' ||
      key === 'link' ||
      key === 'uri' ||
      key === 'link_url' ||
      key === 'linkurl' ||
      key === 'target_url' ||
      key === 'targeturl' ||
      key.endsWith('_url') ||
      key.endsWith('url')
    );
  }

  private stripUrlsFromText(value: string): string {
    if (!value) {
      return '';
    }

    const regex = /((https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?/gi;
    return value.replace(regex, ' ').replace(/\s+/g, ' ').trim();
  }

  private extractUrlsFromString(value: string): string[] {
    if (!value || value.trim().length === 0) {
      return [];
    }

    const regex = /((https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?/gi;
    return [...value.matchAll(regex)]
      .map((match) => match[0].trim().replace(/[),.;!?]+$/, ''))
      .filter((url) => url.length > 0);
  }

  private findBestMessageCandidate(
    node: unknown,
    depth = 0,
  ): { node: Record<string, unknown>; score: number } | undefined {
    if (depth > 8 || node === null || node === undefined) {
      return undefined;
    }

    if (Array.isArray(node)) {
      let best: { node: Record<string, unknown>; score: number } | undefined;
      for (const item of node) {
        const candidate = this.findBestMessageCandidate(item, depth + 1);
        if (candidate && (!best || candidate.score > best.score)) {
          best = candidate;
        }
      }
      return best;
    }

    const row = this.asRecord(node);
    if (!row) {
      return undefined;
    }

    const currentScore = this.scoreMessageCandidate(row);
    let best: { node: Record<string, unknown>; score: number } | undefined =
      currentScore > 0 ? { node: row, score: currentScore } : undefined;

    for (const value of Object.values(row)) {
      const candidate = this.findBestMessageCandidate(value, depth + 1);
      if (candidate && (!best || candidate.score > best.score)) {
        best = candidate;
      }
    }

    return best;
  }

  private scoreMessageCandidate(row: Record<string, unknown>): number {
    let score = 0;

    if (
      typeof row.message_id === 'string' ||
      typeof row.message_id === 'number' ||
      typeof row.messageId === 'string' ||
      typeof row.messageId === 'number' ||
      typeof row.id === 'string' ||
      typeof row.id === 'number'
    ) {
      score += 2;
    }

    if (typeof row.chat_id === 'string' || typeof row.chat_id === 'number') {
      score += 3;
    }
    if (typeof row.chatId === 'string' || typeof row.chatId === 'number') {
      score += 3;
    }

    const chat = this.asRecord(row.chat);
    if (chat && (typeof chat.id === 'string' || typeof chat.id === 'number')) {
      score += 3;
    }

    const recipient = this.asRecord(row.recipient);
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

    if (typeof row.sender_id === 'string' || typeof row.senderId === 'string') {
      score += 2;
    }
    const sender = this.asRecord(row.sender);
    const from = this.asRecord(row.from);
    if ((sender && typeof sender.id === 'string') || (from && typeof from.id === 'string')) {
      score += 2;
    }

    if (typeof row.text === 'string' || typeof row.caption === 'string') {
      score += 1;
    }
    if (this.asRecord(row.body) || this.asRecord(row.content) || Array.isArray(row.attachments)) {
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

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private readString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private readLowerString(value: unknown): string | undefined {
    const normalized = this.readString(value);
    if (!normalized) {
      return undefined;
    }

    return normalized.toLowerCase();
  }
}
