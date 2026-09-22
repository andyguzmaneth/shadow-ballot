const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Tests the fix for the eligibility-soundness gap found 2026-08-18 (see
 * VoterRegistry.sol's doc comment and dissertation Ch3 §3.4.3): only the real
 * holder of an eligible address (per a token snapshot) can register a
 * commitment for that address, closing the "anyone can forge eligibility for
 * anyone" hole in the naive version of the ZK eligibility circuit.
 */
describe("VoterRegistry", function () {
  const SNAPSHOT_BLOCK = 1000;

  async function deploy() {
    const [eligibleVoter, ineligibleVoter, attacker] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockVotesToken");
    const token = await MockToken.deploy();
    await token.waitForDeployment();

    const eligibleAddr = await eligibleVoter.getAddress();
    await (await token.setPastVotes(eligibleAddr, SNAPSHOT_BLOCK, 100)).wait(); // eligible: nonzero balance at snapshot
    // ineligibleVoter and attacker are left at 0 votes — not in the snapshot.

    const Registry = await ethers.getContractFactory("VoterRegistry");
    const tokenAddress = await token.getAddress();
    const registry = await Registry.deploy(tokenAddress, SNAPSHOT_BLOCK);
    await registry.waitForDeployment();

    return { registry, token, eligibleVoter, ineligibleVoter, attacker };
  }

  function fakeCommitment(seed) {
    return ethers.keccak256(ethers.toUtf8Bytes(seed));
  }

  it("lets an eligible voter (nonzero balance at snapshot) register a commitment", async function () {
    const { registry, eligibleVoter } = await deploy();
    const commitment = fakeCommitment("voter-secret-1");

    await expect(registry.connect(eligibleVoter).register(commitment))
      .to.emit(registry, "VoterRegistered")
      .withArgs(await eligibleVoter.getAddress(), commitment);

    expect(await registry.commitmentOf(await eligibleVoter.getAddress())).to.equal(commitment);
    expect(await registry.isRegistered(await eligibleVoter.getAddress())).to.be.true;
  });

  it("rejects registration from an address with zero votes at the snapshot block — the core fix", async function () {
    const { registry, ineligibleVoter } = await deploy();
    const commitment = fakeCommitment("attacker-secret");

    // This is exactly the attack the naive circuit design was vulnerable to:
    // an outsider trying to register (and thus later prove membership for) an
    // eligible-looking commitment despite holding no tokens at snapshot.
    await expect(registry.connect(ineligibleVoter).register(commitment)).to.be.revertedWith(
      "not eligible at snapshot"
    );
  });

  it("rejects double registration from the same address", async function () {
    const { registry, eligibleVoter } = await deploy();
    await (await registry.connect(eligibleVoter).register(fakeCommitment("first"))).wait();

    await expect(registry.connect(eligibleVoter).register(fakeCommitment("second"))).to.be.revertedWith(
      "already registered"
    );
  });

  it("rejects a zero commitment", async function () {
    const { registry, eligibleVoter } = await deploy();
    await expect(
      registry.connect(eligibleVoter).register(ethers.ZeroHash)
    ).to.be.revertedWith("commitment cannot be zero");
  });

  it("an attacker cannot register a commitment on behalf of someone else's address — msg.sender is the enforcement", async function () {
    const { registry, eligibleVoter, attacker } = await deploy();

    // The attacker cannot call register() "as" eligibleVoter without eligibleVoter's
    // private key — msg.sender is set by whoever signs the transaction, not a
    // parameter the caller controls. This is what actually closes the forgery gap:
    // there is no `registerFor(address, commitment)` entry point, by design.
    await expect(
      registry.connect(attacker).register(fakeCommitment("stolen"))
    ).to.be.revertedWith("not eligible at snapshot"); // attacker has 0 votes of their own
  });
});
