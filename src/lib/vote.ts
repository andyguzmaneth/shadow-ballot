/**
 * Vote Encoding & End-to-End Voting Flow
 *
 * Combines anamorphic signatures + stealth addresses into the full
 * Shadow Ballot voting pipeline:
 *
 * castVote: voter generates stealth address, builds 0.001 ETH tx,
 *   signs with anamorphic nonce encoding the vote, broadcasts.
 *
 * decodeVote: coordinator scans for stealth tx, extracts hidden vote
 *   via brute-force over candidate vote encodings.
 *
 * The shared secret for the anamorphic signature is derived from the
 * same ECDH used for stealth addresses — the ephemeral key serves
 * double duty: stealth address generation + vote hiding.
 */

import { Point, etc, getPublicKey } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js';
import { deriveNonceFromSecret } from './anamorphic.js';
import {
  generateStealthAddressFromKeys,
  parseMetaAddress,
} from './stealth.js';
import {
  buildTransaction,
  signTransactionWithCustomK,
  broadcastTransaction,
  getTransactionCount,
  getGasPrices,
  SEPOLIA_CHAIN_ID,
} from './tx.js';
import { Transaction } from 'ethers';
import { utils } from '@noble/secp256k1';

// secp256k1 curve order
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

// Vote choices
export const VOTE_YES = 0x01;
export const VOTE_NO = 0x02;
export const VOTE_ABSTAIN = 0x03;

// Bounds for the randomized cover-transfer value — see sampleVoteValue() below.
// Was a hardcoded 1_000_000_000_000_000n (0.001 ETH) constant until 2026-08-19:
// found while designing the observer-advantage experiment (dissertation Ch5
// §5.2) that a fixed value makes every vote transaction identical in amount —
// a 100%-accurate distinguishing signal an observer could use with zero
// cryptanalysis, regardless of how sound the nonce/signature layer is.
const MIN_VOTE_VALUE_WEI = 100_000_000_000_000n; // 0.0001 ETH
const MAX_VOTE_VALUE_WEI = 10_000_000_000_000_000n; // 0.01 ETH

/**
 * Sample a plausible-looking small ETH transfer amount, log-uniformly within
 * [MIN_VOTE_VALUE_WEI, MAX_VOTE_VALUE_WEI] — log-uniform because real transfer
 * amounts cluster across multiple orders of magnitude, not evenly across a
 * linear range, so a uniform linear sample would itself be a subtler version
 * of the same distinguishing-signal problem. Uses Math.random(), not a CSPRNG
 * — this value is public cover material, not key material, so it doesn't need
 * cryptographic unpredictability, only non-constancy.
 *
 * Caveat, stated honestly: this is an approximation of "looks like an ordinary
 * transfer," not a fit to real measured Ethereum transfer-value distributions
 * — a stretch goal, not done here.
 */
export function sampleVoteValue(): bigint {
  const minLog = Math.log(Number(MIN_VOTE_VALUE_WEI));
  const maxLog = Math.log(Number(MAX_VOTE_VALUE_WEI));
  const sampledLog = minLog + Math.random() * (maxLog - minLog);
  return BigInt(Math.floor(Math.exp(sampledLog)));
}

export type VoteChoice = typeof VOTE_YES | typeof VOTE_NO | typeof VOTE_ABSTAIN;

function bytesToBigint(bytes: Uint8Array): bigint {
  return BigInt('0x' + bytesToHex(bytes));
}

/**
 * Encode a vote as bytes: proposalId (1 byte) + choice (1 byte).
 */
export function encodeVote(proposalId: number, choice: VoteChoice): Uint8Array {
  if (proposalId < 0 || proposalId > 255) {
    throw new Error('proposalId must be 0-255');
  }
  if (![VOTE_YES, VOTE_NO, VOTE_ABSTAIN].includes(choice)) {
    throw new Error('Invalid vote choice');
  }
  return new Uint8Array([proposalId, choice]);
}

/**
 * Decode vote bytes back to proposalId and choice.
 */
