/**
 * ShadowBallot Contract Helpers
 *
 * Provides typed functions for interacting with the ShadowBallot contract
 * on Sepolia: creating proposals, submitting results, and reading state.
 *
 * Uses ethers.js v6 Contract with the human-readable ABI from config.
 */

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { CONTRACT_ADDRESS, SHADOW_BALLOT_ABI } from '../config.js';

// Sepolia public RPC endpoints (same as tx.ts)
const SEPOLIA_RPC_URLS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.sepolia.org',
  'https://sepolia.gateway.tenderly.co',
];

export interface ProposalData {
  title: string;
  deadline: bigint;
  yesVotes: bigint;
  noVotes: bigint;
  abstainVotes: bigint;
  finalized: boolean;
}

/**
 * Get a JsonRpcProvider connected to Sepolia, trying multiple endpoints.
 */
function getProvider(): JsonRpcProvider {
  return new JsonRpcProvider(SEPOLIA_RPC_URLS[0]);
}

/**
 * Get a read-only contract instance.
 */
function getReadContract(): Contract {
  const provider = getProvider();
  return new Contract(CONTRACT_ADDRESS, SHADOW_BALLOT_ABI, provider);
}

/**
 * Get a writable contract instance using the coordinator's private key.
 */
function getWriteContract(privateKey: string): Contract {
  const provider = getProvider();
  const wallet = new Wallet(privateKey, provider);
  return new Contract(CONTRACT_ADDRESS, SHADOW_BALLOT_ABI, wallet);
}

/**
 * Create a new proposal. Only callable by the coordinator.
 * Returns the transaction hash.
 */
export async function createProposal(
  coordinatorPrivKey: string,
  title: string,
  deadline: bigint,
): Promise<{ txHash: string; proposalId: bigint }> {
  const contract = getWriteContract(coordinatorPrivKey);
  const tx = await contract.createProposal(title, deadline);
  console.log(`[contract] createProposal tx sent: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`[contract] createProposal confirmed in block ${receipt.blockNumber}`);

  // Parse ProposalCreated event to get proposalId
  const event = receipt.logs
    .map((log: { topics: string[]; data: string }) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((e: { name: string } | null) => e?.name === 'ProposalCreated');

  const proposalId = event ? BigInt(event.args[0]) : 0n;
  return { txHash: tx.hash, proposalId };
}

/**
 * Submit aggregated voting results for a proposal. Only callable by the coordinator.
 * Returns the transaction hash.
 */
export async function submitResults(
  coordinatorPrivKey: string,
  proposalId: bigint,
  yesVotes: bigint,
  noVotes: bigint,
  abstainVotes: bigint,
): Promise<string> {
  const contract = getWriteContract(coordinatorPrivKey);
  const tx = await contract.submitResults(proposalId, yesVotes, noVotes, abstainVotes);
  console.log(`[contract] submitResults tx sent: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`[contract] submitResults confirmed in block ${receipt.blockNumber}`);

  return tx.hash as string;
}

/**
 * Get a proposal by ID from the contract.
 */
export async function getProposal(proposalId: bigint): Promise<ProposalData> {
  const contract = getReadContract();
  const [title, deadline, yesVotes, noVotes, abstainVotes, finalized] =
    await contract.getProposal(proposalId);

  return {
    title: title as string,
    deadline: BigInt(deadline),
    yesVotes: BigInt(yesVotes),
    noVotes: BigInt(noVotes),
    abstainVotes: BigInt(abstainVotes),
    finalized: finalized as boolean,
  };
}

/**
 * Get the total number of proposals.
 */
export async function getProposalCount(): Promise<bigint> {
  const contract = getReadContract();
  const count = await contract.getProposalCount();
  return BigInt(count);
}

/**
 * Get the coordinator address from the contract.
 */
export async function getCoordinatorAddress(): Promise<string> {
  const contract = getReadContract();
  return (await contract.coordinator()) as string;
}
