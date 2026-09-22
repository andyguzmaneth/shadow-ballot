import { describe, it, expect } from 'vitest';
import { Point, getPublicKey, utils } from '@noble/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { scanForStealthTx, generateStealthKeys } from './stealth.js';

/**
 * Verifies, empirically and not just by reputation, the claim in dissertation Ch3
 * §3.4.3 ("point validation"): that an invalid/off-curve ephemeral public key R
 * cannot silently reach scalar multiplication with the coordinator's viewing key —
 * which would otherwise risk small-subgroup/invalid-curve key-leakage attacks
 * (finding raised by the 2026-08-17 adversarial review panel, "ecc" reviewer).
 *
 * Confirmed against @noble/secp256k1 source (node_modules/@noble/secp256k1/index.ts):
 * Point.fromBytes (line ~214) computes y from x via the curve equation, then calls
 * assertValidity() (line ~340), which re-checks y² == x³+7 and throws 'bad point:
 * not on curve' if it fails. This is not an assumption about "an audited library
 * probably does the right thing" — it's the actual code path `stealth.ts` calls.
 */
describe('point validation (Ch3 §3.4.3, ecc-panel finding)', () => {
  it('Point.fromHex rejects an x-coordinate with no valid y on the curve', () => {
    // Start from a real, valid compressed public key, then walk the x-coordinate
    // forward one field element at a time until we hit one with no valid y — only
    // ~half of all x values in F_p are quadratic residues of x³+7, so this is fast
    // and deterministic (not relying on getting lucky with a single guess).
    const validPrivKey = utils.randomSecretKey();
    const validPubKey = getPublicKey(validPrivKey, true);
    const prefix = validPubKey[0];
    const xBytes = validPubKey.slice(1);
    let x = BigInt('0x' + bytesToHex(xBytes));

    let foundInvalid = false;
    for (let i = 1; i <= 20; i++) {
      const candidateX = x + BigInt(i);
      const candidateHex =
        bytesToHex(new Uint8Array([prefix])) + candidateX.toString(16).padStart(64, '0');
      try {
        Point.fromHex(candidateHex);
        // Valid point — try the next x.
      } catch (e) {
        // Turns out the rejection happens even earlier than expected: computing the
        // modular square root of x³+7 fails outright ("sqrt invalid") when x isn't a
        // quadratic residue, before assertValidity()'s equation re-check ever runs.
        // Stronger than the citation assumed — two independent checks, not one.
        expect((e as Error).message).toMatch(/not on curve|bad point|sqrt invalid/i);
        foundInvalid = true;
        break;
      }
    }

    expect(foundInvalid).toBe(true);
  });

  it('scanForStealthTx does not silently accept an invalid ephemeral pubkey — it throws/returns false, never proceeds', () => {
    const coordinator = generateStealthKeys();

    // Same x-coordinate walk as above, this time feeding the invalid point into the
    // real production code path (scanForStealthTx), not a reimplementation.
    const validPrivKey = utils.randomSecretKey();
    const validPubKey = getPublicKey(validPrivKey, true);
    const prefix = validPubKey[0];
    const xBytes = validPubKey.slice(1);
    let x = BigInt('0x' + bytesToHex(xBytes));

    let invalidPubKeyHex: string | null = null;
    for (let i = 1; i <= 20; i++) {
      const candidateX = x + BigInt(i);
      const candidateHex =
        bytesToHex(new Uint8Array([prefix])) + candidateX.toString(16).padStart(64, '0');
      try {
        Point.fromHex(candidateHex);
      } catch {
        invalidPubKeyHex = candidateHex;
        break;
      }
    }

    expect(invalidPubKeyHex).not.toBeNull();
    const invalidPubKey = hexToBytes(invalidPubKeyHex!);

    // scanForStealthTx wraps Point.fromHex in a try/catch and returns false on any
    // error (stealth.ts: `catch { return false; }`) — confirm that's still true and
    // that no coordinator secret ever reaches a scalar multiply against this input.
    const result = scanForStealthTx(
      coordinator.viewingKey,
      coordinator.spendingPubKey,
      invalidPubKey,
      '0x0000000000000000000000000000000000000001'
    );
    expect(result).toBe(false);
  });
});
