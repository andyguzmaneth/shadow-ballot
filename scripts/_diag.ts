import { JsonRpcProvider, Wallet, parseEther } from 'ethers';
const TO = '0xcfa2883265A01BE566de62C6953Bd68d45260aBB';
async function main() {
  const p = new JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com', 11155111);
  const w = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, p);
  const fee = await p.getFeeData();
  const blk = await p.getBlock('latest');
  console.log('maxFee:', fee.maxFeePerGas?.toString(), 'prio:', fee.maxPriorityFeePerGas?.toString(),
              'baseFee:', blk!.baseFeePerGas?.toString());
  const tx = await w.sendTransaction({ to: TO, value: parseEther('0.0001') });
  const r = await tx.wait();
  console.log('ORDINARY transfer -> status', r!.status, 'gas', r!.gasUsed.toString(), tx.hash);
}
main().catch((e) => console.error('FAILED:', e.shortMessage ?? e.message));
