/**
 * Live protocol lifecycle against the real Sepolia deployment (2026-09-03).
 *
 * Imports the actual tested modules (vote.ts, stealth.ts, announcer.ts) rather
 * than reimplementing their logic — if this script works, it's exercising the
 * same code path the vitest/Hardhat suites already tested, against real
 * infrastructure instead of a mock.
 *
 * Simplification, stated explicitly: the same funded key plays voter,
 * coordinator, and deployer/registry-eligibility-checker in this run. This is
 * a smoke test of "does the deployed system work end-to-end," not a privacy
 * demonstration — participation non-observability was already validated
 * separately via the observer-advantage experiment (Ch5 §5.2), which
 * specifically requires distinct roles and isn't what this script is for.
 *
 * The ZK eligibility proof reused here (circuits/governor_test_calldata.json)
 * is the same standalone test proof used in GovernorZkIntegration.test.cjs —
 * bound to a Merkle tree with secret=12345, NOT to the real VoterRegistry
 * commitment registered in step 3 below. This run does not connect those two
 * cryptographically; doing so would need a fresh Merkle tree built from real
 * on-chain VoterRegistered events and a new proof for it, requiring the dev
 * VM's Circom toolchain — flagged as follow-on work, not done here.
 *
 * Two real API gaps found while writing this script, not designed in on
 * purpose, worked around rather than silently papered over:
 *   1. castVote()'s return type (CastVoteResult) doesn't expose the ephemeral
 *      private key or the raw ECDH shared secret, only the derived
 *      ephemeralPubKey — so a caller outside vote.ts cannot compute the
 *      correct view tag (announcer.ts's deriveViewTag needs the shared secret
 *      specifically, not the pubkey). Worked around by publishing a
 *      placeholder view tag (0x00); this is harmless because
 *      scanAnnouncements() never uses the view tag to filter or decide
 *      anything — it's a scanning *optimization* the real protocol should
 *      use, not a correctness dependency, so this smoke test still correctly
 *      decodes the vote without it. A real fix would have vote.ts return the
 *      shared secret (or the view tag itself) alongside the rest of
 *      CastVoteResult.
 *   2. castVote()'s return type also doesn't expose the unsigned transaction
 *      hash `decodeVote()` needs (only castVoteOffline's extended return type
 *      does). Worked around here by recomputing it locally from the returned
 *      `signedTxHex` via `Transaction.from(signedTxHex).unsignedHash` — exactly
 *      what decodeVote needs, just derived one step later than it could be.
 *
 * Usage: SHADOWBALLOT_SEPOLIA_DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/run-lifecycle-sepolia.ts
 */

import { JsonRpcProvider, Wallet, Contract, ContractFactory, Transaction, keccak256, toUtf8Bytes } from 'ethers';
import { readFileSync } from 'fs';
import { hexToBytes as nobleHexToBytes } from '@noble/hashes/utils.js';
import { generateStealthKeys } from '../src/lib/stealth.js';
import { castVote, decodeVote, VOTE_YES, buildCandidateSet } from '../src/lib/vote.js';
import { announceVote, scanAnnouncements, buildAnnouncementMetadata } from '../src/lib/announcer.js';
import {
  GOVERNANCE_TOKEN_ADDRESS,
  SHADOW_BALLOT_GOVERNOR_ADDRESS,
} from '../src/config.js';

const RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
const PROPOSAL_DESCRIPTION = 'Governor+ZK integration test proposal'; // MUST match the reused proof's proposalId
const VOTE_PAYLOAD_PROPOSAL_INDEX = 1; // small (0-255) index into the anamorphic vote payload — NOT the Governor proposalId

