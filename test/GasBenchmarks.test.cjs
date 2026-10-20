const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Real gas measurements for Ch5, not estimates. Run via
 * `npx hardhat test test/GasBenchmarks.test.cjs`. Deliberately assertion-free:
 * a measurement script structured as a test file so it reuses the fixtures,
 * printed for the dissertation to cite with a timestamp and network context.
 * Hardhat's in-memory gas costs match Sepolia's, since cost per opcode is a
 * protocol constant.
 *
 * The protocol's per-vote on-chain cost is now an ORDINARY TRANSFER: there is
 * no registration, no proof verification and no nullifier (Ch3 §3.4). The only
 * contract calls left are the coordinator's, once per proposal.
 */
describe("Gas benchmarks (Ch5 evaluation data)", function () {
  it("measures gas for the full protocol lifecycle", async function () {
    const [deployer, coordinator, voter, other] = await ethers.getSigners();
    const results = {};

    async function measure(label, txPromise) {
      const receipt = await (await txPromise).wait();
      results[label] = Number(receipt.gasUsed);
    }

    const Token = await ethers.getContractFactory("MockGovernanceToken");
    const token = await Token.deploy();
    await token.waitForDeployment();

    await (await token.mint(await voter.getAddress(), ethers.parseEther("100"))).wait();
    await (await token.connect(voter).delegate(await voter.getAddress())).wait();
    await mine(1);

    const Registry = await ethers.getContractFactory("CoordinatorRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();

    const Governor = await ethers.getContractFactory("ShadowBallotGovernor");
    const deployTx = await Governor.getDeployTransaction(
      await token.getAddress(), await coordinator.getAddress(), 1, 50, 0, 4
    );
    const deployReceipt = await (await deployer.sendTransaction(deployTx)).wait();
    results["Deploy: ShadowBallotGovernor (full contract)"] = Number(deployReceipt.gasUsed);
    const governor = await ethers.getContractAt("ShadowBallotGovernor", deployReceipt.contractAddress);

    // Setup, once per DAO: the coordinator publishes its meta-address.
    await measure(
      "CoordinatorRegistry.publish() — once per DAO, Ch3 §3.4.2 step 1",
      registry.connect(coordinator).publish("0x02" + "ab".repeat(32), "0x03" + "cd".repeat(32))
    );

    const proposeTx = await governor.connect(voter)
      .propose([ethers.ZeroAddress], [0n], ["0x"], "Gas benchmark proposal");
    const proposeReceipt = await proposeTx.wait();
    results["Governor.propose() — per proposal"] = Number(proposeReceipt.gasUsed);
    const ev = proposeReceipt.logs
      .map((l) => { try { return governor.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "ProposalCreated");
    const proposalId = ev.args.proposalId;

    await mine(2);

    // THE VOTE. An ordinary ETH transfer to a stealth address, no calldata.
    // This is the entire on-chain cost a voter pays (Ch3 §3.4.3 step 4).
    await measure(
      "A VOTE: plain ETH transfer to a stealth address, no calldata",
      voter.sendTransaction({ to: await other.getAddress(), value: ethers.parseEther("0.0013") })
    );

    await mine(51);

    await measure(
      "GovernorAnamorphicCounting.submitAnamorphicTally() — per proposal",
      governor.connect(coordinator).submitAnamorphicTally(
        proposalId, ethers.parseEther("50"), 0, 0, ethers.keccak256(ethers.toUtf8Bytes("root"))
      )
    );

    console.log("\n=== GAS BENCHMARK RESULTS (Hardhat in-memory network) ===");
    for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v.toLocaleString()} gas`);
    console.log("=========================================================\n");
  });

  it("measures the vanilla OpenZeppelin Governor baseline (Ch5 §5.3)", async function () {
    const [deployer, voter] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockGovernanceToken");
    const token = await Token.deploy();
    await token.waitForDeployment();
    await (await token.mint(await voter.getAddress(), ethers.parseEther("100"))).wait();
    await (await token.connect(voter).delegate(await voter.getAddress())).wait();
    await mine(1);

    const Vanilla = await ethers.getContractFactory("VanillaGovernor");
    const deployTx = await Vanilla.getDeployTransaction(await token.getAddress(), 1, 50, 0, 4);
    const receipt = await (await deployer.sendTransaction(deployTx)).wait();
    const vanilla = await ethers.getContractAt("VanillaGovernor", receipt.contractAddress);

    const proposeReceipt = await (await vanilla.connect(voter)
      .propose([ethers.ZeroAddress], [0n], ["0x"], "Vanilla baseline")).wait();
    const ev = proposeReceipt.logs
      .map((l) => { try { return vanilla.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "ProposalCreated");
    await mine(2);
    const voteReceipt = await (await vanilla.connect(voter).castVote(ev.args.proposalId, 1)).wait();

    console.log("\n=== VANILLA GOVERNOR BASELINE (Ch5 §5.3) ===");
    console.log("Deploy: VanillaGovernor:", Number(receipt.gasUsed).toLocaleString(), "gas");
    console.log("VanillaGovernor.propose():", Number(proposeReceipt.gasUsed).toLocaleString(), "gas");
    console.log("VanillaGovernor.castVote() — the per-voter on-chain vote this protocol replaces:",
      Number(voteReceipt.gasUsed).toLocaleString(), "gas");
    console.log("============================================\n");
  });
});
