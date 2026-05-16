import { Injectable } from '@nestjs/common';
import { MaxClientService, type MaxActionJob } from './max-client.service';

@Injectable()
export class MaxActionDispatchService {
  constructor(private readonly maxClient: MaxClientService) {}

  async execute(job: MaxActionJob): Promise<void> {
    await this.maxClient.executeActionJob(job);
  }
}