export function decodeVoteBytes(data: Uint8Array): { proposalId: number; choice: VoteChoice } {
  return { proposalId: data[0], choice: data[1] as VoteChoice };
}

/**
 * Get human-readable label for a vote choice.
 */
export function choiceLabel(choice: VoteChoice): string {
  switch (choice) {
    case VOTE_YES: return 'YES';
    case VOTE_NO: return 'NO';
    case VOTE_ABSTAIN: return 'ABSTAIN';
    default: return 'UNKNOWN';
  }
}

/**
 * Build the candidate set for vote extraction.
 * For N proposal IDs, generates 3N candidates (YES/NO/ABSTAIN for each).
 */
export function buildCandidateSet(proposalIds: number[]): Uint8Array[] {
  const candidates: Uint8Array[] = [];
  for (const pid of proposalIds) {
    candidates.push(encodeVote(pid, VOTE_YES));
    candidates.push(encodeVote(pid, VOTE_NO));
    candidates.push(encodeVote(pid, VOTE_ABSTAIN));
  }
  return candidates;
}

/**
 * Domain tag for the anamorphic nonce-key derivation. Deliberately distinct from
 * stealth.ts's DOMAIN_STEALTH_ADDR (0x01) — both start from the same raw ECDH point,
 * but must diverge into cryptographically separated values before either is used
 * (dissertation Ch3, finding #7 from the 2026-08-17 adversarial review; previously
 * both uses shared one untagged keccak256(point) value).
 */
const DOMAIN_NONCE_KEY = new Uint8Array([0x02]);

/**
 * Derive the ECDH shared secret between an ephemeral key and the coordinator's viewing key,
 * domain-separated (tag 0x02) for use as the anamorphic nonce key specifically — NOT reusable
 * as the stealth-address offset, which uses a different tag (stealth.ts, DOMAIN_STEALTH_ADDR).
 *
 * Sender side: nonceKey = keccak256(0x02 || ephemeralPrivKey * viewingPubKey)
 */
function deriveSharedSecret(
  ephemeralPrivKey: Uint8Array,
  viewingPubKey: Uint8Array
): Uint8Array {
  const viewingPoint = Point.fromHex(bytesToHex(viewingPubKey));
  const sharedSecretPoint = viewingPoint.multiply(bytesToBigint(ephemeralPrivKey));
  return keccak_256(concatBytes(DOMAIN_NONCE_KEY, sharedSecretPoint.toBytes(true)));
}

/**
 * Derive the ECDH shared secret from the coordinator side, same domain tag as above.
 * Coordinator side: nonceKey = keccak256(0x02 || viewingPrivKey * ephemeralPubKey)
 */
function deriveSharedSecretCoordinator(
  viewingPrivKey: Uint8Array,
  ephemeralPubKey: Uint8Array
): Uint8Array {
  const ephemeralPoint = Point.fromHex(bytesToHex(ephemeralPubKey));
  const sharedSecretPoint = ephemeralPoint.multiply(bytesToBigint(viewingPrivKey));
  return keccak_256(concatBytes(DOMAIN_NONCE_KEY, sharedSecretPoint.toBytes(true)));
}

export interface CastVoteResult {
  txHash: string;
  signedTxHex: string;
  ephemeralPubKey: Uint8Array;
  stealthAddress: string;
  r: string;
  s: string;
}

/**
 * Cast a vote: full pipeline from vote encoding to signed transaction.
 *
 * 1. Generate ephemeral key pair
 * 2. Derive shared secret via ECDH (ephemeralPriv * coordinatorViewingPub)
 * 3. Generate stealth address for the coordinator
 * 4. Encode the vote as hidden message
 * 5. Build a 0.001 ETH transfer to the stealth address
 * 6. Sign with anamorphic nonce encoding the vote
 * 7. Broadcast and return result
 */
