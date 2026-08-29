import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { MINIAPP_PROFILES_METADATA } from '../auth/miniapp-profile';
import { PublisherVkParsingController } from './publisher-vk-parsing.controller';

describe('PublisherVkParsingController boundary', () => {
  it('exposes VK parsing only inside the Publisher namespace and profile', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PublisherVkParsingController)).toBe(
      'v1/publisher/entities/:entityType/:entityId/vk-parsing',
    );
    expect(Reflect.getMetadata(MINIAPP_PROFILES_METADATA, PublisherVkParsingController)).toEqual([
      'publisher',
    ]);
  });

  it('rejects an unsupported Publisher entity type before calling the service', () => {
    const service = { listVkParsing: jest.fn() };
    const controller = new PublisherVkParsingController(service as never);

    expect(() => controller.getVkParsing('unknown', 'entity-1', {} as never, {})).toThrow(
      BadRequestException,
    );
    expect(service.listVkParsing).not.toHaveBeenCalled();
  });
});
