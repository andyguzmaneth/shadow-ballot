/**
 * The observer-advantage experiment against the REDESIGNED protocol
 * (dissertation Ch5 §5.2).
 *
 * The same harness Ch5 §5.2 already describes, with the vote generator
 * swapped for the live r-channel path: an ordinary ETH transfer to a stealth
 * address, signed by resampling k until r carries the vote. Controls are
 * ethers' own RFC 6979 signer with identical value, fee and gas-limit
 * sampling, so the signing method is the only variable.
 *
 *   RUNS=10 N=200 npx tsx scripts/observer-rchannel.ts
 */
import {
  runObserverAdvantageExperiment, generateRChannelVoteSamples,
} from '../src/lib/observer-experiment.js';

const RUNS = Number(process.env.RUNS ?? 10);
const N = Number(process.env.N ?? 200);

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const ci = (a: number[]) => {
  const m = mean(a), s = sd(a) / Math.sqrt(a.length);
  return [m - 1.96 * s, m + 1.96 * s];
};

async function main() {
  console.log(`observer-advantage experiment, r-channel protocol: ${RUNS} runs x ${N} per group`);
  const combined: number[] = [];
  const perFeature = new Map<string, number[]>();
  for (let r = 0; r < RUNS; r++) {
    const t0 = Date.now();
    const res = await runObserverAdvantageExperiment(N, generateRChannelVoteSamples);
    combined.push(res.classifier.testAccuracy);
    for (const f of res.featureComparisons) {
      if (!perFeature.has(f.feature)) perFeature.set(f.feature, []);
      perFeature.get(f.feature)!.push(f.bestSingleFeatureAccuracy);
    }
    console.log(`  run ${r + 1}/${RUNS}: classifier ${res.classifier.testAccuracy.toFixed(4)}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }

  console.log('\n| Feature | mean best single-feature accuracy | sd | 95% CI |');
  console.log('|---|---:|---:|---|');
  for (const [f, xs] of perFeature) {
    const [lo, hi] = ci(xs);
    console.log(`| ${f} | ${mean(xs).toFixed(4)} | ${sd(xs).toFixed(4)} | [${lo.toFixed(4)}, ${hi.toFixed(4)}] |`);
  }
  const [lo, hi] = ci(combined);
  console.log(`\ncombined classifier: mean ${mean(combined).toFixed(4)}, sd ${sd(combined).toFixed(4)}, 95% CI [${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
  console.log(`baseline (chance)  : 0.5000`);
}
main().catch((e) => { console.error(e); process.exit(1); });