export async function castVote(
  voterPrivKey: Uint8Array,
  coordinatorMetaAddress: string,
  proposalId: number,
  choice: VoteChoice
): Promise<CastVoteResult> {
  console.log(`[castVote] Casting vote: proposal=${proposalId}, choice=${choiceLabel(choice)}`);

  // 1. Generate ephemeral key pair
  const ephemeralPrivKey = utils.randomSecretKey();
  const ephemeralPubKey = getPublicKey(ephemeralPrivKey, true);
  console.log(`[castVote] Ephemeral pubkey: ${bytesToHex(ephemeralPubKey)}`);

  // 2. Generate stealth address (also derives shared secret internally)
  const { viewingPubKey } = parseMetaAddress(coordinatorMetaAddress);
  const stealthResult = generateStealthAddressFromKeys(coordinatorMetaAddress, ephemeralPrivKey);
  console.log(`[castVote] Stealth address: ${stealthResult.stealthAddress}`);

  // 3. Derive shared secret for anamorphic nonce (same ECDH as stealth)
  const sharedSecret = deriveSharedSecret(ephemeralPrivKey, viewingPubKey);

  // 4. Encode the vote
  const voteData = encodeVote(proposalId, choice);

  // 5. Get voter address and nonce
  const voterPubKey = getPublicKey(voterPrivKey, true);
  const voterPoint = Point.fromHex(bytesToHex(voterPubKey));
  const voterUncompressed = voterPoint.toBytes(false);
  const voterAddrHash = keccak_256(voterUncompressed.slice(1));
  const voterAddress = '0x' + bytesToHex(voterAddrHash.slice(12));
  console.log(`[castVote] Voter address: ${voterAddress}`);

  const nonce = await getTransactionCount(voterAddress);
  console.log(`[castVote] Voter nonce: ${nonce}`);

  // 6. Build the transaction — real network-derived gas fees (via getGasPrices,
  // which reflects the actual current base fee) rather than a fixed constant,
  // for the same reason the vote value is now sampled rather than fixed
  // (2026-08-19, see MIN/MAX_VOTE_VALUE_WEI above): a hardcoded fee on every
  // vote is a distinguishing signal, real network fees vary naturally on their
  // own so this is the online path's equivalent fix.
  const gasFees = await getGasPrices();
  const unsignedTx = buildTransaction(
    voterAddress,
    stealthResult.stealthAddress,
    sampleVoteValue(),
    nonce,
    SEPOLIA_CHAIN_ID,
    gasFees
  );

  // 7. Derive the anamorphic nonce k from shared secret + vote data
  // The "public message" for the KDF is the unsigned tx hash
  const ethTx = Transaction.from({
    to: unsignedTx.to,
    value: unsignedTx.value,
    nonce: unsignedTx.nonce,
    chainId: unsignedTx.chainId,
    type: unsignedTx.type,
    maxFeePerGas: unsignedTx.maxFeePerGas,
    maxPriorityFeePerGas: unsignedTx.maxPriorityFeePerGas,
    gasLimit: unsignedTx.gasLimit,
  });
  const txDigest = hexToBytes(ethTx.unsignedHash.slice(2));
  const customK = deriveNonceFromSecret(sharedSecret, txDigest, voteData);

  // 8. Sign with the custom k
  const { signedTxHex, txHash, r, s } = signTransactionWithCustomK(
    unsignedTx,
    voterPrivKey,
    customK
  );
  console.log(`[castVote] Signed tx hash: ${txHash}`);

  // 9. Broadcast
  const broadcastedHash = await broadcastTransaction(signedTxHex);
  console.log(`[castVote] Broadcasted! Hash: ${broadcastedHash}`);

  return {
    txHash: broadcastedHash,
    signedTxHex,
    ephemeralPubKey,
    stealthAddress: stealthResult.stealthAddress,
    r,
    s,
  };
}

/**
 * Cast a vote without broadcasting (for testing / offline signing).
 * Returns the signed tx and all metadata needed for decoding.
 */
