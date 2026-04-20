const { ethers } = require('ethers');
const p = new ethers.providers.StaticJsonRpcProvider(
  { url: 'https://ethereum.publicnode.com', timeout: 30000 }, { chainId: 1, name: 'mainnet' }
);
const addrs = ['0x8C28Cf33d9Fd3D0293f963b1cd27e3FF422B425c', '0xcC22F7F6A8296ED44f0F0E758374675120909177'];
(async () => {
  for (const a of addrs) {
    const code = await p.getCode(a);
    console.log(`${a}: code=${code} size=${(code.length-2)/2}`);
  }
})();
