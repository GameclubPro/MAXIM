import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  messageRetentionStateSchema,
  updateMessageRetentionSchema,
} from '@maxim/contracts/settings';
import { ApiRequestError } from '../src/lib/api-request-error.ts';
import { SettingsMessageRetentionSection } from '../src/pages/settings/settings-message-retention-section.tsx';
import { SharedMessageRetentionFields } from '../src/pages/settings/shared-message-retention-fields.tsx';

// The real section/editor use a controllable API so races are tested without MAX or production data.
export function mountRetentionFixture() {
  const initial = messageRetentionStateSchema.parse({
    enabled: false,
    hours: 48,
    revision: 0,
    enabledAt: null,
    captureAfter: null,
    pausedAt: null,
    status: 'off',
    pendingCount: 0,
    deletedCount: 0,
    skippedCount: 0,
    oldestDueAt: null,
    connectionStatus: 'connected',
  });
  let server = structuredClone(initial);
  let readFailure = false;
  let writeFailure = null;
  let loseReply = false;
  let loseBeforeCommit = false;
  let writeGate = null;
  let releaseWrite = null;
  let updateProps;
  const requests = [];
  const writes = [];
  const writeAttempts = [];
  const operations = new Map();
  /** @type {import('../src/lib/api/transport.ts').ApiTransport} */
  const api = {
    requestKeepalive() {},
    async request(path, init = {}) {
      const method = init.method ?? 'GET';
      requests.push(method);
      if (method === 'GET') {
        if (readFailure) throw new Error('Чтение настроек недоступно.');
        return structuredClone(server);
      }
      const input = updateMessageRetentionSchema.parse(JSON.parse(String(init.body)));
      writeAttempts.push(structuredClone(input));
      if (writeFailure)
        throw new ApiRequestError(
          writeFailure.status,
          JSON.stringify(writeFailure),
          writeFailure.message,
        );
      writes.push(structuredClone(input));
      const key = `${path}:${input.operationId}`;
      const body = JSON.stringify(input);
      let operation = operations.get(key);
      if (operation && operation.body !== body)
        throw new ApiRequestError(409, '{"code":"ERASER_OPERATION_CONFLICT"}', 'Запрос изменён.');
      if (!operation) {
        const gate = writeGate;
        const result = (async () => {
          if (gate) await gate;
          if (input.expectedRevision !== server.revision)
            throw new ApiRequestError(
              409,
              '{"code":"MESSAGE_RETENTION_REVISION_CONFLICT"}',
              'Ревизия изменилась.',
            );
          server = messageRetentionStateSchema.parse({
            ...server,
            enabled: input.connectWhenReady ? false : input.enabled,
            hours: input.hours,
            revision: server.revision + 1,
            status: input.enabled && !input.connectWhenReady ? 'running' : 'off',
            connectionStatus:
              input.enabled && !input.connectWhenReady ? 'connected' : server.connectionStatus,
            connectionRequest: input.connectWhenReady
              ? {
                  status: 'pending',
                  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                }
              : null,
            ...(input.operationId ? { lastOperationId: input.operationId } : {}),
          });
          return structuredClone(server);
        })();
        operation = { body, result };
        operations.set(key, operation);
        void result.catch(() => operations.delete(key));
      }
      if (loseBeforeCommit) {
        loseBeforeCommit = false;
        throw new Error('Ответ потерян до завершения записи.');
      }
      const result = await operation.result;
      if (loseReply) {
        loseReply = false;
        throw new Error('Ответ на сохранение потерян.');
      }
      return structuredClone(result);
    },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Fixture() {
    const [props, setProps] = useState({ chatId: 'fixture-chat', initialSummary: server });
    updateProps = setProps;
    return React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SettingsMessageRetentionSection, { key: props.chatId, api, ...props }),
    );
  }
  document.getElementById('root')?.remove();
  const container = document.createElement('div');
  container.id = 'retention-test-fixture';
  document.body.append(container);
  createRoot(container).render(React.createElement(Fixture));
  window.__RETENTION_TEST__ = {
    requests,
    writes,
    writeAttempts,
    serverState: () => structuredClone(server),
    replaceServer: (patch) => {
      server = { ...server, ...patch };
    },
    publishSummary: (patch) =>
      updateProps((old) => ({ ...old, initialSummary: { ...server, ...patch } })),
    changeChat: (chatId) => {
      server = structuredClone(initial);
      operations.clear();
      updateProps({ chatId, initialSummary: server });
    },
    failReads: (value) => {
      readFailure = value;
    },
    failWrites: (value) => {
      writeFailure = value;
    },
    loseNextReply: () => {
      loseReply = true;
    },
    loseNextReplyBeforeCommit: () => {
      loseBeforeCommit = true;
    },
    holdWrite: () => {
      writeGate = new Promise((resolve) => {
        releaseWrite = resolve;
      });
    },
    releaseWrite: () => {
      releaseWrite?.();
      writeGate = null;
    },
  };
}

export function mountMixedRetentionFixture() {
  document.getElementById('root')?.remove();
  const container = document.createElement('div');
  container.className = 'message-retention-settings';
  document.body.append(container);
  function Fixture() {
    const [enabled, setEnabled] = useState({ kind: 'mixed' });
    const [hours, setHours] = useState({ kind: 'mixed' });
    return React.createElement(SharedMessageRetentionFields, {
      scope: 'network',
      enabled,
      hours,
      disabled: false,
      onEnabledChange: (value) => setEnabled({ kind: 'common', value }),
      onHoursChange: (value) => setHours({ kind: 'common', value }),
    });
  }
  createRoot(container).render(React.createElement(Fixture));
}
