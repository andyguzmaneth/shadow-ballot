import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude Hardhat's Solidity-contract tests (test/*.cjs, run via mocha through
    // `npx hardhat test`) — vitest's default include glob was picking them up and
    // failing on `describe is not defined` since they use mocha's globals, not
    // vitest's. Two separate test runners for two separate concerns: vitest for the
    // TS crypto/protocol libs in src/, hardhat for the Solidity contracts in test/.
    exclude: ['**/node_modules/**', 'test/**'],
  },
});
