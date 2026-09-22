import { describe, it, expect } from 'vitest';
import {
  generateVoteSamples,
  generateControlSamples,
  extractFeatures,
  compareFeatures,
  trainAndEvaluateClassifier,
  runObserverAdvantageExperiment,
  type TxFeatures,
} from './observer-experiment.js';

describe('observer-advantage experiment — detector sanity check (must run BEFORE trusting a "no advantage" result)', () => {
  /**
   * A distinguisher that always reports "can't tell" would trivially show
   * zero advantage on real data too, for the wrong reason. Prove the
   * statistical test and the classifier both have real power to detect a
   * difference when one is deliberately injected, before trusting either of
   * them to report "no advantage" as a meaningful finding rather than a
   * broken test.
   */
  function makeFeatures(overrides: Partial<TxFeatures>): TxFeatures {
    return {
      value: 1_000_000_000_000_000,
      maxFeePerGas: 20_000_000_000,
      maxPriorityFeePerGas: 2_000_000_000,
      rFirstByte: 128,
      rParity: 0,
      rTopBit: 1,
      sFirstByte: 64,
      sBelowHalfN: 1,
      ...overrides,
    };
  }

  it('single-feature test detects an obvious injected difference (the old fixed-value bug, reintroduced synthetically)', () => {
    // Controls deliberately kept entirely above the constant, not straddling
    // it — an earlier version of this test let the constant fall inside the
    // control range, which caps achievable accuracy well below 100% even for
    // a maximally-obvious difference (found while writing this test, not a
    // detector bug: with 100 votes all exactly at value C and controls
    // uniformly spanning a range containing C, the best single threshold
    // still misclassifies every control below C).
    const votes = Array.from({ length: 100 }, () => makeFeatures({ value: 1_000_000_000_000_000 })); // old bug: always exactly 0.001 ETH
    const controls = Array.from({ length: 100 }, (_, i) => makeFeatures({ value: 2_000_000_000_000_000 + i * 20_000_000_000_000 })); // varied, entirely above the constant

    const comparisons = compareFeatures(votes, controls);
    const valueComparison = comparisons.find((c) => c.feature === 'value')!;

    // A constant value against a non-overlapping varied range should be
    // perfectly distinguishable — if this doesn't show ~100% accuracy, the
    // detector itself is broken.
    expect(valueComparison.bestSingleFeatureAccuracy).toBeGreaterThan(0.99);
  });

  it('classifier detects an obvious injected difference across a combination of features', () => {
    const votes = Array.from({ length: 150 }, () => makeFeatures({ rParity: 1, sFirstByte: 200 }));
    const controls = Array.from({ length: 150 }, () => makeFeatures({ rParity: 0, sFirstByte: 50 }));

    const result = trainAndEvaluateClassifier(votes, controls);
    expect(result.testAccuracy).toBeGreaterThan(0.9);
    expect(result.advantage).toBeGreaterThan(0.8);
  });
});

describe('observer-advantage experiment — the real protocol', () => {
  it('extracts well-formed features from a real vote transaction', () => {
    const [sample] = generateVoteSamples(1);
    const features = extractFeatures(sample);
    expect(features.value).toBeGreaterThan(0);
    expect(features.maxFeePerGas).toBeGreaterThan(0);
    expect(features.sBelowHalfN).toBe(1); // EIP-2 low-s should hold
  });

  it('real vote transaction values are not the old fixed constant', () => {
    const samples = generateVoteSamples(20);
    const values = new Set(samples.map((s) => extractFeatures(s).value));
    expect(values.size).toBeGreaterThan(1);
  });

  it(
    'runs the full experiment: real anamorphic votes vs. RFC-6979-signed controls with identical value/fee sampling',
    async () => {
      const result = await runObserverAdvantageExperiment(150);

      console.log('\n=== OBSERVER-ADVANTAGE EXPERIMENT (2026-08-19), n=150 per group ===');
      for (const c of result.featureComparisons) {
        console.log(
          `${c.feature}: vote mean=${c.voteMean.toFixed(2)} (std ${c.voteStd.toFixed(2)}), control mean=${c.controlMean.toFixed(2)} (std ${c.controlStd.toFixed(2)}), best single-feature accuracy=${c.bestSingleFeatureAccuracy.toFixed(3)}`
        );
      }
      console.log(
        `Combined classifier: train accuracy=${result.classifier.trainAccuracy.toFixed(3)}, test accuracy=${result.classifier.testAccuracy.toFixed(3)}, advantage=${result.classifier.advantage.toFixed(3)}`
      );
      console.log('===============================================================\n');

      // Every feature should be close to chance (0.5) — value/fees because they're
      // now sampled identically for both groups (2026-08-19 fix), and the
      // signature fields (rParity, rTopBit, rFirstByte, sFirstByte) because
      // that's the actual cryptographic claim Ch3 §3.6.4a argues for.
      for (const c of result.featureComparisons) {
        expect(c.bestSingleFeatureAccuracy).toBeLessThan(0.65);
      }
      expect(result.classifier.testAccuracy).toBeLessThan(0.65);
    },
    30_000
  );
});
