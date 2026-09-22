/**
 * Shadow Ballot configuration.
 *
 * Contract address and ABI for the ShadowBallot contract on Sepolia.
 * Update CONTRACT_ADDRESS after deploying with scripts/deploy.cjs.
 */

export const SEPOLIA_CHAIN_ID = 11155111;

// ShadowBallot.sol (the simple, non-Governor contract) — still a placeholder;
// the real deployment (2026-09-03) targeted ShadowBallotGovernor below instead,
// which supersedes it. Not redeployed since it isn't the live path.
export const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * ERC5564Announcer — deployed to Sepolia 2026-09-03 via `scripts/deploy-all-sepolia.cjs`.
 * Real bytecode verified on-chain (`eth_getCode`) at deployment time.
 * See `sepolia-deployment.json` for the full deployment record.
 * Prefer the real canonical singleton (0x55649E01B5Df198D18D95b5cc5051630cfD45564
 * on mainnet/several L2s — verify Sepolia deployment before assuming) over this
 * project-local instance for a real production deployment, so announcements
 * share the real cross-application anonymity set. This address is fine for the
 * dissertation PoC, which is what it's for.
 */
export const ANNOUNCER_ADDRESS = '0x6678E6d570ae92c0bd49bfaAeb035A3C45AbF37a';

/** MockGovernanceToken — real OZ ERC20Votes, deployed to Sepolia 2026-09-03. */
export const GOVERNANCE_TOKEN_ADDRESS = '0xceBA65a3E0F2bB9Ba6e57b70A87D087404015fE6';

/** Groth16Verifier, exported from the real compiled circuit — deployed 2026-09-03. */
export const ELIGIBILITY_VERIFIER_ADDRESS = '0xf86CDC34ec3456dAd0044f405684BB7AfFd6232f';

/**
 * VoterRegistry — deployed 2026-09-03. NOTE: this instance's snapshot block predates
 * the token mint, so nobody can ever register against it (found live, 2026-09-03 —
 * see Ch4 §4.8 / Ch6 §6.6). A corrected VoterRegistry with a post-mint snapshot was
 * redeployed live during that lifecycle run, but VoterRegistry isn't wired into
 * ShadowBallotGovernor directly (the lifecycle doesn't call through it), so this
 * wasn't blocking — the corrected instance's address was only printed to stdout and
 * wasn't captured into a persistent record. This address is stale; don't rely on it
 * for voter registration without redeploying.
 */
export const VOTER_REGISTRY_ADDRESS = '0x5cA7d0dacC3aca48f5fe1C311dE593159bD9bCA6';

/** ShadowBallotGovernor — the real, live deployment target. Deployed 2026-09-03. */
export const SHADOW_BALLOT_GOVERNOR_ADDRESS = '0x144A60a0a237fB55374c59aF2537877f3cc63666';

export const ERC5564_ANNOUNCER_ABI = [
  'function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)',
  'event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)',
] as const;

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

/**
 * Pre-funded demo wallets for Sepolia testnet.
 * TESTNET-ONLY — these private keys are publicly visible. Never use on mainnet.
 * Fund these addresses with Sepolia ETH before a live demo.
 */
export interface DemoWallet {
  label: string;
  privateKey: string; // hex without 0x prefix
  address: string;
}

export const DEMO_WALLETS: DemoWallet[] = [
  {
    label: 'Demo Voter 1',
    privateKey: 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  },
  {
    label: 'Demo Voter 2',
    privateKey: '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  },
  {
    label: 'Demo Voter 3',
    privateKey: '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  },
  {
    label: 'Demo Voter 4',
    privateKey: '7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  },
  {
    label: 'Demo Voter 5',
    privateKey: '47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
    address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  },
];

export const SHADOW_BALLOT_ABI = [
  'function createProposal(string title, uint256 deadline) returns (uint256)',
  'function submitResults(uint256 proposalId, uint256 yesVotes, uint256 noVotes, uint256 abstainVotes)',
  'function getProposal(uint256 proposalId) view returns (string title, uint256 deadline, uint256 yesVotes, uint256 noVotes, uint256 abstainVotes, bool finalized)',
  'function getProposalCount() view returns (uint256)',
  'function coordinator() view returns (address)',
  'event ProposalCreated(uint256 indexed proposalId, string title, uint256 deadline)',
  'event ResultsSubmitted(uint256 indexed proposalId, uint256 yes, uint256 no, uint256 abstain)',
] as const;
