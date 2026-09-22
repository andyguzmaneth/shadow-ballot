/**
 * Observer-advantage experiment (dissertation Ch5 §5.2).
 *
 * Empirically tests the claim Ch3 §3.6.4a only proves on paper: that an
 * observer watching the chain cannot distinguish anamorphic vote transactions
 * from ordinary transfers. The proof sketch is specifically about the
 * signature nonce — it says nothing about other transaction fields. This
 * module deliberately isolates the nonce as the ONLY difference between the
 * two groups it compares: both groups use the exact same value-sampling and
 * fee-sampling functions (sampleVoteValue, sampleGasFees), the same gas limit,
 * the same chain ID, and go to freshly-generated addresses. The only thing
 * that differs is whether the signature nonce is the anamorphic construction
 * (vote.ts's deriveNonceFromSecret) or standard RFC 6979 (ethers' default
 * Wallet signing). If the theoretical proof holds, no feature — including the
 * signature itself — should let a distinguisher beat 50/50.
 *
 * Found and fixed BEFORE this experiment could give a meaningful result
 * (2026-08-19): the vote transaction value and gas fees were both hardcoded
 * constants until this session, which would have made the experiment trivial
 * and uninteresting (100% distinguishable on value/fees alone, saying nothing
 * about the actual cryptographic claim). See vote.ts/tx.ts change history.
 */

import { Wallet, Transaction } from 'ethers';
import { utils, getPublicKey, Point, etc } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { castVoteOffline, VOTE_YES, VOTE_NO, VOTE_ABSTAIN, type VoteChoice } from './vote.js';
import { generateStealthKeys } from './stealth.js';
import { buildTransaction, sampleGasFees } from './tx.js';
import { sampleVoteValue } from './vote.js';

const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const VOTE_CHOICES: VoteChoice[] = [VOTE_YES, VOTE_NO, VOTE_ABSTAIN];

function randomAddress(): string {
  const privKey = utils.randomSecretKey();
  const pubKey = getPublicKey(privKey, true);
  const point = Point.fromHex(bytesToHex(pubKey));
  const uncompressed = point.toBytes(false);
  const hash = keccak_256(uncompressed.slice(1));
  return '0x' + bytesToHex(hash.slice(12));
}

/**
 * Generate `n` real anamorphic vote transactions (signed hex strings),
 * exercising the actual castVoteOffline() pipeline — not a simulation of it.
 */
export function generateVoteSamples(n: number): string[] {
  const coordinator = generateStealthKeys();
  const samples: string[] = [];
  for (let i = 0; i < n; i++) {
    const voterPrivKey = utils.randomSecretKey();
    const ephemeralPrivKey = utils.randomSecretKey();
    const choice = VOTE_CHOICES[i % VOTE_CHOICES.length];
    const result = castVoteOffline(voterPrivKey, coordinator.metaAddress, i % 10, choice, ephemeralPrivKey);
    samples.push(result.signedTxHex);
  }
  return samples;
}

/**
 * Generate `n` "ordinary" control transactions — same value/fee sampling,
 * same gas limit, same chain, a fresh random recipient each time, but signed
 * with ethers' default (RFC 6979) signer instead of the anamorphic nonce.
 * This isolates the nonce-derivation method as the only experimental variable.
 */
