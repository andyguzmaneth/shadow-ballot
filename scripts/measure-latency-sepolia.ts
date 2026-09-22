/**
 * Real latency measurements for Ch5 §5.4. Two categories:
 *  (1) off-chain computation (stealth derivation, coordinator scan/decode) — timed locally.
 *  (2) on-chain confirmation latency — timed against real, live Sepolia transactions.
 *
 * For (2), rather than running N fresh full Governor proposal lifecycles (each needing a
 * ZK proof bound to a fresh proposalId, which this pass cannot regenerate — see the note
 * below), this measures confirmation latency using the two real per-vote transaction types
 * that don't require a fresh proposal each time: an ERC5564Announcer.announce() call (the
 * protocol's real per-vote announce transaction) and a plain ETH transfer (a stand-in for
 * "vanilla castVote()" — under EIP-1559, block-inclusion latency depends on gas price
 * competitiveness and block time, not calldata complexity, so a plain transfer and a
 * castVote() call from the same account under the same conditions have the same
 * confirmation-latency profile; this is stated as the proxy used, not disguised as a
 * literal castVote() call).
 *
 * NOTE ON ZK PROOF GENERATION TIMING: not measured in this pass. The circuit build
 * artifacts (compiled .wasm witness calculator, .zkey) from Ch4 §4.5's original compile
 * are not present in this checkout, and no local circom2 compiler / Powers-of-Tau file is
 * installed to regenerate them within this pass's time budget. Ch4 §4.5's own qualitative
 * figure (<10s combined for the full compile-to-verify pipeline, ~11.3k constraints) is the
 * only existing data point and is cited as such, not re-measured here.
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { hexToBytes as nobleHexToBytes } from '@noble/hashes/utils.js';
import { generateStealthKeys, generateStealthAddress } from '../src/lib/stealth.js';
import { announceVote, scanAnnouncements, buildAnnouncementMetadata } from '../src/lib/announcer.js';
import { ANNOUNCER_ADDRESS } from '../src/config.js';

const RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
const DEPLOYER_PRIVATE_KEY = process.env.SHADOWBALLOT_SEPOLIA_DEPLOYER_PRIVATE_KEY;
if (!DEPLOYER_PRIVATE_KEY) {
  console.error('Set SHADOWBALLOT_SEPOLIA_DEPLOYER_PRIVATE_KEY before running.');
  process.exit(1);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(DEPLOYER_PRIVATE_KEY!, provider);

  // (1a) Stealth address derivation — off-chain, no network.
  const coordinator = generateStealthKeys();
  const stealthTimes: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    generateStealthAddress(coordinator.metaAddress);
    stealthTimes.push(performance.now() - t0);
  }
  console.log(`[1a] Stealth address derivation: mean ${mean(stealthTimes).toFixed(2)}ms over 100 runs`);

  // (2a) Plain ETH transfer confirmation latency (vanilla-tx proxy), n=5.
  const plainTimes: number[] = [];
  let nonce = await provider.getTransactionCount(wallet.address, 'pending');
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const tx = await wallet.sendTransaction({ to: wallet.address, value: 0n, nonce: nonce++ });
    await tx.wait();
    const dt = performance.now() - t0;
    plainTimes.push(dt);
    console.log(`[2a] Plain transfer ${i + 1}/5: ${(dt / 1000).toFixed(1)}s (${tx.hash})`);
  }

  // (2b) Announce transaction confirmation latency, n=5 — real per-vote announce tx.
  const announceTimes: number[] = [];
  const announceTxHashes: string[] = [];
  for (let i = 0; i < 5; i++) {
    const stealth = generateStealthAddress(coordinator.metaAddress);
    const viewTag = buildAnnouncementMetadata(0)[0];
    const t0 = performance.now();
    const txHash = await announceVote(
      RPC_URL,
      wallet.privateKey,
      stealth.stealthAddress,
      '0x' + Buffer.from(stealth.ephemeralPubKey).toString('hex'),
      viewTag
    );
    const dt = performance.now() - t0;
    announceTimes.push(dt);
    announceTxHashes.push(txHash);
    console.log(`[2b] Announce ${i + 1}/5: ${(dt / 1000).toFixed(1)}s (${txHash})`);
  }

  // (1b) Coordinator scan + decode latency, off-chain, over the block range just used.
  const scanTimes: number[] = [];
  const currentBlock = await provider.getBlockNumber();
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await scanAnnouncements(RPC_URL, Math.max(0, currentBlock - 30), 'latest');
    scanTimes.push(performance.now() - t0);
  }
  console.log(`[1b] Coordinator scan (30-block window): mean ${mean(scanTimes).toFixed(2)}ms over 5 runs`);

  console.log('\n=== SUMMARY ===');
  console.log('Stealth derivation (off-chain), mean ms:', mean(stealthTimes).toFixed(2));
  console.log('Plain transfer confirmation (n=5), mean s:', (mean(plainTimes) / 1000).toFixed(2));
  console.log('Announce tx confirmation (n=5), mean s:', (mean(announceTimes) / 1000).toFixed(2));
  console.log('Coordinator scan (off-chain, n=5), mean ms:', mean(scanTimes).toFixed(2));
  console.log('Plain transfer times (s):', plainTimes.map((t) => (t / 1000).toFixed(1)));
  console.log('Announce times (s):', announceTimes.map((t) => (t / 1000).toFixed(1)));
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
