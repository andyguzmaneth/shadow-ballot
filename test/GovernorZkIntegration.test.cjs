const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const realProof = require("../circuits/governor_test_calldata.json");

/**
 * The actual end-to-end validation of wiring circuits/eligibility.circom into
 * ShadowBallotGovernor (2026-08-19) — not a mock proof, not a placeholder
 * proposal ID. This test uses:
 *   - The REAL Groth16Verifier.sol exported from the circuit compiled and
 *     proven on the dev VM (see circuits/eligibility.circom's status note).
 *   - A REAL proof generated for the EXACT proposalId this test's proposal
 *     produces on-chain (computed via Governor.hashProposal's own formula,
 *     off-chain, then used as the circuit's proposalId input — see
 *     circuits/gen-test-input.mjs and GovernorAnamorphicCounting.sol's
 *     BN254_SCALAR_FIELD doc comment for why that reduction step exists).
 *
 * If this test passes, the ZK eligibility proof and the Governor integration
 * are genuinely one pipeline, not two pieces that happen to compile together.
 */
describe("Governor + ZK eligibility integration (real proof, real proposal ID)", function () {
  // Must match circuits/gen-test-input.mjs's proposal parameters exactly —
  // Governor.hashProposal is deterministic over these four values, and the
  // proof in governor_test_calldata.json was generated for the ID they produce.
  const TARGETS = [ethers.ZeroAddress];
  const VALUES = [0n];
  const CALLDATAS = ["0x"];
  const DESCRIPTION = "Governor+ZK integration test proposal";
  const EXPECTED_PROPOSAL_ID = 12280267269118964162074120570471313527636478466938788729469457698995197180351n;
  const EXPECTED_ROOT = "0x" + BigInt(realProof.pubSignals[0]).toString(16).padStart(64, "0");

  const VOTING_DELAY = 1;
  const VOTING_PERIOD = 50;

  async function deploy() {
    const [deployer, coordinator, proposer] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockGovernanceToken");
    const token = await Token.deploy();
    await token.waitForDeployment();
    await (await token.mint(await proposer.getAddress(), ethers.parseEther("100"))).wait();
    await (await token.connect(proposer).delegate(await proposer.getAddress())).wait();
    await mine(1);

    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    const Governor = await ethers.getContractFactory("ShadowBallotGovernor");
    const governor = await Governor.deploy(
      await token.getAddress(),
      await coordinator.getAddress(),
      await verifier.getAddress(),
      VOTING_DELAY,
      VOTING_PERIOD,
      0,
      4
    );
    await governor.waitForDeployment();

    return { token, verifier, governor, coordinator, proposer };
  }

  it("Governor computes the exact proposalId the real proof was generated for", async function () {
    const { governor } = await deploy();
    const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(DESCRIPTION));
    const onChainId = await governor.hashProposal(TARGETS, VALUES, CALLDATAS, descriptionHash);
    expect(onChainId).to.equal(EXPECTED_PROPOSAL_ID);
  });

  it("registers a real ZK proof on-chain and accepts it into the tally — the full pipeline", async function () {
    const { governor, coordinator, proposer } = await deploy();

    const tx = await governor.connect(proposer).propose(TARGETS, VALUES, CALLDATAS, DESCRIPTION);
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
    expect(proposalId).to.equal(EXPECTED_PROPOSAL_ID);

    await governor.connect(coordinator).setEligibilityRoot(proposalId, EXPECTED_ROOT);

    // Real Groth16 proof, verified on-chain by the real exported verifier —
    // not a stub, not a mock return value.
    await expect(
      governor.registerEligibleNullifier(proposalId, realProof.pA, realProof.pB, realProof.pC, realProof.pubSignals)
    )
      .to.emit(governor, "NullifierRegistered")
      .withArgs(proposalId, "0x" + BigInt(realProof.pubSignals[1]).toString(16).padStart(64, "0"));

    const nullifier = "0x" + BigInt(realProof.pubSignals[1]).toString(16).padStart(64, "0");
    expect(await governor.nullifierUsed(nullifier)).to.be.true;

    await mine(VOTING_DELAY + VOTING_PERIOD + 1);

    await expect(
      governor.connect(coordinator).submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, [nullifier])
    ).to.emit(governor, "AnamorphicTallySubmitted");

    expect(await governor.state(proposalId)).to.equal(4n); // Succeeded
  });

  it("rejects a tampered proof — the real verifier actually checks, not just returns true", async function () {
    const { governor, coordinator, proposer } = await deploy();
    const tx = await governor.connect(proposer).propose(TARGETS, VALUES, CALLDATAS, DESCRIPTION);
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

    await governor.connect(coordinator).setEligibilityRoot(proposalId, EXPECTED_ROOT);

    const tamperedPA = [realProof.pA[0], realProof.pA[1].slice(0, -1) + (realProof.pA[1].endsWith("0") ? "1" : "0")];

    await expect(
      governor.registerEligibleNullifier(proposalId, tamperedPA, realProof.pB, realProof.pC, realProof.pubSignals)
    ).to.be.revertedWithCustomError(governor, "InvalidEligibilityProof");
  });

  it("rejects a real, valid proof if the eligibility root wasn't set for this proposal", async function () {
    const { governor, proposer } = await deploy();
    const tx = await governor.connect(proposer).propose(TARGETS, VALUES, CALLDATAS, DESCRIPTION);
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
    // Deliberately not calling setEligibilityRoot.

    await expect(
      governor.registerEligibleNullifier(proposalId, realProof.pA, realProof.pB, realProof.pC, realProof.pubSignals)
    ).to.be.revertedWithCustomError(governor, "EligibilityRootNotSet");
  });

  it("submitAnamorphicTally rejects a nullifier that was never registered via a real proof", async function () {
    const { governor, coordinator, proposer } = await deploy();
    const tx = await governor.connect(proposer).propose(TARGETS, VALUES, CALLDATAS, DESCRIPTION);
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

    await mine(VOTING_DELAY + VOTING_PERIOD + 1);

    const madeUpNullifier = ethers.keccak256(ethers.toUtf8Bytes("never-registered"));
    await expect(
      governor.connect(coordinator).submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, [madeUpNullifier])
    ).to.be.revertedWithCustomError(governor, "NullifierNotRegisteredForProposal");
  });
});
