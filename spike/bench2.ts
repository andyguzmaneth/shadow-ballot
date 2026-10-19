import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getPublicKey, Point } from '@noble/secp256k1';
import { voterKappa, coordinatorKappa, signCarryingVote, decodeVote, CURVE_ORDER, bytesToBigint } from './r-channel.js';
const rand = () => bytesToBigint(new Uint8Array(randomBytes(32))) % CURVE_ORDER;
const ms = (t: bigint) => Number(t) / 1e6;
const out: string[] = [];
const say = (l: string) => { out.push(l); writeFileSync('spike/bench.txt', out.join('\n') + '\n'); };

const t0 = process.hrtime.bigint();
for (let i = 0; i < 300; i++) Point.BASE.multiply(rand());
const perMult = ms(process.hrtime.bigint() - t0) / 300;
say(`scalar multiplication: ${perMult.toFixed(3)} ms`);

const vp = new Uint8Array(randomBytes(32)), cp = new Uint8Array(randomBytes(32));
const kappa = voterKappa(vp, getPublicKey(cp, true), 7n);
say('\nVoter, rejection sampling on r (choice = 2 bits):');
say('tag bits | expected trials | measured | wall time');
for (const tb of [6, 8, 10]) {
  let tr = 0; const a = process.hrtime.bigint();
  for (let i = 0; i < 10; i++) tr += signCarryingVote(vp, new Uint8Array(randomBytes(32)), kappa, i % 3, tb, 2, rand).trials;
  const w = ms(process.hrtime.bigint() - a) / 10;
  say(`${String(tb).padStart(8)} | ${String(2 ** (tb + 2)).padStart(15)} | ${(tr / 10).toFixed(0).padStart(8)} | ${w.toFixed(0)} ms`);
}
for (const tb of [12, 14, 16]) {
  say(`${String(tb).padStart(8)} | ${String(2 ** (tb + 2)).padStart(15)} | ${'projected'.padStart(8)} | ${(2 ** (tb + 2) * perMult / 1000).toFixed(1)} s`);
}

say('\nCoordinator, scanning with no stealth address to narrow the search:');
const cv = new Uint8Array(randomBytes(32));
for (const n of [1000, 10000]) {
  const pubs = Array.from({ length: n }, () => getPublicKey(new Uint8Array(randomBytes(32)), true));
  const a = process.hrtime.bigint();
  const ks = pubs.map((p) => coordinatorKappa(cv, p, 7n));
  const tK = ms(process.hrtime.bigint() - a);
  const rs = Array.from({ length: 10 }, rand);
  const b = process.hrtime.bigint();
  let hits = 0;
  for (const k of ks) for (const r of rs) if (decodeVote(k, r, 12, 2) !== null) hits++;
  const tS = ms(process.hrtime.bigint() - b);
  say(`${n.toLocaleString()} addresses x 10 txs = ${(n * 10).toLocaleString()} signatures: kappa ${tK.toFixed(0)} ms + scan ${tS.toFixed(0)} ms = ${(tK + tS).toFixed(0)} ms (${hits} tag collisions, expected ~${(n * 10 / 4096).toFixed(0)})`);
}
say('\ndone');
