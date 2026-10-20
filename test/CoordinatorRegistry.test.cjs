const { expect } = require("chai");
const { ethers } = require("hardhat");

/** Ch3 §3.4.2 step 1: where the coordinator's meta-address lives. */
describe("CoordinatorRegistry", function () {
  const S = "0x02" + "11".repeat(32);
  const V = "0x03" + "22".repeat(32);

  async function deploy() {
    const [coordinator, other] = await ethers.getSigners();
    const R = await ethers.getContractFactory("CoordinatorRegistry");
    const registry = await R.deploy();
    await registry.waitForDeployment();
    return { registry, coordinator, other };
  }

  it("publishes and returns a meta-address", async function () {
    const { registry, coordinator } = await deploy();
    await expect(registry.connect(coordinator).publish(S, V))
      .to.emit(registry, "MetaAddressPublished")
      .withArgs(await coordinator.getAddress(), S, V);
    const [s, v] = await registry.metaAddressOf(await coordinator.getAddress());
    expect(s).to.equal(S);
    expect(v).to.equal(V);
  });

  it("is keyed by the publisher, so one coordinator cannot overwrite another", async function () {
    const { registry, coordinator, other } = await deploy();
    await (await registry.connect(coordinator).publish(S, V)).wait();
    const S2 = "0x02" + "aa".repeat(32), V2 = "0x03" + "bb".repeat(32);
    await (await registry.connect(other).publish(S2, V2)).wait();
    const [s] = await registry.metaAddressOf(await coordinator.getAddress());
    expect(s).to.equal(S);
  });

  it("lets a coordinator rotate its own keys", async function () {
    const { registry, coordinator } = await deploy();
    await (await registry.connect(coordinator).publish(S, V)).wait();
    const V2 = "0x02" + "cc".repeat(32);
    await (await registry.connect(coordinator).publish(S, V2)).wait();
    const [, v] = await registry.metaAddressOf(await coordinator.getAddress());
    expect(v).to.equal(V2);
  });

  it("rejects a point of the wrong length", async function () {
    const { registry, coordinator } = await deploy();
    await expect(registry.connect(coordinator).publish("0x0211", V))
      .to.be.revertedWithCustomError(registry, "InvalidPointLength");
  });

  it("rejects a point with an uncompressed or invalid prefix", async function () {
    const { registry, coordinator } = await deploy();
    await expect(registry.connect(coordinator).publish("0x04" + "11".repeat(32), V))
      .to.be.revertedWithCustomError(registry, "InvalidPointPrefix");
  });

  it("returns empty for a coordinator that has never published", async function () {
    const { registry, other } = await deploy();
    const [s, v] = await registry.metaAddressOf(await other.getAddress());
    expect(s).to.equal("0x");
    expect(v).to.equal("0x");
  });
});
