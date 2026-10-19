/**
 * SPIKE benchmark (dissertation Ch6 §6.8). Two questions:
 *   1. What does rejection sampling on r cost the VOTER, per tag width?
 *   2. What does scanning cost the COORDINATOR when there is no stealth
 *      address to narrow the search: every eligible address, every
 *      transaction in the window?
 */
import { randomBytes } from 'node:crypto';
import { getPublicKey, Point } from '@noble/secp256k1';
import {
  voterKappa, coordinatorKappa, signCarryingVote, decodeVote,
  CURVE_ORDER, bytesToBigint,
} from './r-channel.js';

const randK = () => bytesToBigint(new Uint8Array(randomBytes(32))) % CURVE_ORDER;
const ms = (t: bigint) => Number(t) / 1e6;

console.log('=== 1. Voter cost: rejection sampling on r ===');
console.log('tag bits | expected trials | measured trials (mean of 20) | mean wall time');
for (const tagBits of [8, 10, 12, 14, 16]) {
  const CHOICE_BITS = 2;
  let trials = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) {
    const vp = new Uint8Array(randomBytes(32));
    const cp = new Uint8Array(randomBytes(32));
    const kappa = voterKappa(vp, getPublicKey(cp, true), 7n);
    trials += signCarryingVote(vp, new Uint8Array(randomBytes(32)), kappa,
      i % 3, tagBits, CHOICE_BITS, randK).trials;
  }
  const t = ms(process.hrtime.bigint() - t0) / 20;
  console.log(
    `${String(tagBits).padStart(8)} | ${String(2 ** (tagBits + CHOICE_BITS)).padStart(15)} | ` +
    `${(trials / 20).toFixed(0).padStart(28)} | ${t.toFixed(0).padStart(9)} ms`
  );
}

console.log('\n=== 2. Coordinator cost: scanning without a stealth address ===');
// Per eligible address: one EC scalar mult (v*X) to get kappa.
// Per transaction by that address in the window: one keccak256 over (kappa, r).
const coordPriv = new Uint8Array(randomBytes(32));
for (const nAddrs of [1_000, 10_000]) {
  const pubs: Uint8Array[] = [];
  for (let i = 0; i < nAddrs; i++) pubs.push(getPublicKey(new Uint8Array(randomBytes(32)), true));

  const t0 = process.hrtime.bigint();
  const kappas = pubs.map((p) => coordinatorKappa(coordPriv, p, 7n));
  const tKappa = ms(process.hrtime.bigint() - t0);

  const TX_PER_ADDR = 10;                      // a week of ordinary activity
  const rs: bigint[] = [];
  for (let i = 0; i < TX_PER_ADDR; i++) rs.push(randK());
  const t1 = process.hrtime.bigint();
  let hits = 0;
  for (const kappa of kappas) {
    for (const r of rs) if (decodeVote(kappa, r, 12, 2) !== null) hits++;
  }
  const tScan = ms(process.hrtime.bigint() - t1);

  console.log(
    `${nAddrs.toLocaleString()} eligible addresses x ${TX_PER_ADDR} txs = ` +
    `${(nAddrs * TX_PER_ADDR).toLocaleString()} candidate signatures`
  );
  console.log(`  derive kappa (one EC mult each): ${tKappa.toFixed(0)} ms`);
  console.log(`  test every signature:            ${tScan.toFixed(0)} ms`);
  console.log(`  TOTAL:                           ${(tKappa + tScan).toFixed(0)} ms` +
    `   (${hits} tag collisions, expected ~${(nAddrs * TX_PER_ADDR / 4096).toFixed(0)})`);
}
