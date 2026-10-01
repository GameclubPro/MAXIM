import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiRequestError } from '../src/lib/api-request-error.ts';
import { SettingsMessageRetentionSection } from '../src/pages/settings/settings-message-retention-section.tsx';

// The real section/editor use a controllable API so races are tested without MAX or production data.
export function mountRetentionFixture() {
  const initial = {
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
  };
  let server = structuredClone(initial);
  let readFailure = false;
  let writeFailure = null;
  let loseReply = false;
  let writeGate = null;
  let releaseWrite = null;
  let updateProps;
  const requests = [];
  const api = {
    requestKeepalive() {},
    async request(path, init = {}) {
      const method = init.method ?? 'GET';
      requests.push(method);
      if (method === 'GET') {
        if (readFailure) throw new Error('Чтение настроек недоступно.');
        return structuredClone(server);
      }
      if (writeGate) await writeGate;
      if (writeFailure)
        throw new ApiRequestError(
          writeFailure.status,
          JSON.stringify(writeFailure),
          writeFailure.message,
        );
      const input = JSON.parse(init.body);
      if (input.expectedRevision !== server.revision)
        throw new ApiRequestError(
          409,
          '{"code":"MESSAGE_RETENTION_REVISION_CONFLICT"}',
          'Ревизия изменилась.',
        );
      server = {
        ...server,
        enabled: input.enabled,
        hours: input.hours,
        revision: server.revision + 1,
        status: input.enabled ? 'running' : 'off',
        captureAfter: input.enabled ? new Date().toISOString() : null,
      };
      if (loseReply) {
        loseReply = false;
        throw new Error('Ответ на сохранение потерян.');
      }
      return structuredClone(server);
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
    serverState: () => structuredClone(server),
    replaceServer: (patch) => {
      server = { ...server, ...patch };
    },
    publishSummary: (patch) =>
      updateProps((old) => ({ ...old, initialSummary: { ...server, ...patch } })),
    changeChat: (chatId) => {
      server = structuredClone(initial);
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