export async function generateControlSamples(n: number): Promise<string[]> {
  const samples: string[] = [];
  for (let i = 0; i < n; i++) {
    const privKeyBytes = utils.randomSecretKey();
    const privKeyHex = '0x' + bytesToHex(privKeyBytes);
    const wallet = new Wallet(privKeyHex);
    const to = randomAddress();
    const fees = sampleGasFees();

    // signTransaction() directly, not populateTransaction() — every field is
    // already specified explicitly, and populateTransaction() requires a
    // connected network provider (to fill in anything missing) that this
    // offline experiment deliberately doesn't have, same as castVoteOffline().
    const signed = await wallet.signTransaction({
      to,
      value: sampleVoteValue(),
      nonce: 0,
      chainId: 11155111,
      type: 2,
      gasLimit: 21_000n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    samples.push(signed);
  }
  return samples;
}

export interface TxFeatures {
  value: number;
  maxFeePerGas: number;
  maxPriorityFeePerGas: number;
  rFirstByte: number;
  rParity: number;
  rTopBit: number;
  sFirstByte: number;
  sBelowHalfN: number; // should be 1 for both groups (EIP-2 low-s), a sanity-check feature
}

export function extractFeatures(signedTxHex: string): TxFeatures {
  const tx = Transaction.from(signedTxHex);
  const sig = tx.signature!;
  const rBytes = hexToBytes(sig.r.slice(2));
  const sBytes = hexToBytes(sig.s.slice(2));
  const sValue = BigInt(sig.s);

  return {
    value: Number(tx.value),
    maxFeePerGas: Number(tx.maxFeePerGas ?? 0n),
    maxPriorityFeePerGas: Number(tx.maxPriorityFeePerGas ?? 0n),
    rFirstByte: rBytes[0],
    rParity: rBytes[31] % 2,
    rTopBit: rBytes[0] >> 7,
    sFirstByte: sBytes[0],
    sBelowHalfN: sValue <= N / 2n ? 1 : 0,
  };
}

const FEATURE_KEYS: (keyof TxFeatures)[] = [
  'value',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'rFirstByte',
  'rParity',
  'rTopBit',
  'sFirstByte',
  'sBelowHalfN',
];

export interface FeatureComparison {
  feature: keyof TxFeatures;
  voteMean: number;
  controlMean: number;
  voteStd: number;
  controlStd: number;
  bestSingleFeatureAccuracy: number; // best achievable accuracy using ONLY this feature + an optimal threshold
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[], m: number): number {
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/**
 * Best-threshold single-feature distinguishing accuracy — the standard,
 * easily-interpretable technique from the side-channel/traffic-analysis
 * literature: for one feature, find the threshold that best separates the two
 * classes and report the accuracy an observer using ONLY that feature could
 * achieve. 0.5 = no advantage; 1.0 = perfectly distinguishable.
 */
function bestSingleFeatureAccuracy(voteValues: number[], controlValues: number[]): number {
  const all = [...voteValues, ...controlValues].sort((a, b) => a - b);
  let best = 0.5;
  for (const threshold of all) {
    const votesBelow = voteValues.filter((v) => v <= threshold).length;
    const controlsBelow = controlValues.filter((v) => v <= threshold).length;
    const acc1 = (votesBelow + (controlValues.length - controlsBelow)) / (voteValues.length + controlValues.length);
    const acc2 = (controlsBelow + (voteValues.length - votesBelow)) / (voteValues.length + controlValues.length);
    best = Math.max(best, acc1, acc2);
  }
  return best;
}

export function compareFeatures(voteFeatures: TxFeatures[], controlFeatures: TxFeatures[]): FeatureComparison[] {
  return FEATURE_KEYS.map((key) => {
    const voteValues = voteFeatures.map((f) => f[key]);
    const controlValues = controlFeatures.map((f) => f[key]);
    const voteMean = mean(voteValues);
    const controlMean = mean(controlValues);
    return {
      feature: key,
      voteMean,
      controlMean,
      voteStd: std(voteValues, voteMean),
      controlStd: std(controlValues, controlMean),
      bestSingleFeatureAccuracy: bestSingleFeatureAccuracy(voteValues, controlValues),
    };
  });
}

/**
 * Simple logistic regression (gradient descent, standardized features) as the
 * "attacker combines everything" test — a single feature might show no
 * advantage while a combination could, in principle, so this checks the
 * combined case too, not just per-feature.
 */
export function trainAndEvaluateClassifier(
  voteFeatures: TxFeatures[],
  controlFeatures: TxFeatures[],
  trainFraction = 0.7
): { trainAccuracy: number; testAccuracy: number; advantage: number } {
  const allFeatures = [...voteFeatures, ...controlFeatures];
  const labels = [...voteFeatures.map(() => 1), ...controlFeatures.map(() => 0)];

  // Standardize each feature (zero mean, unit variance) using stats from the
  // full set — fine for this diagnostic purpose, not a production ML pipeline.
  const means = FEATURE_KEYS.map((k) => mean(allFeatures.map((f) => f[k])));
  const stds = FEATURE_KEYS.map((k, i) => std(allFeatures.map((f) => f[k]), means[i]) || 1);
  const X = allFeatures.map((f) => FEATURE_KEYS.map((k, i) => (f[k] - means[i]) / stds[i]));

  // Shuffle (Fisher-Yates) before splitting — samples are currently grouped
  // (all votes then all controls), an unshuffled split would train/test on
  // wildly unbalanced classes.
  const indices = Array.from({ length: X.length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const splitAt = Math.floor(indices.length * trainFraction);
  const trainIdx = indices.slice(0, splitAt);
  const testIdx = indices.slice(splitAt);

  const nFeatures = FEATURE_KEYS.length;
  let weights = new Array(nFeatures).fill(0);
  let bias = 0;
  const lr = 0.1;
  const epochs = 500;

  const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(nFeatures).fill(0);
    let gradB = 0;
    for (const idx of trainIdx) {
      const x = X[idx];
      const y = labels[idx];
      const z = x.reduce((sum, xi, i) => sum + xi * weights[i], bias);
      const pred = sigmoid(z);
      const error = pred - y;
      for (let i = 0; i < nFeatures; i++) gradW[i] += error * x[i];
      gradB += error;
    }
    for (let i = 0; i < nFeatures; i++) weights[i] -= (lr * gradW[i]) / trainIdx.length;
    bias -= (lr * gradB) / trainIdx.length;
  }

  const accuracy = (idxs: number[]) => {
    let correct = 0;
    for (const idx of idxs) {
      const z = X[idx].reduce((sum, xi, i) => sum + xi * weights[i], bias);
      const pred = sigmoid(z) >= 0.5 ? 1 : 0;
      if (pred === labels[idx]) correct++;
    }
    return correct / idxs.length;
  };

  const testAccuracy = accuracy(testIdx);
  return {
    trainAccuracy: accuracy(trainIdx),
    testAccuracy,
    advantage: Math.abs(testAccuracy - 0.5) * 2, // 0 = no advantage, 1 = perfectly distinguishable
  };
}

export interface ExperimentResult {
  n: number;
  featureComparisons: FeatureComparison[];
  classifier: { trainAccuracy: number; testAccuracy: number; advantage: number };
}

export async function runObserverAdvantageExperiment(n = 200): Promise<ExperimentResult> {
  const voteSamples = generateVoteSamples(n);
  const controlSamples = await generateControlSamples(n);

  const voteFeatures = voteSamples.map(extractFeatures);
  const controlFeatures = controlSamples.map(extractFeatures);

  return {
    n,
    featureComparisons: compareFeatures(voteFeatures, controlFeatures),
    classifier: trainAndEvaluateClassifier(voteFeatures, controlFeatures),
  };
}
