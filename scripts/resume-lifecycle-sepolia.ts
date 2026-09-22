/**
 * Resume the Sepolia lifecycle after the first run's RPC timeout while polling
 * for the voting deadline (2026-09-03) — everything through vote casting and
 * off-chain decode already succeeded and is hardcoded below rather than
 * redone (re-calling propose() with the same description would revert, since
 * that proposal already exists on-chain).
 *
 * Made the block-polling loop retry-tolerant this time — the original script
 * let a single transient RPC timeout kill the whole run after ~7 minutes of
 * real progress, which is exactly the kind of thing worth fixing once found,
 * not just retrying past.
 */
import { JsonRpcProvider, Contract, Wallet } from 'ethers';
import { readFileSync } from 'fs';
import { SHADOW_BALLOT_GOVERNOR_ADDRESS } from '../src/config.js';

const RPC_URLS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.sepolia.org',
  'https://sepolia.gateway.tenderly.co',
];

const PROPOSAL_ID = 84994881702267908979520483918502920280648154599850496314420804866851738210676n;

const DEPLOYER_PRIVATE_KEY = process.env.SHADOWBALLOT_SEPOLIA_DEPLOYER_PRIVATE_KEY;
if (!DEPLOYER_PRIVATE_KEY) {
  console.error('Set SHADOWBALLOT_SEPOLIA_DEPLOYER_PRIVATE_KEY before running.');
  process.exit(1);
}

const GOVERNOR_ABI = [
  'function state(uint256 proposalId) view returns (uint8)',
  'function proposalDeadline(uint256 proposalId) view returns (uint256)',
  'function setEligibilityRoot(uint256 proposalId, bytes32 root)',
  'function registerEligibleNullifier(uint256 proposalId, uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[3] pubSignals)',
  'function submitAnamorphicTally(uint256 proposalId, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, bytes32[] nullifiers)',
  'function proposalVotes(uint256 proposalId) view returns (uint256 against, uint256 forVotes, uint256 abstain)',
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-tolerant block number fetch — rotates RPC endpoints on transient failure. */
async function getBlockNumberResilient(): Promise<number> {
  for (const url of RPC_URLS) {
    try {
      const provider = new JsonRpcProvider(url);
      return await provider.getBlockNumber();
    } catch (err) {
      console.warn(`  (RPC ${url} failed: ${(err as Error).message}, trying next)`);
    }
  }
  throw new Error('All RPC endpoints failed for getBlockNumber');
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URLS[0]);
  const wallet = new Wallet(DEPLOYER_PRIVATE_KEY!, provider);
  const governor = new Contract(SHADOW_BALLOT_GOVERNOR_ADDRESS, GOVERNOR_ABI, wallet);

  const deadline: bigint = await governor.proposalDeadline(PROPOSAL_ID);
  console.log('Deadline block:', deadline.toString());

  let current = await getBlockNumberResilient();
  while (BigInt(current) <= deadline) {
    console.log('  current block', current, '- waiting...');
    await sleep(20_000);
    current = await getBlockNumberResilient();
  }
  console.log('Deadline passed at block', current);

  const realProof = JSON.parse(
    readFileSync(new URL('../circuits/governor_test_calldata.json', import.meta.url), 'utf8')
  );
  const root = '0x' + BigInt(realProof.pubSignals[0]).toString(16).padStart(64, '0');

  console.log('Setting eligibility root...');
  await (await governor.setEligibilityRoot(PROPOSAL_ID, root)).wait();

  console.log('Registering eligible nullifier...');
  await (await governor.registerEligibleNullifier(PROPOSAL_ID, realProof.pA, realProof.pB, realProof.pC, realProof.pubSignals)).wait();

  const nullifier = '0x' + BigInt(realProof.pubSignals[1]).toString(16).padStart(64, '0');
  console.log('Submitting tally (decoded vote was YES -> 1 for, 0 against, 0 abstain)...');
  await (await governor.submitAnamorphicTally(PROPOSAL_ID, 1n, 0n, 0n, [nullifier])).wait();

  const finalState: bigint = await governor.state(PROPOSAL_ID);
  const votes = await governor.proposalVotes(PROPOSAL_ID);
  console.log('\n=== LIFECYCLE COMPLETE (resumed) ===');
  console.log('Final Governor.state():', finalState.toString(), '(4 = Succeeded, 3 = Defeated)');
  console.log('proposalVotes:', votes);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
