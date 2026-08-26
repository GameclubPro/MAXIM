/** @type {import('jest').Config} */
module.exports = {
  testRegex: '.*\\.(spec|test)\\.ts$',
  moduleNameMapper: {
    '^@maxim/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^@maxim/contracts/bot-speech$': '<rootDir>/../../packages/contracts/src/bot-speech.ts',
    '^@maxim/contracts/broadcast$': '<rootDir>/../../packages/contracts/src/broadcast.ts',
    '^@maxim/contracts/channel-dialog$': '<rootDir>/../../packages/contracts/src/channel-dialog.ts',
    '^@maxim/contracts/channel-post-signature$':
      '<rootDir>/../../packages/contracts/src/channel-post-signature.ts',
    '^@maxim/contracts/channel-stats$': '<rootDir>/../../packages/contracts/src/channel-stats.ts',
    '^@maxim/contracts/chat-participants$':
      '<rootDir>/../../packages/contracts/src/chat-participants.ts',
    '^@maxim/contracts/giveaway$': '<rootDir>/../../packages/contracts/src/giveaway.ts',
    '^@maxim/contracts/karavan-storefront$':
      '<rootDir>/../../packages/contracts/src/karavan-storefront.ts',
    '^@maxim/contracts/managed-entities$':
      '<rootDir>/../../packages/contracts/src/managed-entities.ts',
    '^@maxim/contracts/manual-moderation$':
      '<rootDir>/../../packages/contracts/src/manual-moderation.ts',
    '^@maxim/contracts/poll$': '<rootDir>/../../packages/contracts/src/poll.ts',
    '^@maxim/contracts/publication$': '<rootDir>/../../packages/contracts/src/publication.ts',
    '^@maxim/contracts/publisher$': '<rootDir>/../../packages/contracts/src/publisher.ts',
    '^@maxim/contracts/safety-desk$': '<rootDir>/../../packages/contracts/src/safety-desk.ts',
    '^@maxim/contracts/settings$': '<rootDir>/../../packages/contracts/src/settings.ts',
    '^@maxim/contracts/support-requests$':
      '<rootDir>/../../packages/contracts/src/support-requests.ts',
    '^@maxim/contracts/system$': '<rootDir>/../../packages/contracts/src/system.ts',
    '^@maxim/contracts/vk-parsing$': '<rootDir>/../../packages/contracts/src/vk-parsing.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
    'node_modules/(?:file-type|strtok3|token-types|uint8array-extras|@tokenizer/inflate|@borewit/text-codec)/.+\\.js$':
      '<rootDir>/test/jest-esm-to-cjs-transformer.cjs',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(?:file-type|strtok3|token-types|uint8array-extras|@tokenizer/inflate|@borewit/text-codec)/)',
  ],
  setupFilesAfterEnv: ['<rootDir>/test/setup-silent-logs.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: '<rootDir>/coverage',
  testEnvironment: 'node',
};
