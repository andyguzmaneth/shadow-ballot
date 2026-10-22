/**
 * The sender's base rate, across several DAOs (dissertation Ch5 §5.1c).
 *
 * Participation non-observability reduces to one empirical question: when a
 * real DAO voter casts a vote, does that transaction stand out as unusual
 * activity from their address, or does the address transact anyway?
 *
 * Method. For each Governor, find recent proposals whose voting window has
 * closed. For each, read the VoteCast logs for the addresses that voted, then
 * read each address's account nonce at four block heights: the start of the
 * four windows preceding the vote, the start of the window preceding it, the
 * start of the voting window, and its end. Differences give exactly how many
 * transactions that address sent in each period — no indexer and no
 * heuristics, because the nonce is consensus state.
 *
 * The control periods are the point. The question is not whether voters
 * transact, but whether voting makes them transact more than they otherwise
 * would, which is what decides how much ordinary traffic a vote could hide in.
 *
 *   INFURA_API_KEY=... npx tsx scripts/base-rate.ts
 */
import { JsonRpcProvider, Contract, Interface, Network, FetchRequest } from 'ethers';
import { writeFileSync } from 'node:fs';

const KEY = process.env.INFURA_API_KEY!;
const RPC = `https://mainnet.infura.io/v3/${KEY}`;

// L1 Governors. OpenZeppelin Governor and GovernorBravo declare
// ProposalCreated and VoteCast with identical argument types, so one ABI
// covers both. Each address is verified on chain by calling name() rather
// than trusted from a list.
const GOVERNORS = [
  '0x323A76393544d5ecca80cd6ef2A560C6a395b7E3',
  '0x408ED6354d4973f66138C91495F2f2FCbd8724C3',
  '0xc0Da02939E1441F497fd74F78cE7Decb17B66529',
  '0x6f3E6272A167e8AcCb32072d08E0957F9c79223d',
  '0xDbD27635A534A3d3169Ef0498beB56Fb9c937489',
];

const ABI = [
  'function name() view returns (string)',
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)',
  'event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason)',
];

const CHUNK = 9_000;
const LOOKBACK = Number(process.env.LOOKBACK ?? 1_400_000);  // ~6 months
const MAX_PROPOSALS = Number(process.env.MAX_PROPOSALS ?? 3);
const MAX_VOTERS = Number(process.env.MAX_VOTERS ?? 150);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(f: () => Promise<T>, n = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e) { if (i >= n) throw e; await sleep(600 * (i + 1)); }
  }
}

interface Row {
  dao: string; governor: string; proposalId: string;
  startBlock: number; endBlock: number; voters: number;
  during: number[]; before1: number[]; before4: number[];
}

