/** @type {import('jest').Config} */
module.exports = {
  testRegex: '.*\\.(spec|test)\\.ts$',
  moduleNameMapper: {
    '^@maxim/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: '<rootDir>/coverage',
  testEnvironment: 'node',
};
