import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

export * from '../generated/prisma/client';

export function createPrismaAdapter(databaseUrl = process.env.DATABASE_URL): PrismaPg {
  if (!databaseUrl?.trim()) {
    throw new Error('DATABASE_URL is required to initialize PrismaClient');
  }

  return new PrismaPg(databaseUrl);
}

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  return new PrismaClient({
    adapter: createPrismaAdapter(databaseUrl),
  });
}
