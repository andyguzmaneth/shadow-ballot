const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");
const realProof = require("../circuits/governor_test_calldata.json");

/**
 * Real gas measurements for Ch5 (Evaluation) — not estimates. Run via
 * `npx hardhat test test/GasBenchmarks.test.cjs`. Deliberately not assertions
 * (no expect() calls) — this is a measurement script structured as a test file
 * so it reuses the same fixtures/tooling, printed for the dissertation to cite
 * directly with a timestamp and network context (Hardhat's default in-memory
 * network gas costs match Sepolia's, since gas cost per opcode is a protocol
 * constant, not something the network varies).
 */
describe("Gas benchmarks (Ch5 evaluation data, 2026-08-19)", function () {
  it("measures gas for the full protocol lifecycle", async function () {
    const [deployer, coordinator, voter, other] = await ethers.getSigners();
    const results = {};

    async function measure(label, txPromise) {
      const tx = await txPromise;
      const receipt = await tx.wait();
      results[label] = Number(receipt.gasUsed);
    }

    // --- Deployments ---
    const Token = await ethers.getContractFactory("MockGovernanceToken");
    const token = await Token.deploy();
    await token.waitForDeployment();

    const Announcer = await ethers.getContractFactory("ERC5564Announcer");
    const announcer = await Announcer.deploy();
    await announcer.waitForDeployment();

    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    // Mint + delegate BEFORE taking the snapshot block — getPastVotes needs a
    // checkpoint showing nonzero balance strictly before the snapshot, and
    // strictly before "now" (OZ reverts/reads-zero otherwise). Order matters.
    await (await token.mint(await voter.getAddress(), ethers.parseEther("100"))).wait();
    await (await token.connect(voter).delegate(await voter.getAddress())).wait();
    const snapshotBlock = await ethers.provider.getBlockNumber();
    await mine(1);

    const Registry = await ethers.getContractFactory("VoterRegistry");
    const registry = await Registry.deploy(await token.getAddress(), snapshotBlock);
    await registry.waitForDeployment();

    const Governor = await ethers.getContractFactory("ShadowBallotGovernor");
    const governorDeployTx = await Governor.getDeployTransaction(
      await token.getAddress(),
      await coordinator.getAddress(),
      await verifier.getAddress(),
      1,
      50,
      0,
      4
    );
    const governorDeployReceipt = await (await deployer.sendTransaction(governorDeployTx)).wait();
    results["Deploy: ShadowBallotGovernor (full contract)"] = Number(governorDeployReceipt.gasUsed);
    const governor = await ethers.getContractAt(
      "ShadowBallotGovernor",
      ethers.getCreateAddress({ from: await deployer.getAddress(), nonce: await deployer.getNonce() - 1 })
    );

    // --- Per-operation costs ---
    await measure("VoterRegistry.register()", registry.connect(voter).register(ethers.keccak256(ethers.toUtf8Bytes("commitment"))));

    await measure(
      "ERC5564Announcer.announce() — publishing R for one vote",
      announcer.connect(voter).announce(1, await other.getAddress(), "0x02" + "ab".repeat(32), "0x00")
    );

    const proposeTx = await governor
      .connect(voter)
      .propose([ethers.ZeroAddress], [0n], ["0x"], "Governor+ZK integration test proposal");
    const proposeReceipt = await proposeTx.wait();
    results["Governor.propose()"] = Number(proposeReceipt.gasUsed);

    await mine(2);

    const proposalId = 12280267269118964162074120570471313527636478466938788729469457698995197180351n;
    const root = "0x" + BigInt(realProof.pubSignals[0]).toString(16).padStart(64, "0");
    await measure("GovernorAnamorphicCounting.setEligibilityRoot()", governor.connect(coordinator).setEligibilityRoot(proposalId, root));

    await measure(
      "GovernorAnamorphicCounting.registerEligibleNullifier() — includes on-chain Groth16 verification, the expensive one",
      governor.registerEligibleNullifier(proposalId, realProof.pA, realProof.pB, realProof.pC, realProof.pubSignals)
    );

    await mine(51);

    const nullifier = "0x" + BigInt(realProof.pubSignals[1]).toString(16).padStart(64, "0");
    await measure(
      "GovernorAnamorphicCounting.submitAnamorphicTally() — 1 nullifier",
      governor.connect(coordinator).submitAnamorphicTally(proposalId, ethers.parseEther("50"), 0, 0, [nullifier])
    );

    console.log("\n=== GAS BENCHMARK RESULTS (2026-08-19, Hardhat in-memory network) ===");
    for (const [label, gas] of Object.entries(results)) {
      console.log(`${label}: ${gas.toLocaleString()} gas`);
    }
    console.log("=======================================================\n");
  });

  it("measures the vanilla OpenZeppelin Governor baseline (Ch5 §5.3 comparative matrix)", async function () {
    const [deployer, voter] = await ethers.getSigners();
    const results = {};

    const Token = await ethers.getContractFactory("MockGovernanceToken");
    const token = await Token.deploy();
    await token.waitForDeployment();
    await (await token.mint(await voter.getAddress(), ethers.parseEther("100"))).wait();
    await (await token.connect(voter).delegate(await voter.getAddress())).wait();
    await mine(1);

    const Vanilla = await ethers.getContractFactory("VanillaGovernor");
    const vanillaDeployTx = await Vanilla.getDeployTransaction(await token.getAddress(), 1, 50, 0, 4);
    const vanillaDeployReceipt = await (await deployer.sendTransaction(vanillaDeployTx)).wait();
    results["Deploy: VanillaGovernor (standard OZ composition, no custom counting)"] = Number(vanillaDeployReceipt.gasUsed);
    const vanilla = await ethers.getContractAt(
      "VanillaGovernor",
      ethers.getCreateAddress({ from: await deployer.getAddress(), nonce: await deployer.getNonce() - 1 })
    );

    const proposeTx = await vanilla.connect(voter).propose([ethers.ZeroAddress], [0n], ["0x"], "Vanilla baseline proposal");
    const proposeReceipt = await proposeTx.wait();
    results["VanillaGovernor.propose()"] = Number(proposeReceipt.gasUsed);

    await mine(2);

    const proposalId = await vanilla.hashProposal(
      [ethers.ZeroAddress],
      [0n],
      ["0x"],
      ethers.keccak256(ethers.toUtf8Bytes("Vanilla baseline proposal"))
    );
    const voteTx = await vanilla.connect(voter).castVote(proposalId, 1); // 1 = For
    const voteReceipt = await voteTx.wait();
    results["VanillaGovernor.castVote() — the standard per-voter on-chain vote, this dissertation's protocol replaces"] = Number(
      voteReceipt.gasUsed
    );

    console.log("\n=== VANILLA GOVERNOR BASELINE (Ch5 §5.3, 2026-08-19) ===");
    for (const [label, gas] of Object.entries(results)) {
      console.log(`${label}: ${gas.toLocaleString()} gas`);
    }
    console.log("=======================================================\n");
  });
});
