const { ethers } = require('ethers');
const mainnet = new ethers.providers.StaticJsonRpcProvider(
  { url: 'https://ethereum.publicnode.com', timeout: 30000 }, { chainId: 1, name: 'mainnet' }
);
const arb = new ethers.providers.StaticJsonRpcProvider(
  { url: 'https://arb1.arbitrum.io/rpc', timeout: 30000 }, { chainId: 42161, name: 'arbitrum' }
);
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'];

const cases = [
  { dao: 'Uniswap', safe: '0x683a4F9915D6216f73d6Df50151725036bD26C02', token: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', chain: 'mainnet' },
  { dao: 'Balancer-A', safe: '0xAD9992f3631028CEF19e6D6C31e822C5bc2442CC', token: '0xba100000625a3754423978a60c9317c58a424e3D', chain: 'mainnet' },
  { dao: 'Balancer-B', safe: '0x8787FC2De4De95c53e5E3a4e5459247D9773ea52', token: '0xba100000625a3754423978a60c9317c58a424e3D', chain: 'mainnet' },
  { dao: 'ArbitrumFdn', safe: '0x11cd09a0c5B1dc674615783b0772a9bFD53e3A8F', token: '0x912CE59144191C1204E64559FE8253a0e49E6548', chain: 'arbitrum' },
];

(async () => {
  for (const c of cases) {
    const provider = c.chain === 'arbitrum' ? arb : mainnet;
    const token = new ethers.Contract(c.token, ERC20, provider);
    try {
      const [bal, dec, sym] = await Promise.all([
        token.balanceOf(c.safe),
        token.decimals(),
        token.symbol(),
      ]);
      const human = parseFloat(ethers.utils.formatUnits(bal, dec));
      console.log(`${c.dao}: ${human.toLocaleString()} ${sym} (chain=${c.chain})`);
    } catch (e) {
      console.log(`${c.dao}: ERROR ${e.message}`);
    }
  }
})();