async function main() {
  if (!KEY) throw new Error('INFURA_API_KEY not set');
  const req = new FetchRequest(RPC);
  req.timeout = 60_000;
  const p = new JsonRpcProvider(req, Network.from(1), {
    batchMaxCount: 1, staticNetwork: Network.from(1),
  });
  const iface = new Interface(ABI);
  const head = await p.getBlockNumber();
  console.log('mainnet head:', head, '\n');

  const rows: Row[] = [];

  for (const addr of GOVERNORS) {
    let dao = 'unknown';
    try { dao = await new Contract(addr, ABI, p).name(); } catch { /* no name() */ }
    process.stdout.write(`${dao} (${addr.slice(0, 10)}) searching`);

    const created: any[] = [];
    for (let top = head; top > head - LOOKBACK && created.length < MAX_PROPOSALS; top -= CHUNK) {
      const got = await retry(() => p.getLogs({
        address: addr, fromBlock: top - CHUNK + 1, toBlock: top,
        topics: [iface.getEvent('ProposalCreated')!.topicHash],
      }));
      for (const l of got.reverse()) {
        const e = iface.parseLog(l)!;
        if (Number(e.args.endBlock) < head) created.push(e);
        if (created.length >= MAX_PROPOSALS) break;
      }
      if ((head - top) % (CHUNK * 20) === 0) process.stdout.write('.');
    }
    console.log(` ${created.length} closed proposal(s)`);

    for (const e of created) {
      const proposalId: bigint = e.args.proposalId;
      const startBlock = Number(e.args.startBlock);
      const endBlock = Number(e.args.endBlock);
      const span = endBlock - startBlock;

      const voters = new Set<string>();
      for (let from = startBlock; from <= endBlock; from += CHUNK) {
        const to = Math.min(from + CHUNK - 1, endBlock);
        const got = await retry(() => p.getLogs({
          address: addr, fromBlock: from, toBlock: to,
          topics: [iface.getEvent('VoteCast')!.topicHash],
        }));
        for (const l of got) {
          const v = iface.parseLog(l)!;
          if (v.args.proposalId === proposalId) voters.add(v.args.voter.toLowerCase());
        }
      }
      let list = [...voters];
      if (list.length > MAX_VOTERS) list = list.slice(0, MAX_VOTERS);
      if (!list.length) { console.log(`  proposal ${proposalId.toString().slice(0, 10)}…: no VoteCast logs, skipped`); continue; }

      const during: number[] = [], before1: number[] = [], before4: number[] = [];
      for (const a of list) {
        const n4 = await retry(() => p.getTransactionCount(a, startBlock - 4 * span));
        const n1 = await retry(() => p.getTransactionCount(a, startBlock - span));
        const n0 = await retry(() => p.getTransactionCount(a, startBlock));
        const nE = await retry(() => p.getTransactionCount(a, endBlock));
        during.push(nE - n0); before1.push(n0 - n1); before4.push(n1 - n4);
      }

      const pct = (n: number) => `${((100 * n) / list.length).toFixed(1)}%`;
      const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
      console.log(`  proposal ${proposalId.toString().slice(0, 8)}…  window ${span} blocks (~${(span * 12 / 86400).toFixed(1)} d)  voters ${list.length}`);
      console.log(`     during : ${pct(during.filter((c) => c >= 1).length)} sent >=1 tx, mean ${mean(during).toFixed(2)}`);
      console.log(`     before : ${pct(before1.filter((c) => c >= 1).length)} sent >=1 tx, mean ${mean(before1).toFixed(2)}`);
      console.log(`     4 prior: mean ${(mean(before4) / 4).toFixed(2)} per window`);
      rows.push({ dao, governor: addr, proposalId: proposalId.toString(), startBlock, endBlock, voters: list.length, during, before1, before4 });
    }
    console.log();
  }

  // Pooled across every proposal measured.
  const all = { during: [] as number[], before1: [] as number[], before4: [] as number[] };
  for (const r of rows) { all.during.push(...r.during); all.before1.push(...r.before1); all.before4.push(...r.before4); }
  const n = all.during.length;
  const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
  const share = (x: number[], f: (c: number) => boolean) => (100 * x.filter(f).length) / x.length;

  console.log('='.repeat(64));
  console.log(`POOLED: ${rows.length} proposals across ${new Set(rows.map((r) => r.dao)).size} DAOs, ${n} voter observations\n`);
  console.log(`  during the voting window : ${share(all.during, (c) => c >= 1).toFixed(1)}% sent >=1 tx, mean ${mean(all.during).toFixed(2)}`);
  console.log(`  exactly 1 tx (the vote and nothing else) : ${share(all.during, (c) => c === 1).toFixed(1)}%`);
  console.log(`  0 tx (relayer, multisig or delegate contract) : ${share(all.during, (c) => c === 0).toFixed(1)}%`);
  console.log(`  2+ tx (the vote plus other traffic) : ${share(all.during, (c) => c >= 2).toFixed(1)}%`);
  console.log(`\n  the equally long window before : ${share(all.before1, (c) => c >= 1).toFixed(1)}% sent >=1 tx, mean ${mean(all.before1).toFixed(2)}`);
  console.log(`  the four windows before that   : mean ${(mean(all.before4) / 4).toFixed(2)} per window`);

  writeFileSync('base-rate-results.json', JSON.stringify({ head, rows }, null, 1));
  console.log('\nraw data -> base-rate-results.json');
}
main().catch((e) => { console.error(e); process.exit(1); });
