import {
  safetyDeskPublicationDeliveryEvidenceResponseSchema,
  type SafetyDeskPublicationDeliveryEvidenceResponse,
} from '@maxim/contracts/safety-desk';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildPublicationDeliveryIndexesQuery,
  buildPublicationDeliveryEvidenceQuery,
  buildPublicationDeliveryLedgerQuery,
} from './safety-desk-publication-delivery-evidence.query';
import {
  projectPublicationDeliveryEvidence,
  publicationDeliveryEvidenceKeys,
  type PublicationDeliveryEvidenceRow,
  type PublicationDeliveryLedgerRow,
} from './safety-desk-publication-delivery-evidence.model';
@Injectable()
export class SafetyDeskPublicationDeliveryEvidenceService {
  constructor(private readonly prisma: PrismaService) {}
  async getEvidence(deliveryId: string): Promise<SafetyDeskPublicationDeliveryEvidenceResponse> {
    if (!deliveryId || deliveryId.length > 128 || deliveryId !== deliveryId.trim())
      throw new BadRequestException('Некорректный идентификатор доставки.');
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
          await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
          const indexes = await tx.$queryRaw<Array<{ ready: boolean }>>(
            buildPublicationDeliveryIndexesQuery(),
          );
          if (indexes[0]?.ready !== true)
            throw new Error('Required delivery evidence indexes unavailable');
          const rows = await tx.$queryRaw<PublicationDeliveryEvidenceRow[]>(
            buildPublicationDeliveryEvidenceQuery(deliveryId),
          );
          const row = rows[0];
          if (!row) throw new NotFoundException('Доставка не найдена.');
          const keys = publicationDeliveryEvidenceKeys(row);
          const ledgers = keys
            ? await tx.$queryRaw<PublicationDeliveryLedgerRow[]>(
                buildPublicationDeliveryLedgerQuery([
                  ...new Set([keys.currentKey, keys.legacyKey]),
                ]),
              )
            : [];
          return safetyDeskPublicationDeliveryEvidenceResponseSchema.parse(
            projectPublicationDeliveryEvidence(row, ledgers),
          );
        },
        { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 },
      );
    } catch (error: unknown) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('Подтверждения доставки временно недоступны.');
    }
  }
}
