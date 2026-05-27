/** @type {import('jest').Config} */
module.exports = {
  testRegex: '.*\\.(spec|test)\\.ts$',
  moduleNameMapper: {
    '^@maxim/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^@maxim/contracts/(.*)$': '<rootDir>/../../packages/contracts/src/$1.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup-silent-logs.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: '<rootDir>/coverage',
  testEnvironment: 'node',
};
