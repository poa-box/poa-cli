const { ethers } = require('ethers');
const p = new ethers.providers.StaticJsonRpcProvider(
  { url: 'https://ethereum.publicnode.com', timeout: 30000 }, { chainId: 1, name: 'mainnet' }
);
(async () => {
  const target = ethers.utils.getAddress('0x63c0c19a282a1b52b07dd5a65b58948a07dae32b');
  const code = await p.getCode(target);
  console.log(`${target}: codeSize=${(code.length-2)/2}`);
  // Try common implementation queries
  const abi = [
    'function VERSION() view returns (string)',
    'function version() view returns (string)',
    'function getDomainSeparator() view returns (bytes32)',
    'function owner() view returns (address)',
    'function entryPoint() view returns (address)',
  ];
  const c = new ethers.Contract(target, abi, p);
  for (const fn of ['VERSION','version','owner','entryPoint']) {
    try {
      const r = await c[fn]();
      console.log(`  ${fn}() = ${r}`);
    } catch (e) {
      // skip
    }
  }
})();
