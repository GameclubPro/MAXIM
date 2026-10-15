import {
  assignManagedModeratorRequestSchema,
  type ManagedModeratorAssignmentResult,
  type PublicModerator,
} from '@maxim/contracts/managed-entities';
import { ApiRequestError } from '../api-request-error';
import type { PreviewState } from './preview-transport-state';
import { PREVIEW_NOT_HANDLED, type PreviewRequestHandler } from './preview-transport-runtime';
import { parseJsonBody } from './preview-transport-shared';
const bots: PublicModerator[] = [
  {
    key: '1'.repeat(24),
    name: 'Максимов',
    portrait: 'maximov',
    url: 'https://max.ru/id613002203036_bot',
  },
  {
    key: '2'.repeat(24),
    name: 'Максимова',
    portrait: 'maximova',
    url: 'https://max.ru/id613002203036_4_bot',
  },
  {
    key: '3'.repeat(24),
    name: 'Рэкс',
    portrait: 'rex',
    url: 'https://max.ru/id613002203036_5_bot',
  },
  {
    key: '4'.repeat(24),
    name: 'Максимов 2',
    portrait: 'maximov',
    url: 'https://max.ru/id613070470872_9_bot',
  },
];
const states = new WeakMap<
  PreviewState,
  Map<
    string,
    {
      moderator: PublicModerator;
      moderatorRevision: number;
      operations: Map<string, ManagedModeratorAssignmentResult>;
    }
  >
>();
function entityState(state: PreviewState, type: string, id: string) {
  let entities = states.get(state);
  if (!entities) {
    entities = new Map();
    states.set(state, entities);
  }
  const key = `${type}:${id}`;
  let entry = entities.get(key);
  if (!entry) {
    entry = { moderator: bots[0]!, moderatorRevision: 1, operations: new Map() };
    entities.set(key, entry);
  }
  return entry;
}
export function previewModeratorPresentation(state: PreviewState, type: string, id: string) {
  const { moderator, moderatorRevision } = entityState(state, type, id);
  return { moderator, moderatorRevision, canChooseModerator: true };
}
export const handleModeratorPreviewRequest: PreviewRequestHandler = ({
  state,
  method,
  segments,
  init,
}) => {
  if (segments[0] !== 'managed-entities' || segments[3] !== 'moderator') return PREVIEW_NOT_HANDLED;
  const id = decodeURIComponent(segments[2] ?? '');
  const entry = entityState(state, segments[1]!, id);
  if (segments[4] === 'operations' && method === 'GET') {
    const result = entry.operations.get(segments[5]!);
    if (!result) throw new ApiRequestError(404, '', 'Смена бота ещё не подтверждена.');
    return result;
  }
  if (method === 'GET')
    return {
      revision: entry.moderatorRevision,
      current: entry.moderator,
      selectionEnabled: true,
      candidates: bots.map((bot, index) => ({
        ...bot,
        selectable: index !== 3,
        reason: index === 3 ? 'needs_permissions' : null,
      })),
    };
  if (method === 'POST') {
    const request = assignManagedModeratorRequestSchema.parse(parseJsonBody(init));
    const prior = entry.operations.get(request.operationId);
    if (prior) return prior;
    if (request.expectedRevision !== entry.moderatorRevision)
      throw new ApiRequestError(409, '', 'Выбор бота уже изменился.');
    const moderator = bots.find((bot) => bot.key === request.moderatorKey);
    if (!moderator || moderator === bots[3])
      throw new ApiRequestError(409, '', 'Боту не хватает прав.');
    entry.moderator = moderator;
    const result: ManagedModeratorAssignmentResult = {
      operationId: request.operationId,
      status: 'applied',
      revision: ++entry.moderatorRevision,
      moderator,
    };
    entry.operations.set(request.operationId, result);
    return result;
  }
  return PREVIEW_NOT_HANDLED;
};
