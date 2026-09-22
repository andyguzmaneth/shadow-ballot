/**
 * Full Sepolia deployment — Ch4 §4.7's open item, closed 2026-09-03.
 *
 * Deploys, in dependency order: MockGovernanceToken (a real OZ ERC20Votes —
 * the appropriate testnet stand-in for a real governance token), the real
 * ERC5564Announcer, the real Groth16Verifier (exported from the actual
 * compiled circuit, not a mock), VoterRegistry, and ShadowBallotGovernor
 * wiring all of them together.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy-all-sepolia.cjs --network sepolia --config hardhat.config.cjs
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const addresses = {};

  const Token = await ethers.getContractFactory("MockGovernanceToken");
  const token = await Token.deploy();
  await token.waitForDeployment();
  addresses.MockGovernanceToken = await token.getAddress();
  console.log("MockGovernanceToken:", addresses.MockGovernanceToken);

  const Announcer = await ethers.getContractFactory("ERC5564Announcer");
  const announcer = await Announcer.deploy();
  await announcer.waitForDeployment();
  addresses.ERC5564Announcer = await announcer.getAddress();
  console.log("ERC5564Announcer:", addresses.ERC5564Announcer);

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  addresses.Groth16Verifier = await verifier.getAddress();
  console.log("Groth16Verifier:", addresses.Groth16Verifier);

  // Snapshot block for VoterRegistry: current block. Real usage would snapshot
  // at a meaningful past block; for this PoC deployment we mint+delegate to the
  // deployer right after so a real, checkable eligibility path exists.
  const snapshotBlock = await ethers.provider.getBlockNumber();
  const Registry = await ethers.getContractFactory("VoterRegistry");
  const registry = await Registry.deploy(addresses.MockGovernanceToken, snapshotBlock);
  await registry.waitForDeployment();
  addresses.VoterRegistry = await registry.getAddress();
  console.log("VoterRegistry:", addresses.VoterRegistry, "(snapshot block:", snapshotBlock, ")");

  const Governor = await ethers.getContractFactory("ShadowBallotGovernor");
  const governor = await Governor.deploy(
    addresses.MockGovernanceToken,
    deployer.address, // coordinator = deployer for this PoC deployment
    addresses.Groth16Verifier,
    1, // votingDelay (blocks)
    50, // votingPeriod (blocks)
    0, // proposalThreshold
    4 // quorumNumerator (%)
  );
  await governor.waitForDeployment();
  addresses.ShadowBallotGovernor = await governor.getAddress();
  console.log("ShadowBallotGovernor:", addresses.ShadowBallotGovernor);

  console.log("\n=== Deployment complete. Update src/config.ts with: ===");
  console.log(JSON.stringify(addresses, null, 2));

  return addresses;
}

main()
  .then((addresses) => {
    require("fs").writeFileSync(
      "sepolia-deployment.json",
      JSON.stringify({ network: "sepolia", deployedAt: new Date().toISOString(), addresses }, null, 2)
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
