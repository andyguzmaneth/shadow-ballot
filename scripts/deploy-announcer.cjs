/**
 * Deploy ERC5564Announcer to Sepolia.
 *
 * NOT run yet as of 2026-08-18 — needs a funded Sepolia deployer key, which this
 * session doesn't have. Left ready for whenever that's available.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy-announcer.cjs --network sepolia --config hardhat.config.cjs
 *
 * Note: a production deployment should prefer the real canonical ERC-5564 Announcer
 * singleton (0x55649E01B5Df198D18D95b5cc5051630cfD45564 on mainnet and several L2s —
 * verify it's actually deployed on Sepolia before assuming so) over this project-local
 * instance, so votes share the real cross-application anonymity set rather than a
 * vote-specific one (dissertation Ch3, §3.4.3 step 2a).
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying ERC5564Announcer with deployer:", deployer.address);

  const Announcer = await ethers.getContractFactory("ERC5564Announcer");
  const contract = await Announcer.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("ERC5564Announcer deployed to:", address);
  console.log("\nUpdate src/config.ts with:");
  console.log(`  ANNOUNCER_ADDRESS: '${address}'`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
