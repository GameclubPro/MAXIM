import { Prisma } from '../prisma/prisma-client';
import { isPrismaKnownError } from './admin-legacy-utils';

const TRANSIENT_PUBLICATION_PRISMA_CODES = [
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2028',
  'P2034',
  'P2037',
] as const;

export function isTransientPublicationPrismaError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }
  return TRANSIENT_PUBLICATION_PRISMA_CODES.some((code) => isPrismaKnownError(error, code));
}
