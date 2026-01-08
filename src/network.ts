import type { AggregatorConfig, TokenPair } from "./types";
import { MAINNET_HARDCODED_PAIRS, MAINNET_USDC_ADDRESS } from "./pairs/mainnetPairs";
import { TESTNET_HARDCODED_PAIRS, TESTNET_USDC_ADDRESS } from "./pairs/testnetPairs";

export type MonadNetwork = "mainnet" | "testnet";
export type Env = Record<string, string | undefined>;

export type AggregatorName = "monorail" | "openocean" | "eisenFinance" | "kuru" | "mace" | "dirol" | "0x";

export interface NetworkConfig {
  network: MonadNetwork;
  chainId: number;
  chainName: string;
  nativeSymbol: string;
  rpcUrl: string;
  usdcAddress?: string;
  pairs: TokenPair[];
  aggregatorBaseUrls: Record<AggregatorName, string>;
  aggregators: AggregatorConfig[];
  explorers: {
    monadvision?: string;
    monadscan?: string;
    socialscan?: string;
  };
}

function getArgValue(args: string[], keys: string[]): string | undefined {
  for (const key of keys) {
    const idx = args.findIndex((a) => a === key);
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  }
  return undefined;
}

export function parseMonadNetwork(args: string[], env: Env): MonadNetwork {
  const argNetwork = (getArgValue(args, ["--network", "-n"]) || "").toLowerCase();
  const envNetwork = (env.MONAD_NETWORK || env.NETWORK || "").toLowerCase();
  const raw = (argNetwork || envNetwork || "mainnet").trim();
  if (raw === "testnet") return "testnet";
  return "mainnet";
}

function getRpcUrl(network: MonadNetwork, env: Env): string {
  const shared = env.MONAD_RPC_URL || "";
  if (network === "mainnet") {
    return (env.MONAD_MAINNET_RPC_URL || shared || "").trim();
  }
  return (env.MONAD_TESTNET_RPC_URL || shared || "").trim();
}

function getAggregatorBaseUrls(network: MonadNetwork, chainId: number, env: Env): Record<AggregatorName, string> {
  const monorailDefault =
    network === "mainnet" ? "https://pathfinder.monorail.xyz/v4/quote" : "https://testnet-pathfinder.monorail.xyz/v4/quote";
  const monorail = (env.AGG_MONORAIL_BASE_URL || monorailDefault).trim();

  const openocean = (env.AGG_OPENOCEAN_BASE_URL || `https://open-api.openocean.finance/v4/${chainId}/swap`).trim();
  const eisenFinance = (env.AGG_EISEN_BASE_URL || `https://api.hetz-01.eisenfinance.com/v1/chains/${chainId}/v2/quote`).trim();
  // Kuru Flow API (Bearer JWT). Docs: https://docs.kuru.io/api-reference/calculate-best-path-quote
  const kuru = (env.AGG_KURU_BASE_URL || "https://ws.kuru.io/api/quote").trim();

  // Mace historically used a testnet hostname. Mainnet hostname can differ; allow override.
  const maceDefault = network === "mainnet" ? "https://api.mace.ag/swaps/get-best-routes" : "https://testnet.api.mace.ag/swaps/get-best-routes";
  const mace = (env.AGG_MACE_BASE_URL || maceDefault).trim();

  const dirol = (env.AGG_DIROL_BASE_URL || "https://api.dirol.io/quote/order").trim();
  const zerox = (env.AGG_0X_BASE_URL || "https://api.0x.org/swap/allowance-holder/quote").trim();

  return {
    monorail,
    openocean,
    eisenFinance,
    kuru,
    mace,
    dirol,
    "0x": zerox,
  };
}

function getPairs(network: MonadNetwork, env: Env, usdcAddress?: string): TokenPair[] {
  const pairsJson = (env.MONAD_PAIRS_JSON || env.MONAD_MAINNET_PAIRS_JSON || "").trim();
  if (pairsJson) {
    try {
      const parsed = JSON.parse(pairsJson) as TokenPair[];
      if (Array.isArray(parsed) && parsed.every((p) => typeof p?.tokenIn === "string" && typeof p?.tokenOut === "string")) {
        return parsed;
      }
    } catch {
      // fall through
    }
  }

  if (network === "testnet") return TESTNET_HARDCODED_PAIRS;

  // Mainnet: default to the curated mainnet list (can be overridden by MONAD_PAIRS_JSON).
  return MAINNET_HARDCODED_PAIRS;
}

export function getNetworkConfig(args: string[], env: Env): NetworkConfig {
  const network = parseMonadNetwork(args, env);
  const chainId = network === "mainnet" ? 143 : 10143;

  const rpcUrl = getRpcUrl(network, env);
  const usdcAddress =
    network === "mainnet"
      ? (env.MONAD_USDC_ADDRESS || env.MONAD_MAINNET_USDC_ADDRESS || "").trim() || MAINNET_USDC_ADDRESS
      : TESTNET_USDC_ADDRESS;

  const aggregatorBaseUrls = getAggregatorBaseUrls(network, chainId, env);

  // Default enabled aggregators vary by network & availability.
  // - Mainnet: Monorail/Dirol may not be available, so keep them opt-in via env.
  // - 0x requires an API key, so include only if configured.
  const baseAggs: AggregatorConfig[] = [
    { name: "openocean", baseUrl: aggregatorBaseUrls.openocean },
    { name: "eisenFinance", baseUrl: aggregatorBaseUrls.eisenFinance },
    { name: "mace", baseUrl: aggregatorBaseUrls.mace },
  ];

  const maybeKuru = (env.KURU_JWT || "").trim() || (env.ENABLE_KURU || "").toLowerCase() === "true" || (env.ENABLE_KURU || "") === "1"
    ? [{ name: "kuru", baseUrl: aggregatorBaseUrls.kuru }]
    : [];

  const maybeMonorail =
    network === "testnet" || (env.ENABLE_MONORAIL || "").toLowerCase() === "true" || (env.ENABLE_MONORAIL || "") === "1"
      ? [{ name: "monorail", baseUrl: aggregatorBaseUrls.monorail }]
      : [];

  const maybeDirol = (env.AGG_DIROL_BASE_URL || "").trim()
    ? [{ name: "dirol", baseUrl: aggregatorBaseUrls.dirol }]
    : network === "testnet"
      ? [{ name: "dirol", baseUrl: aggregatorBaseUrls.dirol }]
      : [];

  const maybeZeroX = (env.ZEROX_API_KEY || "").trim() ? [{ name: "0x", baseUrl: aggregatorBaseUrls["0x"] }] : [];

  const aggregators: AggregatorConfig[] = [...baseAggs, ...maybeKuru, ...maybeMonorail, ...maybeDirol, ...maybeZeroX];

  const pairs = getPairs(network, env, usdcAddress);

  return {
    network,
    chainId,
    chainName: network === "mainnet" ? "Monad Mainnet" : "Monad Testnet",
    nativeSymbol: "MON",
    rpcUrl,
    usdcAddress,
    pairs,
    aggregatorBaseUrls,
    aggregators,
    explorers: {
      monadvision: "https://monadvision.com",
      monadscan: "https://monadscan.com",
      socialscan: "https://monad.socialscan.io",
    },
  };
}


