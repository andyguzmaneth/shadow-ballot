const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

const BN254_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * State-machine / tally-submission tests for ShadowBallotGovernor +
 * GovernorAnamorphicCounting. Uses MockAlwaysValidVerifier (test-only, always
 * returns true) so these tests can exercise registration bookkeeping (root
 * checks, proposalId matching, nullifier uniqueness, tally logic) without
 * generating a fresh real Groth16 proof per scenario. Real proof verification
 * against the actual compiled circuit is separately tested in
 * GovernorZkIntegration.test.cjs — updated 2026-08-19 when
 * registerEligibleNullifier replaced blind nullifier acceptance in
 * submitAnamorphicTally.
 */
describe("ShadowBallotGovernor", function () {
  const VOTING_DELAY = 1; // blocks
  const VOTING_PERIOD = 50; // blocks
  const PROPOSAL_THRESHOLD = 0;
  const QUORUM_NUMERATOR = 4; // 4% of total supply
  const FAKE_ROOT = ethers.keccak256(ethers.toUtf8Bytes("test-eligibility-root"));
  const DUMMY_PROOF_POINT = [0n, 0n];
  const DUMMY_PROOF_B = [
    [0n, 0n],
    [0n, 0n],
  ];

  async function deploy() {
    const [deployer, coordinator, holder1, holder2, holder3, attacker] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockGovernanceToken");
    const token = await Token.deploy();
    await token.waitForDeployment();

    // Mint and self-delegate — ERC20Votes requires an explicit delegation before
    // a balance counts as voting power at any checkpoint. Easy to miss and get
    // a confusing "quorum never reached" failure instead of an obvious error.
    for (const holder of [holder1, holder2, holder3]) {
      await (await token.mint(await holder.getAddress(), ethers.parseEther("100"))).wait();
      await (await token.connect(holder).delegate(await holder.getAddress())).wait();
    }
    await mine(1); // checkpoint needs the next block to be mined before it's queryable

    const Verifier = await ethers.getContractFactory("MockAlwaysValidVerifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    const tokenAddress = await token.getAddress();
    const Governor = await ethers.getContractFactory("ShadowBallotGovernor");
    const governor = await Governor.deploy(
      tokenAddress,
      await coordinator.getAddress(),
      await verifier.getAddress(),
      VOTING_DELAY,
      VOTING_PERIOD,
      PROPOSAL_THRESHOLD,
      QUORUM_NUMERATOR
    );
    await governor.waitForDeployment();

    return { token, governor, deployer, coordinator, holder1, holder2, holder3, attacker };
  }

  async function proposeAndAdvanceToActive(governor, proposer, description = "Test proposal") {
    const targets = [ethers.ZeroAddress];
    const values = [0n];
    const calldatas = ["0x"];

    const tx = await governor.connect(proposer).propose(targets, values, calldatas, description);
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return governor.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "ProposalCreated");
    const proposalId = event.args.proposalId;

    await mine(VOTING_DELAY + 1); // past voting delay -> Active
    return { proposalId, targets, values, calldatas, description };
  }

  function fakeNullifier(seed) {
    return ethers.keccak256(ethers.toUtf8Bytes(seed));
  }

  /**
   * Goes through the real registerEligibleNullifier path (mock verifier
   * accepts any pA/pB/pC) rather than faking the bookkeeping directly — these
   * tests exercise submitAnamorphicTally's requirement that nullifiers were
   * actually registered, so registration has to actually happen first.
   */
  async function registerFakeNullifier(governor, coordinator, proposalId, nullifier) {
    const existingRoot = await governor.eligibilityRoot(proposalId);
    if (existingRoot === ethers.ZeroHash) {
      await (await governor.connect(coordinator).setEligibilityRoot(proposalId, FAKE_ROOT)).wait();
    }
    const reducedProposalId = BigInt(proposalId) % BN254_SCALAR_FIELD;
    const pubSignals = [BigInt(FAKE_ROOT), BigInt(nullifier), reducedProposalId];
    await (
      await governor.registerEligibleNullifier(proposalId, DUMMY_PROOF_POINT, DUMMY_PROOF_B, DUMMY_PROOF_POINT, pubSignals)
    ).wait();
  }

  it("direct castVote() is disabled — the core architectural point of this integration", async function () {
    const { governor, holder1 } = await deploy();
    const { proposalId } = await proposeAndAdvanceToActive(governor, holder1);

    expect(await governor.state(proposalId)).to.equal(1n); // ProposalState.Active

    // holder1 has real voting weight (100 tokens, delegated) but standard castVote
    // must still fail — nobody should be able to vote the normal Governor way here.
    await expect(governor.connect(holder1).castVote(proposalId, 1)).to.be.revertedWithCustomError(
      governor,
      "DirectVotingDisabled"
    );
  });

  it("state() holds at Active past the deadline until the coordinator submits — the fix for the premature-Defeated bug", async function () {
    const { governor, holder1 } = await deploy();
    const { proposalId } = await proposeAndAdvanceToActive(governor, holder1);

    await mine(VOTING_PERIOD + 1); // past the voting deadline, no tally submitted yet

    // Base Governor logic would report Defeated here (0 votes tallied, quorum not
    // reached) — that's exactly the bug §GovernorAnamorphicCounting's doc comment
    // describes. Confirm the override actually prevents it.
    expect(await governor.state(proposalId)).to.equal(1n); // still Active, not Defeated
  });

  it("rejects a tally submission before the voting deadline has passed", async function () {
    const { governor, coordinator, holder1 } = await deploy();
    const { proposalId } = await proposeAndAdvanceToActive(governor, holder1);
    await registerFakeNullifier(governor, coordinator, proposalId, fakeNullifier("early"));
    // Deliberately NOT advancing past VOTING_PERIOD.

    await expect(
      governor.connect(coordinator).submitAnamorphicTally(
        proposalId,
        ethers.parseEther("50"),
        0,
        0,
        [fakeNullifier("early")]
      )
    ).to.be.revertedWithCustomError(governor, "VotingNotYetClosed");
  });

  it("rejects a tally submission from anyone other than the coordinator", async function () {
    const { governor, coordinator, holder1, attacker } = await deploy();
    const { proposalId } = await proposeAndAdvanceToActive(governor, holder1);
    await registerFakeNullifier(governor, coordinator, proposalId, fakeNullifier("x"));
    await mine(VOTING_PERIOD + 1);

    await expect(
      governor.connect(attacker).submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, [fakeNullifier("x")])
    ).to.be.revertedWithCustomError(governor, "NotCoordinator");
  });

  it("accepts a coordinator tally submission and resolves state correctly (quorum met, for > against -> Succeeded)", async function () {
    const { governor, coordinator, holder1 } = await deploy();
    const { proposalId } = await proposeAndAdvanceToActive(governor, holder1);
    const nullifiers = [fakeNullifier("voter-a"), fakeNullifier("voter-b")];
    for (const n of nullifiers) await registerFakeNullifier(governor, coordinator, proposalId, n);
    await mine(VOTING_PERIOD + 1);

    const forVotes = ethers.parseEther("50"); // > 4% of 300 total supply (12) -> quorum met

    await expect(governor.connect(coordinator).submitAnamorphicTally(proposalId, forVotes, 0, 0, nullifiers))
      .to.emit(governor, "AnamorphicTallySubmitted")
      .withArgs(proposalId, forVotes, 0, 0, nullifiers.length);

    const [against, forV, abstain] = await governor.proposalVotes(proposalId);
    expect(against).to.equal(0n);
    expect(forV).to.equal(forVotes);
    expect(abstain).to.equal(0n);

    expect(await governor.state(proposalId)).to.equal(4n); // ProposalState.Succeeded
    expect(await governor.nullifierUsed(nullifiers[0])).to.be.true;
    expect(await governor.nullifierUsed(nullifiers[1])).to.be.true;
  });

  it("resolves to Defeated when against > for, even with quorum met", async function () {
    const { governor, coordinator, holder1 } = await deploy();
    const { proposalId } = await proposeAndAdvanceToActive(governor, holder1);
    const nullifier = fakeNullifier("v");
    await registerFakeNullifier(governor, coordinator, proposalId, nullifier);
    await mine(VOTING_PERIOD + 1);

    await governor
      .connect(coordinator)
      .submitAnamorphicTally(proposalId, ethers.parseEther("30"), ethers.parseEther("60"), 0, [nullifier]);

    expect(await governor.state(proposalId)).to.equal(3n); // ProposalState.Defeated
  });

  it("rejects a second tally submission for the same proposal", async function () {
    const { governor, coordinator, holder1 } = await deploy();
    const { proposalId } = await proposeAndAdvanceToActive(governor, holder1);
    const first = fakeNullifier("first");
    const second = fakeNullifier("second");
    await registerFakeNullifier(governor, coordinator, proposalId, first);
    await registerFakeNullifier(governor, coordinator, proposalId, second);
    await mine(VOTING_PERIOD + 1);

    // The tally must cite every registered nullifier, so this submission
    // carries both. Sorted: submitAnamorphicTally requires strictly ascending.
    const bothSorted = [first, second].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    await governor.connect(coordinator).submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, bothSorted);

    await expect(
      governor.connect(coordinator).submitAnamorphicTally(proposalId, ethers.parseEther("999"), 0, 0, [second])
    ).to.be.revertedWithCustomError(governor, "TallyAlreadySubmitted");
  });

  it("rejects registering the same nullifier twice, including across different proposals", async function () {
    const { governor, coordinator, holder1, holder2 } = await deploy();
    const { proposalId: proposalA } = await proposeAndAdvanceToActive(governor, holder1, "Proposal A");
    const { proposalId: proposalB } = await proposeAndAdvanceToActive(governor, holder2, "Proposal B");

    const sharedNullifier = fakeNullifier("reused-nullifier");
    await registerFakeNullifier(governor, coordinator, proposalA, sharedNullifier);

    // An honest circuit never produces the same nullifier for two different
    // proposalIds (Poseidon(secret, proposalId) is proposalId-bound by
    // construction) — this is a defense against a malformed/replayed input,
    // not a scenario honest usage would ever hit. Caught at REGISTRATION time
    // now, not at tally-submission time as an earlier version of this test
    // (pre-ZK-wiring) checked — the on-chain flow changed on 2026-08-19.
    await expect(
      registerFakeNullifier(governor, coordinator, proposalB, sharedNullifier)
    ).to.be.revertedWithCustomError(governor, "NullifierAlreadyUsed");
  });

  it("submitAnamorphicTally rejects a tally that omits a registered voter", async function () {
    // Censorship by omission: the coordinator decodes every vote, then cites
    // only the nullifiers whose choices suit it. Before the completeness
    // check this was accepted silently.
    const { governor, coordinator, holder1 } = await deploy();
    const { proposalId } = await proposeAndAdvanceToActive(governor, holder1);
    const a = fakeNullifier("omit-a");
    const b = fakeNullifier("omit-b");
    await registerFakeNullifier(governor, coordinator, proposalId, a);
    await registerFakeNullifier(governor, coordinator, proposalId, b);
    await mine(VOTING_PERIOD + 1);

    expect(await governor.registeredNullifierCount(proposalId)).to.equal(2n);

    await expect(
      governor.connect(coordinator).submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, [a])
    ).to.be.revertedWithCustomError(governor, "TallyOmitsRegisteredVoters");
  });

  it("submitAnamorphicTally rejects a repeated nullifier padding the count", async function () {
    const { governor, coordinator, holder1 } = await deploy();
    const { proposalId } = await proposeAndAdvanceToActive(governor, holder1);
    const a = fakeNullifier("dup-a");
    const b = fakeNullifier("dup-b");
    await registerFakeNullifier(governor, coordinator, proposalId, a);
    await registerFakeNullifier(governor, coordinator, proposalId, b);
    await mine(VOTING_PERIOD + 1);

    // Two entries, so the count matches, but the same one twice.
    await expect(
      governor.connect(coordinator).submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, [a, a])
    ).to.be.revertedWithCustomError(governor, "NullifiersNotStrictlyAscending");
  });

  it("submitAnamorphicTally rejects a nullifier registered for a DIFFERENT proposal", async function () {
    const { governor, coordinator, holder1, holder2 } = await deploy();
    const { proposalId: proposalA } = await proposeAndAdvanceToActive(governor, holder1, "Proposal A2");
    const { proposalId: proposalB } = await proposeAndAdvanceToActive(governor, holder2, "Proposal B2");

    const nullifierForA = fakeNullifier("belongs-to-a");
    await registerFakeNullifier(governor, coordinator, proposalA, nullifierForA);
    await mine(VOTING_PERIOD + 1);

    await expect(
      governor.connect(coordinator).submitAnamorphicTally(proposalB, ethers.parseEther("50"), 0, 0, [nullifierForA])
    ).to.be.revertedWithCustomError(governor, "NullifierNotRegisteredForProposal");
  });
});
