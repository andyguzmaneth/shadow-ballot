/**
 * Shadow Ballot configuration.
 *
 * Contract address and ABI for the ShadowBallot contract on Sepolia.
 * Update CONTRACT_ADDRESS after deploying with scripts/deploy.cjs.
 */

export const SEPOLIA_CHAIN_ID = 11155111;

// Set to deployed contract address on Sepolia (update after deployment)
export const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000000';

export const SHADOW_BALLOT_ABI = [
  'function createProposal(string title, uint256 deadline) returns (uint256)',
  'function submitResults(uint256 proposalId, uint256 yesVotes, uint256 noVotes, uint256 abstainVotes)',
  'function getProposal(uint256 proposalId) view returns (string title, uint256 deadline, uint256 yesVotes, uint256 noVotes, uint256 abstainVotes, bool finalized)',
  'function getProposalCount() view returns (uint256)',
  'function coordinator() view returns (address)',
  'event ProposalCreated(uint256 indexed proposalId, string title, uint256 deadline)',
  'event ResultsSubmitted(uint256 indexed proposalId, uint256 yes, uint256 no, uint256 abstain)',
] as const;
