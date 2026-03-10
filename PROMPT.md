# Shadow Ballot — PRD

**Participation-deniable private voting on Ethereum using anamorphic signatures + stealth addresses**

Hackathon project. Build target: 1 day. March 2026.

## Ecosystem Context

The *State of Private Voting 2026* report (PSE + Shutter) evaluates 12 private voting protocols across 26 properties. The landscape includes mature projects (Freedom Tool, MACI V3, Semaphore V4, Shutter, SIV) and research-stage ones (Cicada, Enclave, Kite, Aragon/Aztec, DAVINCI, Incendia).

These protocols solve different subsets of voting privacy:
- **Vote privacy**: MACI, Shutter, Cicada, Incendia — hide what you voted
- **Running tally privacy**: MACI, Shutter, Cicada — hide intermediate results
- **Coercion resistance**: MACI (key change), SIV (cancel+resubmit), DAVINCI (re-encryption), Enclave (masking)
- **Censorship resistance**: Freedom Tool, Semaphore, Shutter, Incendia, DAVINCI

**What none of them solve: participation deniability.** Every protocol requires the voter to interact with a voting contract, register in a Merkle tree, or submit an encrypted ballot. An observer can always determine that a specific address participated in a specific vote.

This is not even listed as a property in the report's 26-property taxonomy. It's a blind spot.

## The Problem

On-chain voting is transparent. Even "private voting" solutions hide **what** you voted, but not **that** you voted. This matters because:

1. **Social pressure** — leaders/communities can identify and punish voters who participated in contentious proposals (report p.3)
2. **Coercion & vote buying** — a coercer can at minimum verify participation, then pressure for proof of vote content
3. **Voter profiling** — participation patterns across proposals reveal political alignment even without knowing individual votes
4. **11th hour intervention** — whales can see who has/hasn't voted and target non-participants (report p.3)

## The Insight

Combine two cryptographic primitives to achieve a property no existing protocol offers:

| Primitive | What it hides |
|-----------|--------------|
| **Stealth addresses** (ERC-5564) | WHO you're sending to — coordinator receives at a different address every time |
| **Anamorphic signatures** (CRYPTO 2023) | WHAT you're sending — your vote is hidden inside the ECDSA nonce |

Result: a voter sends what looks like a **normal ETH transfer to a random address**. No voting contract interaction. No visible participation. The coordinator scans for incoming stealth transactions and decodes the hidden votes from the signatures.

**New property introduced: Participation Deniability** — it is infeasible for anyone to determine whether an address participated in a specific vote.

## Positioning vs. Existing Protocols

| Property | MACI V3 | Shutter | Freedom Tool | Cicada | Enclave | **Shadow Ballot** |
|----------|---------|---------|-------------|--------|---------|----------------|
| Private Vote | Yes | Yes | Partial | Yes | Yes | **Yes** |
| Running Tally Privacy | Yes | Yes | No | Yes | Yes | **Yes** |
| Coercion Resistance | Yes | No | No | No | Yes | **Yes** |
| **Participation Deniability** | No | No | No | No | No | **Yes** |
| Universal Verifiability | Yes | Yes | Yes | Yes | Yes | **No** |
| Censorship Resistance | Partial | Yes | Yes | Yes | Yes | **No** |
| Implementation Simplicity | Low | Medium | Medium-High | Low | Low | **High** |

The trade-off: participation deniability at the cost of verifiability and censorship resistance (trusted coordinator). The report's Future Work #1 explicitly calls out that trust assumptions need further analysis — Shadow Ballot makes this trade-off explicit and explores a new point in the design space.

## User Flow

### Voter

