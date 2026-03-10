/**
 * Deploy ShadowBallot contract to Sepolia.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.cjs --network sepolia --config hardhat.config.cjs
 *
 * After deployment, update src/config.ts with the new contract address.
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying ShadowBallot with coordinator:", deployer.address);

  const ShadowBallot = await ethers.getContractFactory("ShadowBallot");
  const contract = await ShadowBallot.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("ShadowBallot deployed to:", address);
  console.log("\nUpdate src/config.ts with:");
  console.log(`  CONTRACT_ADDRESS: '${address}'`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
