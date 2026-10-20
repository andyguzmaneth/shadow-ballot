/**
 * The full protocol, live on Sepolia (dissertation Ch4 §4.8).
 *
 * Deploy -> publish meta-address -> propose -> cast an anamorphic vote as an
 * ordinary ETH transfer -> wait out the window -> scan, decode, tally, commit
 * -> submit -> check Governor's final state. Nothing simulated.
 *
 *   npx tsx scripts/lifecycle-sepolia.ts
 */
import {
  JsonRpcProvider, Wallet, ContractFactory, Contract, Interface,
  parseEther, formatEther, ZeroAddress,
} from 'ethers';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getPublicKey } from '@noble/secp256k1';
import {
  sharedSecret, channelKey, stealthAddress, Choice, CURVE_ORDER, bytesToBigint,
} from '../src/lib/channel.js';
import { tally } from '../src/lib/coordinator.js';
import { buildTransaction, signVoteTransaction } from '../src/lib/tx.js';

const rand = () => bytesToBigint(new Uint8Array(randomBytes(32))) % CURVE_ORDER;
const log = (...a: unknown[]) => console.log(...a);
const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');

const VOTING_DELAY = 1;        // blocks
const VOTING_PERIOD = 12;      // blocks, ~2.5 min on Sepolia

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const CHAIN_ID = 11155111;

function artifact(name: string) {
  const path = `artifacts/contracts/${name}.sol/${name}.json`;
  const a = JSON.parse(readFileSync(path, 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode };
}

async function deploy(name: string, wallet: Wallet, args: unknown[] = []) {
  const { abi, bytecode } = artifact(name);
  const c = await new ContractFactory(abi, bytecode, wallet).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

async function main() {
  const provider = new JsonRpcProvider(RPC, CHAIN_ID);
  const deployer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!.replace(/^0x/, '0x'), provider);
  log('deployer:', deployer.address);
  log('balance :', formatEther(await provider.getBalance(deployer.address)), 'ETH\n');

  // The coordinator's keys. s and v never leave this process.
  const spendPriv = new Uint8Array(randomBytes(32));
  const viewPriv = new Uint8Array(randomBytes(32));
  const spendPub = getPublicKey(spendPriv, true);
  const viewPub = getPublicKey(viewPriv, true);

  log('[1/8] Deploying...');
  const token = await deploy('MockGovernanceToken', deployer);
  const registry = await deploy('CoordinatorRegistry', deployer);
  const governor = await deploy('ShadowBallotGovernor', deployer, [
    await token.getAddress(), deployer.address, VOTING_DELAY, VOTING_PERIOD, 0, 4,
  ]);
  const addresses = {
    MockGovernanceToken: await token.getAddress(),
    CoordinatorRegistry: await registry.getAddress(),
    ShadowBallotGovernor: await governor.getAddress(),
  };
  log('      ', JSON.stringify(addresses, null, 2));

  log('[2/8] Minting and delegating...');
  await (await token.mint(deployer.address, parseEther('100'))).wait();
  await (await token.delegate(deployer.address)).wait();

  log('[3/8] Coordinator publishes its meta-address (Ch3 §3.4.2 step 1)...');
  const pub = await (await registry.publish(hex(spendPub), hex(viewPub))).wait();
  log('       gas:', Number(pub!.gasUsed).toLocaleString());

  log('[4/8] Proposing...');
  const propose = await (await governor.propose(
    [ZeroAddress], [0n], ['0x'], 'Live lifecycle ' + Date.now()
  )).wait();
  const iface = new Interface(artifact('ShadowBallotGovernor').abi);
  const ev = propose!.logs
    .map((l) => { try { return iface.parseLog(l as never); } catch { return null; } })
    .find((e) => e && e.name === 'ProposalCreated')!;
  const proposalId: bigint = ev.args.proposalId;
  const snapshotBlock: bigint = ev.args.voteStart;
  log('       proposalId:', proposalId.toString());
  log('       propose gas:', Number(propose!.gasUsed).toLocaleString());

  // Wait for the voting window to open.
  while (BigInt(await provider.getBlockNumber()) <= snapshotBlock) await sleep(4000);

  log('[5/8] Casting a vote: an ordinary ETH transfer, no calldata...');
  // The voter is the deployer here, i.e. the address that holds the tokens.
  const voterPriv = hexToBytes(process.env.DEPLOYER_PRIVATE_KEY!.replace(/^0x/, ''));
  const sigma = sharedSecret(voterPriv, viewPub);
  const cKey = channelKey(sigma, proposalId);
  const addr = stealthAddress(sigma, spendPub, proposalId, 0);
  log('       stealth address:', addr);

  const nonce = await provider.getTransactionCount(deployer.address);
  const fee = await provider.getFeeData();
  const unsigned = buildTransaction(
    deployer.address, addr, parseEther('0.0013'), nonce, 11155111,
    { maxFeePerGas: fee.maxFeePerGas!, maxPriorityFeePerGas: fee.maxPriorityFeePerGas! }
  );
  const t0 = Date.now();
  const signed = signVoteTransaction(unsigned, voterPriv, cKey, Choice.For, rand);
  log(`       resampled ${signed.trials} nonces in ${Date.now() - t0} ms`);
  const sent = await provider.broadcastTransaction(signed.signedTxHex);
  const voteReceipt = await sent.wait();
  log('       vote tx:', sent.hash);
  log('       vote gas:', Number(voteReceipt!.gasUsed).toLocaleString(), '<- the voter’s entire on-chain cost');

  log('[6/8] Waiting out the voting window...');
  const deadline: bigint = await governor.proposalDeadline(proposalId);
  while (BigInt(await provider.getBlockNumber()) <= deadline) await sleep(6000);
  log('       state before the tally:', (await governor.state(proposalId)).toString(), '(1 = Active, held open)');

  log('[7/8] Coordinator scans, decodes and tallies...');
  const voterPub = getPublicKey(voterPriv, true);
  const result = tally(viewPriv, spendPub, proposalId,
    [{ address: deployer.address, publicKey: voterPub }],
    [{ from: deployer.address, to: addr, r: BigInt('0x' + signed.r) }]);
  log('       decoded:', JSON.stringify({
    for: result.forVotes, against: result.againstVotes, abstain: result.abstainVotes,
  }));
  if (result.forVotes !== 1) throw new Error('coordinator failed to decode the vote');
  log('       commitment root:', hex(result.commitmentRoot));

  log('[8/8] Submitting the tally...');
  const sub = await (await governor.submitAnamorphicTally(
    proposalId,
    parseEther('100'),   // scaled to the voter's weight
    0n, 0n,
    hex(result.commitmentRoot)
  )).wait();
  log('       tally gas:', Number(sub!.gasUsed).toLocaleString());
  const finalState = await governor.state(proposalId);
  log('       final state:', finalState.toString(), '(4 = Succeeded)');
  log('       on-chain commitment:', await governor.voteCommitmentRoot(proposalId));

  log('\n=== LIFECYCLE COMPLETE ===');
  log(JSON.stringify({ ...addresses, proposalId: proposalId.toString(), voteTx: sent.hash }, null, 2));
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function hexToBytes(h: string) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
