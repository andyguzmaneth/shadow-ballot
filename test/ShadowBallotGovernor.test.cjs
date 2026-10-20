const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * State-machine and tally tests for ShadowBallotGovernor +
 * GovernorAnamorphicCounting (dissertation Ch3 §3.4.4, Ch4 §4.4).
 *
 * There is no eligibility circuit, no verifier and no nullifier: the voter
 * signs from the address that holds the tokens, so eligibility is settled by
 * inspection off-chain. What the contract still has to get right is the
 * Governor state machine around a tally that arrives after the deadline, and
 * the commitment that gives each voter individual verifiability (§3.4.4a).
 */
describe("ShadowBallotGovernor", function () {
  const VOTING_DELAY = 1;
  const VOTING_PERIOD = 50;
  const ROOT = ethers.keccak256(ethers.toUtf8Bytes("counted-votes-root"));

  async function deploy() {
    const [deployer, coordinator, holder1, holder2, attacker] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockGovernanceToken");
    const token = await Token.deploy();
    await token.waitForDeployment();
    for (const h of [holder1, holder2]) {
      await (await token.mint(await h.getAddress(), ethers.parseEther("100"))).wait();
      await (await token.connect(h).delegate(await h.getAddress())).wait();
    }
    await mine(1);

    const Governor = await ethers.getContractFactory("ShadowBallotGovernor");
    const governor = await Governor.deploy(
      await token.getAddress(), await coordinator.getAddress(),
      VOTING_DELAY, VOTING_PERIOD, 0, 4
    );
    await governor.waitForDeployment();
    return { token, governor, deployer, coordinator, holder1, holder2, attacker };
  }

  async function proposeAndAdvance(governor, proposer, description = "Test proposal") {
    const tx = await governor.connect(proposer)
      .propose([ethers.ZeroAddress], [0n], ["0x"], description);
    const receipt = await tx.wait();
    const ev = receipt.logs
      .map((l) => { try { return governor.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "ProposalCreated");
    await mine(VOTING_DELAY + 1);
    return ev.args.proposalId;
  }

  it("direct castVote() is disabled — the architectural point of this integration", async function () {
    const { governor, holder1 } = await deploy();
    const proposalId = await proposeAndAdvance(governor, holder1);
    await expect(governor.connect(holder1).castVote(proposalId, 1))
      .to.be.revertedWithCustomError(governor, "DirectVotingDisabled");
  });

  it("hasVoted is always false: no vote is ever attributed to an account", async function () {
    const { governor, holder1 } = await deploy();
    const proposalId = await proposeAndAdvance(governor, holder1);
    expect(await governor.hasVoted(proposalId, await holder1.getAddress())).to.be.false;
  });

  it("state() holds at Active past the deadline until the tally arrives", async function () {
    const { governor, coordinator, holder1 } = await deploy();
    const proposalId = await proposeAndAdvance(governor, holder1);
    await mine(VOTING_PERIOD + 1);
    expect(await governor.state(proposalId)).to.equal(1); // Active, not Defeated
    await (await governor.connect(coordinator)
      .submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, ROOT)).wait();
    expect(await governor.state(proposalId)).to.equal(4); // Succeeded
  });

  it("rejects a tally before the voting deadline", async function () {
    const { governor, coordinator, holder1 } = await deploy();
    const proposalId = await proposeAndAdvance(governor, holder1);
    await expect(governor.connect(coordinator)
      .submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, ROOT))
      .to.be.revertedWithCustomError(governor, "VotingNotYetClosed");
  });

  it("rejects a tally from anyone but the coordinator", async function () {
    const { governor, holder1, attacker } = await deploy();
    const proposalId = await proposeAndAdvance(governor, holder1);
    await mine(VOTING_PERIOD + 1);
    await expect(governor.connect(attacker)
      .submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, ROOT))
      .to.be.revertedWithCustomError(governor, "NotCoordinator");
  });

  it("rejects a second tally for the same proposal", async function () {
    const { governor, coordinator, holder1 } = await deploy();
    const proposalId = await proposeAndAdvance(governor, holder1);
    await mine(VOTING_PERIOD + 1);
    await (await governor.connect(coordinator)
      .submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, ROOT)).wait();
    await expect(governor.connect(coordinator)
      .submitAnamorphicTally(proposalId, ethers.parseEther("99"), 0, 0, ROOT))
      .to.be.revertedWithCustomError(governor, "TallyAlreadySubmitted");
  });

  it("resolves to Defeated when against > for, even with quorum met", async function () {
    const { governor, coordinator, holder1 } = await deploy();
    const proposalId = await proposeAndAdvance(governor, holder1);
    await mine(VOTING_PERIOD + 1);
    await (await governor.connect(coordinator).submitAnamorphicTally(
      proposalId, ethers.parseEther("30"), ethers.parseEther("60"), 0, ROOT)).wait();
    expect(await governor.state(proposalId)).to.equal(3); // Defeated
  });

  it("publishes the vote commitment, which is what gives a voter individual verifiability", async function () {
    // Ch3 §3.4.4a: every voter reconstructs their own leaf and checks inclusion.
    // The contract's job is only to make the root public and immutable.
    const { governor, coordinator, holder1 } = await deploy();
    const proposalId = await proposeAndAdvance(governor, holder1);
    await mine(VOTING_PERIOD + 1);
    expect(await governor.voteCommitmentRoot(proposalId)).to.equal(ethers.ZeroHash);
    await (await governor.connect(coordinator)
      .submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, ROOT)).wait();
    expect(await governor.voteCommitmentRoot(proposalId)).to.equal(ROOT);
  });

  it("refuses a tally with no commitment, so the coordinator cannot skip it", async function () {
    const { governor, coordinator, holder1 } = await deploy();
    const proposalId = await proposeAndAdvance(governor, holder1);
    await mine(VOTING_PERIOD + 1);
    await expect(governor.connect(coordinator)
      .submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, ethers.ZeroHash))
      .to.be.revertedWithCustomError(governor, "EmptyCommitmentRoot");
  });

  it("records the submitted breakdown verbatim", async function () {
    const { governor, coordinator, holder1 } = await deploy();
    const proposalId = await proposeAndAdvance(governor, holder1);
    await mine(VOTING_PERIOD + 1);
    await (await governor.connect(coordinator).submitAnamorphicTally(
      proposalId, ethers.parseEther("7"), ethers.parseEther("3"), ethers.parseEther("1"), ROOT)).wait();
    const [against, forV, abstain] = await governor.proposalVotes(proposalId);
    expect(forV).to.equal(ethers.parseEther("7"));
    expect(against).to.equal(ethers.parseEther("3"));
    expect(abstain).to.equal(ethers.parseEther("1"));
  });
});