export function castVoteOffline(
  voterPrivKey: Uint8Array,
  coordinatorMetaAddress: string,
  proposalId: number,
  choice: VoteChoice,
  ephemeralPrivKey: Uint8Array,
  nonce: number = 0
): CastVoteResult & { unsignedTxHash: Uint8Array } {
  const ephemeralPubKey = getPublicKey(ephemeralPrivKey, true);
  const { viewingPubKey } = parseMetaAddress(coordinatorMetaAddress);
  const stealthResult = generateStealthAddressFromKeys(coordinatorMetaAddress, ephemeralPrivKey);
  const sharedSecret = deriveSharedSecret(ephemeralPrivKey, viewingPubKey);
  const voteData = encodeVote(proposalId, choice);

  // Voter address
  const voterPubKey = getPublicKey(voterPrivKey, true);
  const voterPoint = Point.fromHex(bytesToHex(voterPubKey));
  const voterUncompressed = voterPoint.toBytes(false);
  const voterAddrHash = keccak_256(voterUncompressed.slice(1));
  const voterAddress = '0x' + bytesToHex(voterAddrHash.slice(12));

  const unsignedTx = buildTransaction(
    voterAddress,
    stealthResult.stealthAddress,
    sampleVoteValue(),
    nonce
  );

  // Derive the anamorphic nonce k
  const ethTx = Transaction.from({
    to: unsignedTx.to,
    value: unsignedTx.value,
    nonce: unsignedTx.nonce,
    chainId: unsignedTx.chainId,
    type: unsignedTx.type,
    maxFeePerGas: unsignedTx.maxFeePerGas,
    maxPriorityFeePerGas: unsignedTx.maxPriorityFeePerGas,
    gasLimit: unsignedTx.gasLimit,
  });
  const txDigest = hexToBytes(ethTx.unsignedHash.slice(2));
  const customK = deriveNonceFromSecret(sharedSecret, txDigest, voteData);

  const { signedTxHex, txHash, r, s } = signTransactionWithCustomK(
    unsignedTx,
    voterPrivKey,
    customK
  );

  return {
    txHash,
    signedTxHex,
    ephemeralPubKey,
    stealthAddress: stealthResult.stealthAddress,
    r,
    s,
    unsignedTxHash: txDigest,
  };
}

export interface DecodedVote {
  proposalId: number;
  choice: VoteChoice;
  choiceLabel: string;
}

/**
 * Decode a hidden vote from a transaction signature.
 *
 * Coordinator side:
 * 1. Verify the tx was sent to a stealth address we control
 * 2. Derive shared secret: viewingPrivKey * ephemeralPubKey
 * 3. Brute-force extract: for each candidate vote, derive k, check if r matches
 */
export function decodeVote(
  coordinatorViewingKey: Uint8Array,
  _coordinatorSpendingPubKey: Uint8Array,
  ephemeralPubKey: Uint8Array,
  signatureR: string,
  unsignedTxHash: Uint8Array,
  proposalIds: number[]
): DecodedVote | null {
  console.log(`[decodeVote] Attempting to decode vote from r=${signatureR.slice(0, 16)}...`);

  // 1. Derive shared secret (coordinator side)
  const sharedSecret = deriveSharedSecretCoordinator(coordinatorViewingKey, ephemeralPubKey);

  // 2. Build candidate set
  const candidates = buildCandidateSet(proposalIds);

  // 3. Brute-force: try each candidate, derive k, compute r, check match
  for (const candidate of candidates) {
    const k = deriveNonceFromSecret(sharedSecret, unsignedTxHash, candidate);
    const point = Point.BASE.multiply(k);
    const r = etc.mod(point.toAffine().x, N);
    const rHex = r.toString(16).padStart(64, '0');

    if (rHex === signatureR) {
      const decoded = decodeVoteBytes(candidate);
      console.log(`[decodeVote] Decoded: proposal=${decoded.proposalId}, choice=${choiceLabel(decoded.choice)}`);
      return {
        proposalId: decoded.proposalId,
        choice: decoded.choice,
        choiceLabel: choiceLabel(decoded.choice),
      };
    }
  }

  console.log('[decodeVote] No matching vote found in candidate set');
  return null;
}
