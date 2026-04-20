const { ethers } = require('ethers');
const mainnet = new ethers.providers.StaticJsonRpcProvider(
  { url: 'https://ethereum.publicnode.com', timeout: 30000 }, { chainId: 1, name: 'mainnet' }
);
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'];

const cases = [
  { dao: 'Sushi', safe: '0x19B3Eb3Af5D93b77a5619b047De0EED7115A19e7', token: '0x6B3595068778DD592e39A122f4f5a5cF09C90fE2', desc: 'SUSHI' },
  { dao: '1inch', safe: '0x5762F3075d60D93bac8f08b33c2F92F87bd2ab2c', token: '0x111111111117dc0aa78b770fa6a738034120c302', desc: '1INCH' },
  { dao: 'ApeCoin', safe: '0x72dce6fa7fb0bfa8d9fc7ea48fa60a71abc63551', token: '0x4d224452801ACEd8B2F0aebE155379bb5D594381', desc: 'APE' },
];

(async () => {
  for (const c of cases) {
    try {
      const safeAddr = ethers.utils.getAddress(c.safe.toLowerCase());
      const tokenAddr = ethers.utils.getAddress(c.token.toLowerCase());
      const token = new ethers.Contract(tokenAddr, ERC20, mainnet);
      const [bal, dec] = await Promise.all([
        token.balanceOf(safeAddr),
        token.decimals(),
      ]);
      const human = parseFloat(ethers.utils.formatUnits(bal, dec));
      const variant = bal.isZero() ? 'B-delegation-receipt' : 'A-token-holding';
      console.log(`${c.dao}: ${human.toLocaleString()} ${c.desc} → Variant ${variant}`);
    } catch (e) {
      console.log(`${c.dao}: ERROR ${e.message.substring(0,80)}`);
    }
  }
})();
