import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { createPrismaAdapter, PrismaClient } from './prisma-client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      adapter: createPrismaAdapter(),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
