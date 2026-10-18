const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Tests the fix for the eligibility-soundness gap found 2026-08-18 (see
 * VoterRegistry.sol's doc comment and dissertation Ch3 §3.4.3): only the real
 * holder of an address can register a commitment for it, closing the "anyone
 * can forge eligibility for anyone" hole in the naive version of the ZK
 * eligibility circuit.
 *
 * Changed 2026-10-18: registration no longer decides eligibility for any
 * proposal. The gate is current voting power, a spam check only. Per-proposal
 * eligibility is settled off-chain when that proposal's Merkle tree is built,
 * against its own snapshot — see the eligibility-filter tests in
 * src/lib/merkle.test.ts.
 */
describe("VoterRegistry", function () {

  async function deploy() {
    const [eligibleVoter, ineligibleVoter, attacker] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockVotesToken");
    const token = await MockToken.deploy();
    await token.waitForDeployment();

    const eligibleAddr = await eligibleVoter.getAddress();
    await (await token.setVotes(eligibleAddr, 100)).wait(); // holds voting power now
    // ineligibleVoter and attacker are left at 0 — they have never held the token.

    const Registry = await ethers.getContractFactory("VoterRegistry");
    const tokenAddress = await token.getAddress();
    const registry = await Registry.deploy(tokenAddress);
    await registry.waitForDeployment();

    return { registry, token, eligibleVoter, ineligibleVoter, attacker };
  }

  function fakeCommitment(seed) {
    return ethers.keccak256(ethers.toUtf8Bytes(seed));
  }

  it("lets a token holder register a commitment", async function () {
    const { registry, eligibleVoter } = await deploy();
    const commitment = fakeCommitment("voter-secret-1");

    await expect(registry.connect(eligibleVoter).register(commitment))
      .to.emit(registry, "VoterRegistered")
      .withArgs(await eligibleVoter.getAddress(), commitment);

    expect(await registry.commitmentOf(await eligibleVoter.getAddress())).to.equal(commitment);
    expect(await registry.isRegistered(await eligibleVoter.getAddress())).to.be.true;
  });

  it("rejects registration from an address that has never held the token — the spam gate", async function () {
    const { registry, ineligibleVoter } = await deploy();
    const commitment = fakeCommitment("attacker-secret");

    await expect(registry.connect(ineligibleVoter).register(commitment)).to.be.revertedWith(
      "no voting power at registration"
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
    ).to.be.revertedWith("no voting power at registration"); // attacker holds nothing of their own
  });

  it("a holder who later sells keeps its commitment on file — eligibility is NOT decided here", async function () {
    // The point of the 2026-10-18 change. Registration is permanent and says
    // nothing about any proposal. Whether this address counts for a given
    // proposal is settled when that proposal's tree is built, against its own
    // snapshot. Before the change, selling out left the holder able to prove
    // eligibility forever.
    const { registry, token, eligibleVoter } = await deploy();
    const addr = await eligibleVoter.getAddress();
    const commitment = fakeCommitment("sells-later");
    await (await registry.connect(eligibleVoter).register(commitment)).wait();

    await (await token.setVotes(addr, 0)).wait(); // sells every token

    expect(await registry.commitmentOf(addr)).to.equal(commitment);
    expect(await token.getVotes(addr)).to.equal(0n);
  });

  it("an address that acquires tokens later can still register", async function () {
    // The other direction of the old bug: a single immutable snapshotBlock
    // locked out everyone who bought in afterwards, permanently.
    const { registry, token, ineligibleVoter } = await deploy();
    const addr = await ineligibleVoter.getAddress();
    const commitment = fakeCommitment("buys-later");

    await expect(registry.connect(ineligibleVoter).register(commitment)).to.be.revertedWith(
      "no voting power at registration"
    );

    await (await token.setVotes(addr, 50)).wait(); // acquires tokens

    await expect(registry.connect(ineligibleVoter).register(commitment))
      .to.emit(registry, "VoterRegistered")
      .withArgs(addr, commitment);
  });
});
