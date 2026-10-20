/**
 * The comparison baseline, live on Sepolia (dissertation Ch5 §5.1).
 *
 * Two things the protocol's own cost has to be read against, both measured on
 * the same chain on the same day rather than taken from the local EVM:
 *
 *   1. What a DAO pays today: an unmodified OpenZeppelin Governor's castVote().
 *   2. What an ordinary ETH transfer costs, to a new account and to one that
 *      already exists. Since Glamsterdam (EIP-2780) those differ by the state
 *      gas charged for creating an account, and every vote in this protocol
 *      goes to a freshly derived stealth address.
 *
 *   npx tsx scripts/baseline-sepolia.ts
 */
import {
  JsonRpcProvider, Wallet, ContractFactory, Contract, Interface, parseEther, formatEther,
} from 'ethers';
import { readFileSync } from 'node:fs';

const log = (...a: unknown[]) => console.log(...a);
const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const CHAIN_ID = 11155111;
const VOTING_DELAY = 1;
const VOTING_PERIOD = 12;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function artifact(name: string) {
  const a = JSON.parse(readFileSync(`artifacts/contracts/${name}.sol/${name}.json`, 'utf8'));
  return { abi: a.abi, bytecode: a.bytecode };
}
async function deploy(name: string, wallet: Wallet, args: unknown[] = []) {
  const { abi, bytecode } = artifact(name);
  const c = await new ContractFactory(abi, bytecode, wallet).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}
const gas = (n: bigint) => Number(n).toLocaleString();

async function main() {
  const provider = new JsonRpcProvider(RPC, CHAIN_ID);
  const w = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
  log('deployer:', w.address);
  log('balance :', formatEther(await provider.getBalance(w.address)), 'ETH\n');

  if (process.env.SKIP_TRANSFERS !== '1') {
  log('=== 1. Plain ETH transfers: new account vs existing account ===');
  const fresh = Wallet.createRandom().address;
  const r1 = await (await w.sendTransaction({ to: fresh, value: parseEther('0.00002') })).wait();
  log('   transfer to a NEVER-SEEN address :', gas(r1!.gasUsed), 'gas  logs:', r1!.logs.length);
  const r2 = await (await w.sendTransaction({ to: fresh, value: parseEther('0.00001') })).wait();
  log('   transfer to the SAME address now :', gas(r2!.gasUsed), 'gas  logs:', r2!.logs.length);
  log('   difference (EIP-2780 state gas)  :', gas(r1!.gasUsed - r2!.gasUsed), 'gas\n');
  }

  log('=== 2. Vanilla OpenZeppelin Governor ===');
  const token = await deploy('MockGovernanceToken', w);
  const tokenAddr = await token.getAddress();
  const mint = await (await token.mint(w.address, parseEther('1000'))).wait();
  const dele = await (await token.delegate(w.address)).wait();
  log('   MockGovernanceToken.mint()       :', gas(mint!.gasUsed), 'gas');
  log('   delegate()                       :', gas(dele!.gasUsed), 'gas');

  const gov = await deploy('VanillaGovernor', w, [tokenAddr, VOTING_DELAY, VOTING_PERIOD, 0n, 4n]);
  const govAddr = await gov.getAddress();
  log('   VanillaGovernor deployed         :', govAddr);

  const targets = [tokenAddr], values = [0n];
  const calldatas = [new Interface(['function name() view returns (string)']).encodeFunctionData('name')];
  const desc = 'baseline ' + Date.now();
  const pr = await (await gov.propose(targets, values, calldatas, desc)).wait();
  const ev = pr!.logs.map((l: any) => { try { return gov.interface.parseLog(l); } catch { return null; } })
    .find((e: any) => e?.name === 'ProposalCreated');
  const proposalId: bigint = ev!.args.proposalId;
  log('   VanillaGovernor.propose()        :', gas(pr!.gasUsed), 'gas');

  const snapshot: bigint = await gov.proposalSnapshot(proposalId);
  while (BigInt(await provider.getBlockNumber()) <= snapshot) await sleep(6000);
  const vr = await (await gov.castVote(proposalId, 1)).wait();
  log('   VanillaGovernor.castVote()       :', gas(vr!.gasUsed), 'gas  <- what a DAO pays today');
  const vr2 = await (await gov.castVote(proposalId, 1).catch(() => null));
  if (vr2) log('   (second castVote, same voter)    : accepted, which it should not be');
}
main().catch((e) => { console.error(e); process.exit(1); });
