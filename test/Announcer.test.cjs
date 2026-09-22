const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * First Solidity-level test in this repo (ShadowBallot.sol had zero contract tests
 * before this — flagged separately as a testing gap, see progress notes 2026-08-18).
 * Runs on Hardhat's in-memory network, no funds or Sepolia deployment needed.
 */
describe("ERC5564Announcer", function () {
  async function deploy() {
    const [caller, other] = await ethers.getSigners();
    const Announcer = await ethers.getContractFactory("ERC5564Announcer");
    const announcer = await Announcer.deploy();
    await announcer.waitForDeployment();
    return { announcer, caller, other };
  }

  it("emits an Announcement event with the exact ERC-5564 field layout", async function () {
    const { announcer, caller } = await deploy();

    const schemeId = 1; // secp256k1, per ERC-5564
    const stealthAddress = "0x000000000000000000000000000000000000dEaD";
    const ephemeralPubKey = "0x02" + "ab".repeat(32); // 33-byte compressed pubkey, fake for this test
    const metadata = "0x00" + "cd".repeat(2); // first byte = view tag, per spec

    const tx = await announcer.announce(schemeId, stealthAddress, ephemeralPubKey, metadata);
    const receipt = await tx.wait();

    const event = receipt.logs
      .map((log) => {
        try {
          return announcer.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "Announcement");

    expect(event).to.not.be.null;
    expect(event.args.schemeId).to.equal(BigInt(schemeId));
    expect(event.args.stealthAddress).to.equal(stealthAddress);
    expect(event.args.caller).to.equal(caller.address);
    expect(event.args.ephemeralPubKey).to.equal(ephemeralPubKey);
    expect(event.args.metadata).to.equal(metadata);
  });

  it("is permissionless — any address can announce, matching the real ERC-5564 Announcer (no access control)", async function () {
    const { announcer, other } = await deploy();

    // `other` is not the coordinator/deployer of anything — announce() has no modifier restricting callers.
    await expect(
      announcer.connect(other).announce(1, "0x000000000000000000000000000000000000bEEF", "0x02" + "11".repeat(32), "0x00")
    ).to.not.be.reverted;
  });

  it("coordinator can filter announcements by caller and schemeId via event logs (no on-chain state needed)", async function () {
    const { announcer, caller, other } = await deploy();

    // Use ethers.getAddress()-computed addresses, not hand-typed literals — a hand-typed
    // literal one character short of 40 hex chars silently becomes "not a valid address,"
    // which ethers then tries to resolve as an ENS name, which Hardhat's provider doesn't
    // implement. Caught by exactly this failure while writing this test (2026-08-18).
    const stealthAddrA = ethers.getAddress("0x" + "0".repeat(39) + "1");
    const stealthAddrB = ethers.getAddress("0x" + "0".repeat(39) + "2");
    const stealthAddrC = ethers.getAddress("0x" + "0".repeat(39) + "3");

    await (await announcer.connect(caller).announce(1, stealthAddrA, "0x02" + "aa".repeat(32), "0x00")).wait();
    await (await announcer.connect(other).announce(1, stealthAddrB, "0x02" + "bb".repeat(32), "0x00")).wait();
    await (await announcer.connect(caller).announce(2, stealthAddrC, "0x02" + "cc".repeat(32), "0x00")).wait();

    const callerAddress = await caller.getAddress();
    const filter = announcer.filters.Announcement(1, null, callerAddress);
    const events = await announcer.queryFilter(filter);

    // Only the first announce() matches BOTH schemeId=1 AND caller=`caller` — this is exactly the
    // filtering a real coordinator does off-chain to find its own scheme's announcements cheaply,
    // without downloading and decrypting every announcement on the log (dissertation Ch3, §3.4.4).
    expect(events.length).to.equal(1);
    expect(events[0].args.stealthAddress).to.equal(stealthAddrA);
  });
});
