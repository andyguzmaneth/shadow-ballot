/**
 * Corrects a bug in the first lifecycle run (2026-09-03): propose() was called
 * with [wallet.address] as the target instead of [ethers.ZeroAddress], which
 * changes the resulting proposalId hash so it no longer matches the reused
 * ZK proof's embedded proposalId — Governor's ProposalIdMismatch error caught
 * this correctly at registerEligibleNullifier time. That proposal (the first
 * one, id ...851738210676) is abandoned, not fixable in place; this script
 * creates a fresh, correctly-parameterized proposal and runs the rest of the
 * lifecycle against it. Voter registration from the first run still stands —
 * VoterRegistry isn't wired into Governor directly, so nothing there needs redoing.
 */
import { JsonRpcProvider, Wallet, Contract, Transaction, keccak256, toUtf8Bytes, ZeroAddress } from 'ethers';
import { readFileSync } from 'fs';
import { hexToBytes as nobleHexToBytes } from '@noble/hashes/utils.js';
import { generateStealthKeys } from '../src/lib/stealth.js';
import { castVote, decodeVote, VOTE_YES } from '../src/lib/vote.js';
import { announceVote, scanAnnouncements, buildAnnouncementMetadata } from '../src/lib/announcer.js';
import { SHADOW_BALLOT_GOVERNOR_ADDRESS } from '../src/config.js';

const RPC_URLS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.sepolia.org',
  'https://sepolia.gateway.tenderly.co',
];
const PROPOSAL_DESCRIPTION = 'Governor+ZK integration test proposal'; // matches the reused proof's proposalId, WITH the correct targets below

const DEPLOYER_PRIVATE_KEY = process.env.SHADOWBALLOT_SEPOLIA_DEPLOYER_PRIVATE_KEY;
if (!DEPLOYER_PRIVATE_KEY) {
  console.error('Set SHADOWBALLOT_SEPOLIA_DEPLOYER_PRIVATE_KEY before running.');
  process.exit(1);
}

const GOVERNOR_ABI = [
  'function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)',
  'function hashProposal(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) view returns (uint256)',
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
function toHexBytes(hex: string): Uint8Array {
  return nobleHexToBytes(hex.startsWith('0x') ? hex.slice(2) : hex);
}
async function getBlockNumberResilient(): Promise<number> {
  for (const url of RPC_URLS) {
    try {
      return await new JsonRpcProvider(url).getBlockNumber();
    } catch (err) {
      console.warn(`  (RPC ${url} failed, trying next)`);
    }
  }
  throw new Error('All RPC endpoints failed');
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URLS[0]);
  const wallet = new Wallet(DEPLOYER_PRIVATE_KEY!, provider);
  const governor = new Contract(SHADOW_BALLOT_GOVERNOR_ADDRESS, GOVERNOR_ABI, wallet);

  console.log('[1/7] Proposing with the CORRECT target (ZeroAddress, matching the reused proof)...');
  await (await governor.propose([ZeroAddress], [0n], ['0x'], PROPOSAL_DESCRIPTION)).wait();
  const descriptionHash = keccak256(toUtf8Bytes(PROPOSAL_DESCRIPTION));
  const proposalId: bigint = await governor.hashProposal([ZeroAddress], [0n], ['0x'], descriptionHash);
  console.log('[1/7] proposalId:', proposalId.toString());
  console.log('[1/7] Expected to match reused proof pubSignals[2] (reduced): 12280267269118964162074120570471313527636478466938788729469457698995197180351');

  const coordinator = generateStealthKeys();
  console.log('[2/7] Casting vote...');
  const voteResult = await castVote(toHexBytes(wallet.privateKey), coordinator.metaAddress, 1, VOTE_YES);
  console.log('[2/7] Vote tx:', voteResult.txHash);

  console.log('[3/7] Announcing...');
  const placeholderViewTag = buildAnnouncementMetadata(0)[0];
  const announceTxHash = await announceVote(
    RPC_URLS[0],
    wallet.privateKey,
    voteResult.stealthAddress,
    '0x' + Buffer.from(voteResult.ephemeralPubKey).toString('hex'),
    placeholderViewTag
  );
  console.log('[3/7] Announce tx:', announceTxHash);

  console.log('[4/7] Scanning + decoding...');
  await sleep(20_000);
  const currentBlock = await getBlockNumberResilient();
  const announcements = await scanAnnouncements(RPC_URLS[0], Math.max(0, currentBlock - 20), 'latest');
  console.log('[4/7] Found', announcements.length, 'announcement(s).');
  const unsignedTxHash = toHexBytes(Transaction.from(voteResult.signedTxHex).unsignedHash);
  const decoded = decodeVote(coordinator.viewingKey, coordinator.spendingPubKey, voteResult.ephemeralPubKey, voteResult.r, unsignedTxHash, [1, 0, 2, 3]);
  console.log('[4/7] Decoded:', decoded);
  if (!decoded) throw new Error('Decode failed.');

  const deadline: bigint = await governor.proposalDeadline(proposalId);
  console.log('[5/7] Deadline block:', deadline.toString(), '- waiting...');
  let current = await getBlockNumberResilient();
  while (BigInt(current) <= deadline) {
    console.log('  current block', current);
    await sleep(20_000);
    current = await getBlockNumberResilient();
  }
  console.log('[5/7] Deadline passed at block', current);

  const realProof = JSON.parse(readFileSync(new URL('../circuits/governor_test_calldata.json', import.meta.url), 'utf8'));
  const root = '0x' + BigInt(realProof.pubSignals[0]).toString(16).padStart(64, '0');
  console.log('[6/7] Setting eligibility root + registering nullifier...');
  await (await governor.setEligibilityRoot(proposalId, root)).wait();
  await (await governor.registerEligibleNullifier(proposalId, realProof.pA, realProof.pB, realProof.pC, realProof.pubSignals)).wait();
  const nullifier = '0x' + BigInt(realProof.pubSignals[1]).toString(16).padStart(64, '0');

  console.log('[7/7] Submitting tally (decoded choice:', decoded.choiceLabel, ')...');
  await (await governor.submitAnamorphicTally(proposalId, 1n, 0n, 0n, [nullifier])).wait();

  const finalState: bigint = await governor.state(proposalId);
  const votes = await governor.proposalVotes(proposalId);
  console.log('\n=== LIFECYCLE COMPLETE ===');
  console.log('proposalId:', proposalId.toString());
  console.log('Final state:', finalState.toString(), '(4 = Succeeded, 3 = Defeated)');
  console.log('proposalVotes:', votes);
  console.log('vote tx:', voteResult.txHash);
  console.log('announce tx:', announceTxHash);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
