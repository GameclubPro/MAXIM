# ADR-001: MAXIM v1 Architecture

## Status

Accepted (2026-02-28)

## Decision

Use npm workspaces monorepo:

- `apps/api`: NestJS + Fastify + Prisma + BullMQ
- `apps/miniapp`: React + Vite
- `packages/contracts`: shared zod schemas and TS types

## Rationale

- Shared contracts reduce API/UI drift.
- Queue-based processing improves resilience for webhook spikes.
- Postgres + Redis satisfy consistency + throughput requirements.

## Consequences

- Requires Docker-based local and VPS runtime.
- Requires strict secret handling in `.env` and GitHub Secrets.
