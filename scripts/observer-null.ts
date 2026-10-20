/**
 * Null calibration for the observer-advantage estimator (Ch5 §5.2).
 *
 * Runs the identical pipeline on two groups that are both ordinary RFC 6979
 * transactions, so there is no signal to find by construction. Whatever the
 * combined classifier reports here is the estimator's own bias at this sample
 * size, and the protocol's number has to be read against it rather than
 * against 0.5.
 *
 *   RUNS=10 N=200 npx tsx scripts/observer-null.ts
 */
import {
  generateControlSamples, extractFeatures, compareFeatures,
  trainAndEvaluateClassifier,
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
  console.log(`null calibration: ${RUNS} runs x ${N} per group, BOTH groups ordinary RFC 6979`);
  const combined: number[] = [];
  const perFeature = new Map<string, number[]>();
  for (let r = 0; r < RUNS; r++) {
    const a = (await generateControlSamples(N)).map(extractFeatures);
    const b = (await generateControlSamples(N)).map(extractFeatures);
    const res = trainAndEvaluateClassifier(a, b);
    combined.push(res.testAccuracy);
    for (const f of compareFeatures(a, b)) {
      if (!perFeature.has(f.feature)) perFeature.set(f.feature, []);
      perFeature.get(f.feature)!.push(f.bestSingleFeatureAccuracy);
    }
  }
  console.log('\n| Feature | mean best single-feature accuracy | sd | 95% CI |');
  console.log('|---|---:|---:|---|');
  for (const [f, xs] of perFeature) {
    const [lo, hi] = ci(xs);
    console.log(`| ${f} | ${mean(xs).toFixed(4)} | ${sd(xs).toFixed(4)} | [${lo.toFixed(4)}, ${hi.toFixed(4)}] |`);
  }
  const [lo, hi] = ci(combined);
  console.log(`\ncombined classifier on NO signal: mean ${mean(combined).toFixed(4)}, sd ${sd(combined).toFixed(4)}, 95% CI [${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
}
main().catch((e) => { console.error(e); process.exit(1); });