1. Open Shadow Ballot web app
2. See active proposals
3. Click "Vote YES" or "Vote NO"
4. App generates a stealth address for the coordinator (from the coordinator's stealth meta-address)
5. App signs a small ETH transfer (0.001 ETH) to that stealth address
6. Hidden in the signature: `{proposalId, vote}` — encoded via anamorphic ECDSA
7. Transaction broadcasts to Sepolia
8. On Etherscan: looks like a random 0.001 ETH transfer. Nothing links it to voting.

### Coordinator

1. Open coordinator view
2. App scans for incoming stealth transactions using viewing key
3. For each detected tx, extract hidden vote from anamorphic signature
4. Display decoded votes per proposal
5. Submit aggregated result on-chain when voting closes

## Cryptographic Flow

### Setup (one-time)
```
Coordinator generates:
  - Spending keypair: (sk_spend, PK_spend)
  - Viewing keypair: (sk_view, PK_view)
  - Stealth meta-address: (PK_spend, PK_view) — published on-chain or shared

Coordinator + each voter establish:
  - Shared secret for anamorphic signatures (pre-shared or derived from ECDH)
```

### Voting
```
Voter:
  1. Generate ephemeral keypair: (p_eph, P_eph)
  2. Compute shared secret: s = p_eph * PK_view (ECDH)
  3. Derive stealth address: A_stealth = PK_spend + hash(s) * G
  4. Prepare tx: transfer 0.001 ETH to A_stealth
  5. Sign tx with anamorphic nonce: k = KDF(anamorphic_secret, tx_hash, vote_data)
  6. Broadcast tx + publish P_eph (announcement)

Coordinator:
  1. Scan announcements for P_eph values
  2. For each: compute s' = sk_view * P_eph
  3. Derive expected stealth address, check if tx recipient matches
  4. If match: extract vote from signature using anamorphic shared secret
  5. Tally votes
```

### Vote Encoding

Hidden message space is small (brute-force extraction). Use a compact encoding:

```
vote_data = proposalId (1 byte) || vote (1 byte: 0x01=YES, 0x02=NO, 0x03=ABSTAIN)
```

Candidate set for extraction: for each proposalId, try YES/NO/ABSTAIN = 3 candidates per proposal.

## Architecture

### Smart Contract (Solidity, Sepolia)

Minimal — just stores results:

```
ShadowBallot.sol:
  - createProposal(string title, uint deadline) → proposalId
  - submitResults(uint proposalId, uint yes, uint no, uint abstain) — coordinator only
  - getProposal(uint proposalId) → (title, deadline, yes, no, abstain, finalized)
```

No voter interaction with this contract. That's the point.

### Web App (Static, vanilla JS)

Three views:

**1. Voter View (default)**
- List of active proposals
- Vote buttons (YES / NO / ABSTAIN)
- Generate keypair on first visit (stored in localStorage for demo)
- Fund from Sepolia faucet or pre-funded
- Sign + broadcast anamorphic tx
- Show tx hash + Etherscan link ("look, it's just a transfer")

**2. Coordinator View**
- Scan for stealth transactions
- Decode hidden votes
- Show vote tally per proposal
- "Submit Results" button → calls contract

**3. Explorer View (the demo moment)**
- Paste any tx hash from the voting
- Show: "On Etherscan, this looks like a 0.001 ETH transfer to 0xabc..."
- Decode: "Actually, this is a YES vote on Proposal #1"
- Side-by-side comparison: what the world sees vs. what's hidden

### Crypto Library (JS, browser)

Port the existing Node.js anamorphic-ecdsa.js to browser-compatible JS:
- `signWithCustomNonce(privateKey, msgHash, k)` — ECDSA with controlled nonce
- `deriveNonceFromSecret(secret, msg, hiddenData)` — KDF for anamorphic nonce
- `extractHiddenMessage(sig, msg, secret, candidates)` — brute-force decode
- Stealth address generation (simplified ERC-5564 ECDH)
- Transaction signing (raw tx construction, no MetaMask — custom signer)

### Dependencies

- `ethers.js` (v6) — tx construction, provider, contract interaction
- `elliptic` — secp256k1 operations (or noble-secp256k1 for browser)
- `js-sha3` — keccak256
- No framework — vanilla HTML/CSS/JS for speed

## Custom Signer Approach

MetaMask/standard wallets don't expose nonce `k` control. For the hackathon:

1. App generates a secp256k1 keypair in the browser
2. Derives Ethereum address from it
3. User funds it from a faucet (or we pre-fund demo accounts)
4. App signs raw transactions with custom nonce using elliptic.js
5. Broadcasts via ethers.js provider

This is fine for a demo. A production version would need a custom wallet or wallet plugin.

## Privacy Properties

| Property | Status |
|----------|--------|
| **Voter-proposal unlinkability** | YES — no interaction with voting contract |
| **Voter identity hidden** | YES — tx goes to a one-time stealth address |
| **Vote content hidden** | YES — encoded in signature nonce, looks like normal sig |
| **Participation hidden** | YES — tx looks like a random ETH transfer |
| **Coercion resistance** | YES — coercer can't verify how you voted (or if you voted) |
| **Publicly verifiable tally** | NO — coordinator is trusted (future: threshold talliers) |

## What Makes This Novel

1. **New property in the taxonomy** — Participation Deniability is not addressed by any of the 12 protocols in the State of Private Voting 2026 report. Shadow Ballot is the first to propose it as an explicit design goal.
2. **Stealth addresses + anamorphic signatures** — two recent cryptographic primitives (ERC-5564, 2023; CRYPTO 2023 paper) combined for the first time. Neither achieves participation deniability alone.
3. **Zero voting footprint** — unlike MACI/Shutter/Freedom Tool which hide your vote but reveal participation, this hides everything. On-chain, it's indistinguishable from a normal ETH transfer.
4. **No special infrastructure** — uses standard Ethereum transactions. No custom L2, relayer network, ZK circuits, or MPC ceremony. The crypto happens entirely in the signature.
5. **The demo is visceral** — "this Etherscan transfer? it's actually a vote"

## Build Plan

### Phase 1: Crypto Core (2-3 hours)
- [ ] Port anamorphic-ecdsa to browser JS (noble-secp256k1 or elliptic)
- [ ] Implement stealth address generation (simplified ERC-5564)
- [ ] Implement stealth address scanning
- [ ] Raw transaction signing with custom nonce
- [ ] Test: sign → broadcast → scan → decode round trip

### Phase 2: Smart Contract (1 hour)
- [ ] ShadowBallot.sol — createProposal, submitResults, getProposal
- [ ] Deploy to Sepolia
- [ ] Verify on Etherscan

### Phase 3: Web App (3-4 hours)
- [ ] Voter view: proposal list, vote buttons, tx signing + broadcast
- [ ] Coordinator view: scan, decode, tally, submit
- [ ] Explorer view: tx decode side-by-side
- [ ] Dark theme, clean UI
- [ ] Pre-funded demo accounts for smooth presentation

### Phase 4: Demo Polish (1 hour)
- [ ] Pre-create 2-3 proposals
- [ ] Walk-through flow works end-to-end
- [ ] Etherscan links work
- [ ] Error handling for failed txs

## Name & Branding

**Shadow Ballot** — Private voting hidden in plain sight.

Tagline: "Your vote. Your secret. Their blockchain."

## Future (Post-Hackathon)

- **Threshold talliers** — replace single trusted coordinator with threshold secret sharing (addresses Future Work #1 from the report: reducing trust assumptions)
- **Secret sharing with snitching** — add slashing for coordinator misbehavior (Future Work #2 from the report)
- **Wallet plugin for nonce control** — MetaMask Snap that enables anamorphic signing natively
- **Longer hidden messages** — multi-tx encoding for richer vote data (fractional/weighted voting)
- **Integration with Governor contracts** — coordinator submits results to existing DAO governance
- **View tag optimization** — faster stealth address scanning (ERC-5564 view tags)
- **Formal analysis** — prove participation deniability property under standard cryptographic assumptions
- **Combine with existing protocols** — Shadow Ballot as a front-end layer feeding into MACI or Shutter for verifiable tallying (participation deniability + universal verifiability)

## References

- State of Private Voting 2026 (PSE + Shutter) — ecosystem analysis, 26-property taxonomy
- Persiano et al., "Anamorphic Encryption" (CRYPTO 2023) — anamorphic signature foundation
- ERC-5564: Stealth Addresses — address generation mechanism
- ERC-6538: Stealth Meta-Address Registry — coordinator address publication
