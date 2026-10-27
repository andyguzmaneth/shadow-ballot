# Shadow Ballot

**Private voting hidden in plain sight.**

Shadow Ballot is a participation-deniable private voting system on Ethereum. Voters cast votes by sending normal-looking ETH transfers — the vote is cryptographically hidden inside the ECDSA signature nonce using **anamorphic signatures**. Combined with **stealth addresses** (ERC-5564), no observer can tell that a voter participated in an election at all.

## How It Works

```
Voter                           Blockchain                    Coordinator
  │                                 │                              │
  │  1. Generate ephemeral key      │                              │
  │  2. Derive stealth address      │                              │
  │  3. Encode vote in ECDSA        │                              │
  │     nonce (anamorphic sig)      │                              │
  │                                 │                              │
  │──── 0.001 ETH transfer ───────>│                              │
  │     (looks completely normal)   │                              │
  │                                 │  4. Scan stealth addresses   │
  │                                 │<─────────────────────────────│
  │                                 │  5. Extract hidden vote      │
  │                                 │     from signature nonce     │
  │                                 │  6. Tally and submit results │
  │                                 │<─────────────────────────────│
```

### Anamorphic Signatures

Every ECDSA signature uses a nonce *k*. Normally *k* is random (RFC 6979). In an anamorphic signature, *k* is derived from a shared secret and the hidden message (the vote). The resulting signature is **indistinguishable** from a normal one — but the coordinator can extract the hidden vote by brute-forcing candidate messages against the signature's *r* value.

**Paper:** [Anamorphic Signatures (CRYPTO 2023)](https://eprint.iacr.org/2023/249)

### Stealth Addresses (ERC-5564)

Each vote is sent to a one-time stealth address derived via ECDH. The ephemeral key serves double duty: it generates the stealth address AND provides the shared secret for the anamorphic signature. On a block explorer, each vote looks like a transfer to a fresh, unrelated address.

**Spec:** [ERC-5564: Stealth Addresses](https://eips.ethereum.org/EIPS/eip-5564)

## Architecture

Four modules carry the protocol: `channel.ts`, `coordinator.ts`, `tx.ts` and the `anamorphic.ts`
primitive they build on. The rest of `src/lib/` implements the earlier design, in which the vote
rode in the ECDSA nonce `k` and eligibility was proved with a zero-knowledge membership proof.
That design is kept here because `observer-experiment.ts` still generates control samples from
it; it is not part of the protocol, and the dissertation's Ch4 does not list it.

```
src/
├── config.ts              # Contract address, ABI, demo proposals, demo wallets
├── main.ts                # App shell, tab navigation
├── style.css              # Dark theme, all component styles
├── lib/
│   ├── channel.ts         # THE PROTOCOL: shared secret, channel key, stealth address,
│   │                      #   rejection sampling on r, decode
│   ├── coordinator.ts     # THE PROTOCOL: scan, tally, commitment tree
│   ├── tx.ts              # THE PROTOCOL: raw EIP-1559 tx signed with a chosen nonce
│   ├── anamorphic.ts      # ECDSA with a caller-supplied k, which the three above build on
│   ├── stealth.ts         # earlier design: ERC-5564 generation + scanning
│   ├── vote.ts            # earlier design: the vote encoded in k
│   ├── announcer.ts       # earlier design: ERC-5564 Announcer transport
│   ├── observer-experiment.ts  # Ch5 §5.2 harness, generates both groups
│   ├── wallet.ts          # Key generation, localStorage persistence
│   └── contract.ts        # ShadowBallot.sol interaction helpers
├── views/
│   ├── voter.ts           # Voter UI: proposals, vote casting, demo wallet loader
│   ├── coordinator.ts     # Coordinator UI: scan, decode, tally, submit results
│   └── explorer.ts        # Explorer UI: tx lookup, public vs hidden side-by-side reveal
contracts/
└── ShadowBallot.sol       # On-chain results registry (coordinator-only writes)
```

## Tech Stack

- **Frontend:** Vite + vanilla TypeScript (no framework)
- **Crypto:** @noble/secp256k1, @noble/hashes (browser-native)
- **Ethereum:** ethers.js v6, Sepolia testnet
- **Smart Contract:** Solidity, Hardhat 2
- **Deployment:** Static build (Vite) — deployable to Vercel/Netlify

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Run tests
npm test

# Production build
npm run build

# Preview production build
npm run preview
```

## Demo Flow

1. **Voter view** — Load a demo wallet, cast a vote on a proposal
2. **Open Etherscan** — The transaction is a plain 0.001 ETH transfer. No voting contract.
3. **Coordinator view** — Scan and decode: the hidden vote appears
4. **Explorer view** — Paste the tx hash, click "Decode Hidden Vote" for the dramatic reveal

### Demo Wallets

Pre-configured testnet wallets are available via the "Load Demo Wallet" button. Fund them with Sepolia ETH before a live demo:

| Wallet | Address |
|--------|---------|
| Demo Voter 1 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| Demo Voter 2 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| Demo Voter 3 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| Demo Voter 4 | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |
| Demo Voter 5 | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` |

## Smart Contract

```bash
# Compile
npm run compile

# Deploy to Sepolia (requires funded deployer wallet)
DEPLOYER_PRIVATE_KEY=0x... npm run deploy:sepolia
```

The contract is a minimal results registry. Only the coordinator can submit aggregated tallies. No voter ever interacts with it.

## License

MIT
