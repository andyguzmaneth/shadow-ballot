/**
 * The sender's base rate (dissertation Ch5 §5.1c).
 *
 * Participation non-observability now reduces to one empirical question: when
 * a real DAO voter casts a vote, does that transaction stand out as unusual
 * activity from their address, or does the address transact anyway?
 *
 * Method. Take a real OpenZeppelin Governor proposal on Ethereum mainnet.
 * Read its VoteCast logs for the addresses that actually voted, then read each
 * one's account nonce at the first and last block of the window. The
 * difference is exactly how many transactions that address sent during the
 * window: no indexer, no heuristics, the nonce is consensus state.
 *
 * Two endpoints, because no free one does both jobs. Flashbots serves wide
 * eth_getLogs ranges over recent history; drpc serves archive state.
 *
 *   npx tsx scripts/base-rate.ts
 */
import { JsonRpcProvider, Interface } from 'ethers';

const LOGS_RPC = process.env.MAINNET_LOGS_RPC ?? 'https://rpc.flashbots.net';
const STATE_RPC = process.env.MAINNET_STATE_RPC ?? 'https://eth.drpc.org';

// ENS DAO Governor: a standard OpenZeppelin Governor on L1, which is the
// configuration this dissertation's protocol integrates with.
const GOVERNOR = process.env.GOVERNOR ?? '0x323A76393544d5ecca80cd6ef2A560C6a395b7E3';

const ABI = [
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)',
  'event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason)',
];

const CHUNK = 9_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(f: () => Promise<T>, label: string, n = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e: any) {
      if (i >= n) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

async function main() {
  const logs = new JsonRpcProvider(LOGS_RPC, 1, { batchMaxCount: 1 });
  const state = new JsonRpcProvider(STATE_RPC, 1, { batchMaxCount: 1 });
  const iface = new Interface(ABI);
  const head = await logs.getBlockNumber();
  console.log('governor    :', GOVERNOR);
  console.log('mainnet head:', head);

  // The most recent proposal the log endpoint can still see.
  let created: any = null;
  for (let top = head; top > head - 170_000 && !created; top -= CHUNK) {
    const got = await retry(() => logs.getLogs({
      address: GOVERNOR, fromBlock: top - CHUNK + 1, toBlock: top,
      topics: [iface.getEvent('ProposalCreated')!.topicHash],
    }), 'proposal search');
    if (got.length) created = iface.parseLog(got[got.length - 1])!;
    await sleep(80);
  }
  if (!created) throw new Error('no proposal in the log endpoint\'s range');

  const proposalId: bigint = created.args.proposalId;
  const startBlock = Number(created.args.startBlock);
  const endBlock = Number(created.args.endBlock);
  const windowEnd = Math.min(endBlock, head);
  const closed = endBlock <= head;
  console.log('\nproposal    :', proposalId.toString());
  console.log('full window :', startBlock, '->', endBlock,
              `(${endBlock - startBlock} blocks, ~${((endBlock - startBlock) * 12 / 86400).toFixed(1)} days)`);
  console.log('measured    :', startBlock, '->', windowEnd,
              `(${windowEnd - startBlock} blocks, ~${((windowEnd - startBlock) * 12 / 3600).toFixed(1)} h)`,
              closed ? '[window closed]' : '[window still open: this is a LOWER bound]');

  const voters = new Set<string>();
  for (let from = startBlock; from <= windowEnd; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, windowEnd);
    const got = await retry(() => logs.getLogs({
      address: GOVERNOR, fromBlock: from, toBlock: to,
      topics: [iface.getEvent('VoteCast')!.topicHash],
    }), 'votecast');
    for (const l of got) {
      const e = iface.parseLog(l)!;
      if (e.args.proposalId === proposalId) voters.add(e.args.voter.toLowerCase());
    }
    await sleep(80);
  }
  const list = [...voters];
  console.log('voters      :', list.length);
  if (!list.length) throw new Error('no VoteCast logs for that proposal');

  // Two windows of the same length: the voting window, and the equally long
  // window immediately before it. The control answers the question Property 1
  // actually turns on, which is not "do voters transact" but "does voting make
  // them transact more than they otherwise would".
  const span = windowEnd - startBlock;
  const ctrlStart = startBlock - span;
  const longStart = startBlock - 4 * span;   // four windows of prior history
  const counts: number[] = [];
  const controls: number[] = [];
  const longs: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const nl = await retry(() => state.getTransactionCount(a, longStart), 'nonceL');
    const nc = await retry(() => state.getTransactionCount(a, ctrlStart), 'nonceC');
    longs.push(nc - nl);
    const n0 = await retry(() => state.getTransactionCount(a, startBlock), 'nonce0');
    const n1 = await retry(() => state.getTransactionCount(a, windowEnd), 'nonce1');
    counts.push(n1 - n0);
    controls.push(n0 - nc);
    if ((i + 1) % 25 === 0) console.log(`   ...${i + 1}/${list.length}`);
    await sleep(100);
  }
  console.log('control window:', ctrlStart, '->', startBlock, `(${span} blocks, same length)`);

  const total = counts.length;
  const sent0 = counts.filter((c) => c === 0).length;
  const sent1 = counts.filter((c) => c === 1).length;
  const sent2p = counts.filter((c) => c >= 2).length;
  const sorted = [...counts].sort((a, b) => a - b);
  const pct = (n: number) => `${((100 * n) / total).toFixed(1)}%`;

  console.log('\n=== transactions sent from the voter\'s own address during the window ===');
  console.log(`  0  (voted through a relayer, a multisig or a delegate contract) : ${sent0} (${pct(sent0)})`);
  console.log(`  1  (the vote and nothing else)                                  : ${sent1} (${pct(sent1)})`);
  console.log(`  2+ (the vote plus other ordinary traffic)                       : ${sent2p} (${pct(sent2p)})`);
  console.log(`  median : ${sorted[Math.floor(total / 2)]}`);
  console.log(`  mean   : ${(counts.reduce((a, b) => a + b, 0) / total).toFixed(2)}`);
  const eoa = total - sent0;
  if (eoa > 0) {
    console.log(`\n  of the ${eoa} addresses that sent any transaction at all,`);
    console.log(`  ${sent2p} (${((100 * sent2p) / eoa).toFixed(1)}%) had other traffic for a vote to hide inside.`);
  }
  const cTotal = controls.reduce((a, b) => a + b, 0);
  const cActive = controls.filter((c) => c >= 1).length;
  console.log('\n=== the same addresses over an equally long window immediately before ===');
  console.log(`  sent at least one transaction : ${cActive} (${((100 * cActive) / total).toFixed(1)}%)`);
  console.log(`  mean transactions             : ${(cTotal / total).toFixed(2)}`);
  console.log(`  during the voting window, mean: ${(counts.reduce((a, b) => a + b, 0) / total).toFixed(2)}`);
  const lTotal = longs.reduce((a, b) => a + b, 0);
  console.log(`\n=== the same addresses over the four windows before that (${4 * span} blocks) ===`);
  console.log(`  sent at least one transaction : ${longs.filter((c) => c >= 1).length} (${((100 * longs.filter((c) => c >= 1).length) / total).toFixed(1)}%)`);
  console.log(`  mean transactions per window  : ${(lTotal / total / 4).toFixed(2)}`);
  console.log('\nraw counts  :', sorted.join(','));
  console.log('raw controls:', [...controls].sort((a, b) => a - b).join(','));
}
main().catch((e) => { console.error(e); process.exit(1); });
