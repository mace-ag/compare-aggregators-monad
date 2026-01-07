import type { TokenPair } from "../types";

// Monad mainnet token addresses provided by Mace (Jan 2026).
export const MAINNET_USDC_ADDRESS = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
export const MAINNET_WMON_ADDRESS = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
export const MAINNET_AUSD_ADDRESS = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
export const MAINNET_WETH_ADDRESS = "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242";
export const MAINNET_WBTC_ADDRESS = "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c";
export const MAINNET_USDTO_ADDRESS = "0xe7cd86e13AC4309349F30B3435a9d337750fC82D";
export const MAINNET_USD1_ADDRESS = "0x111111d2bf19e43C34263401e0CAd979eD1cdb61";

export const MAINNET_APRMON_ADDRESS = "0x0c65A0BC65a5D819235B71F554D210D3F80E0852";

export const MAINNET_XAUTO_ADDRESS = "0x01bFF41798a0BcF287b996046Ca68b395DbC1071";
export const MAINNET_EARNAUSD_ADDRESS = "0x103222f020e98Bba0AD9809A011FDF8e6F067496";
export const MAINNET_APR_ADDRESS = "0x0a332311633C0625f63CFc51EE33fC49826E0a3C";
export const MAINNET_LV_ADDRESS = "0x1001fF13bf368Aa4fa85F21043648079F00E1001";
export const MAINNET_SHMON_ADDRESS = "0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c";
export const MAINNET_WSTETH_ADDRESS = "0x10Aeaf63194db8d453d4D85a06E5eFE1dd0b5417";
export const MAINNET_MONCOCK_ADDRESS = "0x405b6330e213DED490240CbcDD64790806827777";
export const MAINNET_CHOG_ADDRESS = "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777";
export const MAINNET_SMON_ADDRESS = "0xA3227C5969757783154C60bF0bC1944180ed81B9";
export const MAINNET_DUST_ADDRESS = "0xAD96C3dffCD6374294e2573A7fBBA96097CC8d7c";
export const MAINNET_GMON_ADDRESS = "0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081";
export const MAINNET_EMO_ADDRESS = "0x81A224F8A62f52BdE942dBF23A56df77A10b7777";
export const MAINNET_SHRAMP_ADDRESS = "0x42a4aA89864A794dE135B23C6a8D2E05513d7777";

// Native is represented by the zero address in this repo.
const NATIVE = "0x0000000000000000000000000000000000000000";

const MAJOR_TOKENS = [
  MAINNET_USDC_ADDRESS,
  MAINNET_USDTO_ADDRESS,
  MAINNET_AUSD_ADDRESS,
  MAINNET_WETH_ADDRESS,
  MAINNET_WBTC_ADDRESS,
] as const;

const TIER2_TOKENS = [
  MAINNET_GMON_ADDRESS,
  MAINNET_SMON_ADDRESS,
  MAINNET_APRMON_ADDRESS,
  MAINNET_SHMON_ADDRESS,
  MAINNET_CHOG_ADDRESS,
] as const;

const OTHER_TOKENS = [
  MAINNET_WMON_ADDRESS,
  MAINNET_USD1_ADDRESS,
  MAINNET_XAUTO_ADDRESS,
  MAINNET_EARNAUSD_ADDRESS,
  MAINNET_APR_ADDRESS,
  MAINNET_LV_ADDRESS,
  MAINNET_WSTETH_ADDRESS,
  MAINNET_MONCOCK_ADDRESS,
  MAINNET_DUST_ADDRESS,
  MAINNET_EMO_ADDRESS,
  MAINNET_SHRAMP_ADDRESS,
] as const;

function pairsWithNative(tokens: readonly string[]): TokenPair[] {
  return tokens.flatMap((t) => [
    { tokenIn: NATIVE, tokenOut: t },
    { tokenIn: t, tokenOut: NATIVE },
  ]);
}

function allPairs(tokens: readonly string[]): TokenPair[] {
  const out: TokenPair[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      out.push({ tokenIn: tokens[i], tokenOut: tokens[j] });
      out.push({ tokenIn: tokens[j], tokenOut: tokens[i] });
    }
  }
  return out;
}

export const MAINNET_HARDCODED_PAIRS: TokenPair[] = [
  // Native <-> major + tier2 + selected others
  ...pairsWithNative(MAJOR_TOKENS),
  ...pairsWithNative(TIER2_TOKENS),
  ...pairsWithNative(OTHER_TOKENS),

  // Major token cross pairs
  ...allPairs(MAJOR_TOKENS),

  // Tier2 <-> majors
  ...TIER2_TOKENS.flatMap((t2) => allPairs([t2, ...MAJOR_TOKENS])),
];


