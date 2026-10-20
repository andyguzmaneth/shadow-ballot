/**
 * What rejection sampling costs the voter, and what scanning costs the
 * coordinator (dissertation Ch5 §5.1b and §5.4).
 *
 * Measured against the implementation the live Sepolia lifecycle uses, not
 * against a spike. Single-threaded. Only the build's own codeword width is
 * measured; other widths are projected from the measured per-trial cost and
 * are labelled as projections, because the trial count is geometric and
 * scales exactly while the per-trial cost does not change with the width.
 *
 *   npx tsx scripts/measure-sampling.ts
 */
import { randomBytes } from 'node:crypto';
import { getPublicKey } from '@noble/secp256k1';
import {
  sharedSecret, channelKey, stealthAddress, signCarryingVote, decodeVote,
  Choice, CURVE_ORDER, TAG_BITS, CHOICE_BITS, bytesToBigint,
} from '../src/lib/channel.js';

const rand = () => bytesToBigint(new Uint8Array(randomBytes(32))) % CURVE_ORDER;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const fmt = (n: number) => Math.round(n).toLocaleString();

const voterPriv = new Uint8Array(randomBytes(32));
const viewPriv = new Uint8Array(randomBytes(32));
const spendPub = getPublicKey(new Uint8Array(randomBytes(32)), true);
const viewPub = getPublicKey(viewPriv, true);
const cKey = channelKey(sharedSecret(voterPriv, viewPub), 1n);

const WIDTH = TAG_BITS + CHOICE_BITS;
const REPS = 20;

console.log(`=== 1. Voter: finding an accepting nonce (codeword ${WIDTH} bits as built) ===`);
const trials: number[] = [];
const times: number[] = [];
for (let i = 0; i < REPS; i++) {
  const z = new Uint8Array(randomBytes(32));
  const t0 = process.hrtime.bigint();
  const sig = signCarryingVote(voterPriv, z, cKey, Choice.For, rand);
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  trials.push(sig.trials);
}
const perTrial = mean(times) / mean(trials);
console.log(`  expected trials (geometric, 2^${WIDTH}) : ${fmt(2 ** WIDTH)}`);
console.log(`  measured trials, mean of ${REPS}          : ${fmt(mean(trials))}  (sd ${fmt(sd(trials))})`);
console.log(`  measured wall time, mean of ${REPS}       : ${fmt(mean(times))} ms  (sd ${fmt(sd(times))} ms)`);
console.log(`  cost per trial                         : ${perTrial.toFixed(3)} ms`);

console.log('\n=== 1b. Projection to other codeword widths (NOT measured) ===');
console.log('  width | expected trials | projected mean time');
for (const w of [8, 10, 12, 14, 16, 18]) {
  const t = 2 ** w * perTrial;
  const s = t > 1000 ? `${(t / 1000).toFixed(1)} s` : `${fmt(t)} ms`;
  console.log(`  ${String(w).padStart(5)} | ${fmt(2 ** w).padStart(15)} | ${s.padStart(19)}`);
}

console.log('\n=== 2. Coordinator: deriving one voter\'s slots ===');
const voters = Array.from({ length: 200 }, () =>
  getPublicKey(new Uint8Array(randomBytes(32)), true));
const t1 = process.hrtime.bigint();
for (const pub of voters) {
  const s = sharedSecret(viewPriv, pub);
  for (let j = 0; j < 8; j++) stealthAddress(s, spendPub, 1n, j);
}
const scanMs = Number(process.hrtime.bigint() - t1) / 1e6;
console.log(`  200 addresses x 8 slots : ${fmt(scanMs)} ms  (${(scanMs / 200).toFixed(2)} ms per address)`);
console.log(`  projected 10,000 holders: ${(scanMs * 50 / 1000).toFixed(1)} s (linear, one scalar mult each)`);

console.log('\n=== 3. Decoding one candidate signature ===');
const sig = signCarryingVote(voterPriv, new Uint8Array(randomBytes(32)), cKey, Choice.For, rand);
const t2 = process.hrtime.bigint();
for (let i = 0; i < 100_000; i++) decodeVote(cKey, sig.r);
const decMs = Number(process.hrtime.bigint() - t2) / 1e6;
console.log(`  100,000 decodes : ${fmt(decMs)} ms  (${(decMs * 1000 / 100_000).toFixed(2)} us each)`);