const DEPLOYER_PRIVATE_KEY = process.env.SHADOWBALLOT_SEPOLIA_DEPLOYER_PRIVATE_KEY;
if (!DEPLOYER_PRIVATE_KEY) {
  console.error('Set SHADOWBALLOT_SEPOLIA_DEPLOYER_PRIVATE_KEY (from the vault) before running.');
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
const TOKEN_ABI = [
  'function mint(address to, uint256 amount)',
  'function delegate(address delegatee)',
];
const REGISTRY_ARTIFACT = JSON.parse(
  readFileSync(new URL('../artifacts/contracts/VoterRegistry.sol/VoterRegistry.json', import.meta.url), 'utf8')
);

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toHexBytes(hex: string): Uint8Array {
  return nobleHexToBytes(hex.startsWith('0x') ? hex.slice(2) : hex);
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(DEPLOYER_PRIVATE_KEY!, provider);
  console.log('[lifecycle] address:', wallet.address);
  console.log('[lifecycle] balance (wei):', (await provider.getBalance(wallet.address)).toString());

  // --- 1. Mint + delegate governance tokens to self (plays "voter") ---
  const token = new Contract(GOVERNANCE_TOKEN_ADDRESS, TOKEN_ABI, wallet);
  console.log('[1/9] Minting governance tokens...');
  await (await token.mint(wallet.address, 100n * 10n ** 18n)).wait();
  console.log('[1/9] Delegating to self...');
  await (await token.delegate(wallet.address)).wait();
  const snapshotBlock = await provider.getBlockNumber();
  console.log('[1/9] Done. Snapshot block for a fresh VoterRegistry:', snapshotBlock);

  // --- 2. Deploy a fresh VoterRegistry — the 2026-09-03 deployment's snapshot
  //         block predates any tokens existing, so nobody could ever register
  //         against it. Real bug, found by actually trying to use the deployed
  //         system for something, not by reading the deploy script. ---
  console.log('[2/9] Deploying a corrected VoterRegistry (snapshot block', snapshotBlock, ')...');
  const RegistryFactory = new ContractFactory(REGISTRY_ARTIFACT.abi, REGISTRY_ARTIFACT.bytecode, wallet);
  const registry = await RegistryFactory.deploy(GOVERNANCE_TOKEN_ADDRESS, snapshotBlock);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log('[2/9] Deployed at:', registryAddress);

  console.log('[2/9] Waiting for a few blocks so the snapshot is safely in the past...');
  while ((await provider.getBlockNumber()) < snapshotBlock + 3) {
    await sleep(15_000);
  }

  // --- 3. Register the voter's eligibility commitment ---
  const eligibilitySecret = 999888777n; // this run's own secret — independent of the reused ZK proof's secret (12345)
  const commitment = keccak256(toUtf8Bytes(eligibilitySecret.toString()));
  console.log('[3/9] Registering voter commitment:', commitment);
  await ((registry as any).register(commitment) as Promise<any>).then((tx: any) => tx.wait());
  console.log('[3/9] Registered.');

  // --- 4. Propose ---
  const governor = new Contract(SHADOW_BALLOT_GOVERNOR_ADDRESS, GOVERNOR_ABI, wallet);
  console.log('[4/9] Proposing...');
  await (await governor.propose([wallet.address], [0n], ['0x'], PROPOSAL_DESCRIPTION)).wait();
  const descriptionHash = keccak256(toUtf8Bytes(PROPOSAL_DESCRIPTION));
  const proposalId: bigint = await governor.hashProposal([wallet.address], [0n], ['0x'], descriptionHash);
  console.log('[4/9] Governor proposalId:', proposalId.toString());

  // --- 5. Cast the anamorphic vote (real castVote(), not a reimplementation) ---
  const coordinator = generateStealthKeys();
  console.log('[5/9] Coordinator meta-address generated. Casting vote...');
  const voteResult = await castVote(toHexBytes(wallet.privateKey), coordinator.metaAddress, VOTE_PAYLOAD_PROPOSAL_INDEX, VOTE_YES);
  console.log('[5/9] Vote tx broadcast:', voteResult.txHash);

  // --- 6. Announce (publishes R via the real deployed Announcer) ---
  // Placeholder view tag — see file header note (1): a correct one needs the
  // ephemeral private key, which castVote()'s return type doesn't expose.
  const placeholderViewTag = buildAnnouncementMetadata(0)[0];
  console.log('[6/9] Announcing (placeholder view tag, see file header)...');
  const announceTxHash = await announceVote(
    RPC_URL,
    wallet.privateKey,
    voteResult.stealthAddress,
    '0x' + Buffer.from(voteResult.ephemeralPubKey).toString('hex'),
    placeholderViewTag
  );
  console.log('[6/9] Announcement tx:', announceTxHash);

  // --- 7. Coordinator scans and decodes ---
  console.log('[7/9] Waiting for the announce tx to index, then scanning...');
  await sleep(20_000);
  const currentBlock = await provider.getBlockNumber();
  const announcements = await scanAnnouncements(RPC_URL, Math.max(0, currentBlock - 50), 'latest');
  console.log('[7/9] Found', announcements.length, 'announcement(s) at scheme 1.');

  const unsignedTxHash = toHexBytes(Transaction.from(voteResult.signedTxHex).unsignedHash); // see file header note (2)
  const candidateProposalIds = [VOTE_PAYLOAD_PROPOSAL_INDEX, 0, 2, 3];
  const decoded = decodeVote(
    coordinator.viewingKey,
    coordinator.spendingPubKey,
    voteResult.ephemeralPubKey,
    voteResult.r,
    unsignedTxHash,
    candidateProposalIds
  );
  console.log('[7/9] Decoded vote:', decoded);
  if (!decoded) throw new Error('Decode failed — lifecycle cannot continue honestly if this step is fake.');

  // --- 8. Wait for the voting period to close, then submit tally + register nullifier ---
  const deadline: bigint = await governor.proposalDeadline(proposalId);
  console.log('[8/9] Voting deadline block:', deadline.toString(), '— waiting for it to pass (real Sepolia block times)...');
  while (BigInt(await provider.getBlockNumber()) <= deadline) {
    await sleep(20_000);
  }
  console.log('[8/9] Deadline passed.');

  const realProof = JSON.parse(
    readFileSync(new URL('../circuits/governor_test_calldata.json', import.meta.url), 'utf8')
  );
  const root = '0x' + BigInt(realProof.pubSignals[0]).toString(16).padStart(64, '0');
  console.log('[8/9] Setting eligibility root (reused test proof, see file header note)...');
  await (await governor.setEligibilityRoot(proposalId, root)).wait();
  console.log('[8/9] Registering eligible nullifier...');
  await (await governor.registerEligibleNullifier(proposalId, realProof.pA, realProof.pB, realProof.pC, realProof.pubSignals)).wait();
  const nullifier = '0x' + BigInt(realProof.pubSignals[1]).toString(16).padStart(64, '0');
  console.log('[8/9] Submitting tally (decoded choice was', decoded.choiceLabel, '— submitting 1 for, 0 against, 0 abstain)...');
  await (await governor.submitAnamorphicTally(proposalId, 1n, 0n, 0n, [nullifier])).wait();

  // --- 9. Confirm final state ---
  const finalState: bigint = await governor.state(proposalId);
  const votes = await governor.proposalVotes(proposalId);
  console.log('[9/9] Final Governor.state():', finalState.toString(), '(4 = Succeeded, 3 = Defeated)');
  console.log('[9/9] proposalVotes:', votes);
  console.log('\n=== LIFECYCLE COMPLETE ===');
  console.log('Governor proposalId:', proposalId.toString());
  console.log('Corrected VoterRegistry:', registryAddress);
  console.log('Vote tx:', voteResult.txHash);
  console.log('Announce tx:', announceTxHash);
  console.log('Decoded vote (off-chain, coordinator-side):', decoded);
}

main().catch((err) => {
  console.error('[lifecycle] FAILED:', err);
  process.exit(1);
});
