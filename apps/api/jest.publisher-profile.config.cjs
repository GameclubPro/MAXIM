const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  testRegex: 'test/publisher-turn-profile/run\\.profile\\.ts$',
  testTimeout: 2_800_000,
  collectCoverage: false,
};
