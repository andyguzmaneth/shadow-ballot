require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      // OpenZeppelin Contracts 5.6+ uses MCOPY (Bytes.sol, SignatureChecker.sol),
      // a Cancun-era opcode. Default target was Paris, which doesn't have it —
      // added 2026-08-19 while wiring up ShadowBallotGovernor. Sepolia has been
      // on Cancun since the Dencun upgrade (March 2024), so this doesn't limit
      // where this can actually deploy.
      evmVersion: "cancun",
      // Without this, ShadowBallotGovernor (Governor + GovernorSettings +
      // GovernorVotes + GovernorVotesQuorumFraction + GovernorAnamorphicCounting
      // composed in one contract) compiles to 27,481 bytes — over the 24,576-byte
      // EIP-170 limit every real EVM network enforces (Sepolia included; this is
      // consensus-level, not a mainnet-only restriction). Optimizer with a low
      // `runs` favors bytecode size over gas efficiency per call — the right
      // tradeoff here since this contract's calls are infrequent (one proposal,
      // one tally submission) not high-frequency.
      optimizer: {
        enabled: true,
        runs: 1,
      },
    },
  },
  paths: {
    sources: "./contracts",
    artifacts: "./artifacts",
  },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};
