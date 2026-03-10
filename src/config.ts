/**
 * Shadow Ballot configuration.
 *
 * Contract address and ABI for the ShadowBallot contract on Sepolia.
 * Update CONTRACT_ADDRESS after deploying with scripts/deploy.cjs.
 */

export const SEPOLIA_CHAIN_ID = 11155111;

// Set to deployed contract address on Sepolia (update after deployment)
export const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Demo coordinator keys storage key.
 * The coordinator stealth keys are generated once and persisted in localStorage.
 * TESTNET-ONLY. Never use on mainnet.
 */
export const COORDINATOR_STORAGE_KEY = 'shadow-ballot-coordinator';

/**
 * Hardcoded demo proposals (used when contract is not deployed).
 */
export interface DemoProposal {
  id: number;
  title: string;
  deadline: number; // unix timestamp
}

export const DEMO_PROPOSALS: DemoProposal[] = [
  {
    id: 0,
    title: 'Should Ethereum adopt encrypted mempools?',
    deadline: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 1 week
  },
  {
    id: 1,
    title: 'Fund privacy research for 2027?',
    deadline: Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60, // 2 weeks
  },
  {
    id: 2,
    title: 'Mandate stealth addresses in all wallets?',
    deadline: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 1 month
  },
];

/**
 * Vote announcement store key (localStorage).
 * Voter stores {txHash, ephemeralPubKey} for coordinator scanning.
 */
export const ANNOUNCEMENTS_STORAGE_KEY = 'shadow-ballot-announcements';

export const SHADOW_BALLOT_ABI = [
  'function createProposal(string title, uint256 deadline) returns (uint256)',
  'function submitResults(uint256 proposalId, uint256 yesVotes, uint256 noVotes, uint256 abstainVotes)',
  'function getProposal(uint256 proposalId) view returns (string title, uint256 deadline, uint256 yesVotes, uint256 noVotes, uint256 abstainVotes, bool finalized)',
  'function getProposalCount() view returns (uint256)',
  'function coordinator() view returns (address)',
  'event ProposalCreated(uint256 indexed proposalId, string title, uint256 deadline)',
  'event ResultsSubmitted(uint256 indexed proposalId, uint256 yes, uint256 no, uint256 abstain)',
] as const;
