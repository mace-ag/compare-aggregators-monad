import { writeFile, mkdir, appendFile } from "fs/promises";
import { stringify } from "csv-stringify/sync";
import prompts from "prompts";
import {
  createPublicClient,
  http,
  type Address,
  type Hash,
  toHex,
  keccak256,
  pad,
  concat,
  erc20Abi,
  formatUnits,
} from "viem";
import { defineChain } from "viem";
import { createAggregator, type BaseAggregator, type FetchOptions } from "./aggregators/index";
import {
  COMMON_SLOTS_FOR_BALANCE_SET,
  NATIVE_TOKEN_ADDRESS,
  TEST_AMOUNTS,
} from "./consts";
import type { TokenPair, AggregatorConfig, QuoteRequest, TestResult, SimulationResult, SwapTransaction } from "./types";
import { sleep, generateOutputFilename, isNativeToken, calculateAmountIn } from "./utils";
import { createRobustTestClient, resetForkWithRetry, executeTransactionWithRetry, waitForAnvil } from "./utils/client";
import { retryWithBackoff } from "./utils/retry";
import { setupGracefulShutdown } from "./utils/error-recovery";
import { getNetworkConfig } from "./network";

// Parse command-line arguments
const args = process.argv.slice(2);
const SIMULATION = args.findIndex((arg) => arg === "--simulation" || arg === "-s") >= 0;
const NETWORK_CONFIG = getNetworkConfig(args, process.env);

// Parse aggregator selection argument
// Usage: --aggregators mace,openocean or -a mace,openocean
const aggregatorArgIndex = args.findIndex((arg) => arg === "--aggregators" || arg === "-a");
const selectedAggregatorNames =
  aggregatorArgIndex >= 0 && args[aggregatorArgIndex + 1]
    ? args[aggregatorArgIndex + 1].split(",").map((name) => name.trim().toLowerCase())
    : null;

// Parse random sampling argument
// Usage: --random 10 or -r 10 (to get 10 random samples)
const randomArgIndex = args.findIndex((arg) => arg === "--random" || arg === "-r");
const randomSampleCount = randomArgIndex >= 0 && args[randomArgIndex + 1] ? parseInt(args[randomArgIndex + 1], 10) : 0;

// Parse help argument
const SHOW_HELP = args.findIndex((arg) => arg === "--help" || arg === "-h") >= 0;

// Show help message if requested
if (SHOW_HELP) {
  console.log(`
DEX Aggregator Comparison Tool

Usage: bun run compare [options]

Options:
  --simulation, -s         Enable transaction simulation (requires Anvil fork)
  --network, -n <net>      Select network: mainnet | testnet (default: mainnet)
  --aggregators, -a <list> Comma-separated list of aggregators to test
                          Example: --aggregators mace,openocean
  --random, -r <count>    Test with random sampling of pairs and amounts
                          Example: --random 10 (tests 10 random combinations)
  --help, -h              Show this help message

Examples:
  # Test all aggregators with all pairs and amounts
  bun run compare

  # Test specific aggregators
  bun run compare --aggregators mace,openocean

  # Test with 10 random samples
  bun run compare --random 10

  # Test with random samples and simulation
  bun run compare --random 20 --simulation
`);
  process.exit(0);
}

// Configuration
const CHAIN_ID = NETWORK_CONFIG.chainId;
const SLIPPAGE = 0.005;
const OUTPUT_DIR = "./comparison_results";
const MONAD_RPC_URL = NETWORK_CONFIG.rpcUrl;
const HARDCODED_PAIRS = NETWORK_CONFIG.pairs;
const USDC_ADDRESS = NETWORK_CONFIG.usdcAddress;

if (!MONAD_RPC_URL) {
  console.error(`Error: RPC URL not configured for ${NETWORK_CONFIG.chainName}.`);
  console.error(`Set one of: MONAD_RPC_URL, MONAD_${NETWORK_CONFIG.network.toUpperCase()}_RPC_URL`);
  process.exit(1);
}
if (HARDCODED_PAIRS.length === 0) {
  console.error(`Error: No token pairs configured for ${NETWORK_CONFIG.chainName}.`);
  console.error(`Set MONAD_PAIRS_JSON (JSON array of {tokenIn, tokenOut}) or set MONAD_USDC_ADDRESS to use a default MON<->USDC pair.`);
  process.exit(1);
}

// RPC Configuration for forking
// NOTE: This should point to your LOCAL Anvil instance, not the remote RPC
// Run ./script/start-fork.sh first to start the Anvil fork
const ANVIL_RPC_URL = process.env.ANVIL_RPC_URL || "http://127.0.0.1:8545";
const TEST_ACCOUNT: Address =
  (process.env.DEFAULT_SENDER_ACCOUNT as Address) || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Define custom chain
const customChain = defineChain({
  id: CHAIN_ID,
  name: NETWORK_CONFIG.chainName,
  nativeCurrency: { name: "Monad", symbol: NETWORK_CONFIG.nativeSymbol, decimals: 18 },
  rpcUrls: {
    default: { http: [MONAD_RPC_URL] },
  },
});

const ALL_AGGREGATORS: AggregatorConfig[] = NETWORK_CONFIG.aggregators;

// Helper function to select aggregators interactively
async function selectAggregatorsInteractively(): Promise<AggregatorConfig[]> {
  console.log("\n" + "=".repeat(60));
  console.log("AGGREGATOR SELECTION");
  console.log("=".repeat(60));

  // Filter aggregators based on simulation support if simulation is enabled
  let availableAggregators = ALL_AGGREGATORS;
  if (SIMULATION) {
    // Create temporary instances to check simulation support
    const tempInstances = ALL_AGGREGATORS.map((config) => createAggregator(config.name, config.baseUrl));
    availableAggregators = ALL_AGGREGATORS.filter((config, index) => {
      const supportsSimulation = tempInstances[index].isSimulationSupported();
      if (!supportsSimulation) {
        console.log(`⚠️  Excluding ${config.name} - does not support simulation`);
      }
      return supportsSimulation;
    });
    console.log(`\nSimulation mode: Only showing aggregators that support simulation\n`);
  }

  console.log("\nUse SPACE to select/deselect, ENTER to confirm\n");

  const response = await prompts({
    type: "multiselect",
    name: "aggregators",
    message: "Select aggregators to test:",
    choices: [
      ...availableAggregators.map((agg) => ({
        title: agg.name,
        value: agg,
        selected: false,
      })),
      {
        title: "All aggregators",
        value: "all",
        selected: false,
      },
    ],
    hint: "- Space to select. Return to submit",
  });

  // Handle user cancellation (Ctrl+C)
  if (response.aggregators === undefined) {
    console.log("\nSelection cancelled. Exiting...");
    process.exit(0);
  }

  // Check if "All" was selected
  if (response.aggregators.includes("all") || response.aggregators.length === 0) {
    console.log("→ Selected: All available aggregators\n");
    return availableAggregators;
  }

  const selected = response.aggregators as AggregatorConfig[];
  console.log(`→ Selected: ${selected.map((a) => a.name).join(", ")}\n`);

  return selected;
}

// Filter aggregators based on command-line selection or interactive prompt
let AGGREGATORS: AggregatorConfig[];
if (selectedAggregatorNames && selectedAggregatorNames.length > 0) {
  // Use command-line selection
  AGGREGATORS = ALL_AGGREGATORS.filter((agg) => selectedAggregatorNames.includes(agg.name.toLowerCase()));

  // Validate that all requested aggregators were found
  const foundNames = AGGREGATORS.map((agg) => agg.name.toLowerCase());
  const notFoundNames = selectedAggregatorNames.filter((name) => !foundNames.includes(name));

  if (notFoundNames.length > 0) {
    console.error(`Error: The following aggregators were not found: ${notFoundNames.join(", ")}`);
    console.error(`Available aggregators: ${ALL_AGGREGATORS.map((agg) => agg.name).join(", ")}`);
    process.exit(1);
  }

  // Filter out aggregators that don't support simulation when simulation is enabled
  if (SIMULATION && AGGREGATORS.length > 0) {
    const beforeFilterCount = AGGREGATORS.length;
    const tempInstances = AGGREGATORS.map((config) => createAggregator(config.name, config.baseUrl));
    AGGREGATORS = AGGREGATORS.filter((config, index) => {
      const supportsSimulation = tempInstances[index].isSimulationSupported();
      if (!supportsSimulation) {
        console.log(`⚠️  Excluding ${config.name} - does not support simulation`);
      }
      return supportsSimulation;
    });

    if (AGGREGATORS.length === 0) {
      console.error("\nError: None of the selected aggregators support simulation.");
      console.error("Please select aggregators that provide transaction data or disable simulation mode.");
      process.exit(1);
    } else if (AGGREGATORS.length < beforeFilterCount) {
      console.log(
        `\nSimulation mode: ${AGGREGATORS.length} of ${beforeFilterCount} selected aggregators support simulation\n`,
      );
    }
  }

  if (AGGREGATORS.length === 0) {
    console.error("Error: No valid aggregators selected.");
    console.error(`Available aggregators: ${ALL_AGGREGATORS.map((agg) => agg.name).join(", ")}`);
    process.exit(1);
  }
} else {
  // Use interactive selection - will be called in runComparison()
  AGGREGATORS = ALL_AGGREGATORS; // Placeholder, will be set in runComparison
}

// Test client singleton (connects to local Anvil fork for simulations)
let testClient: any = null;

// Helper function to get or create test client
async function getTestClient() {
  if (!testClient) {
    // Wait for Anvil to be ready before creating client
    try {
      await waitForAnvil(ANVIL_RPC_URL);
    } catch (error) {
      console.error("Failed to connect to Anvil. Make sure it's running on", ANVIL_RPC_URL);
      throw error;
    }

    testClient = createRobustTestClient(customChain, ANVIL_RPC_URL, {
      timeout: 120_000, // 2 minute timeout for test client
    });
  }
  return testClient;
}

// Token database loaded from onchain
let TOKEN_DATABASE: Record<string, { symbol: string; decimals: number; name: string }> | null = null;

// MON prices for each token (how much MON to get 1 token)
let TOKEN_PRICES_IN_NATIVE_TOKEN: Record<string, number> = {};

// USDC prices for each token (how much USDC to get 1 token)
export let TOKEN_PRICES_IN_USDC: Record<string, number> = {};

// Helper function to extract unique token addresses from HARDCODED_PAIRS
function extractUniqueTokens(): string[] {
  const uniqueTokens = new Set<string>();

  for (const pair of HARDCODED_PAIRS) {
    uniqueTokens.add(pair.tokenIn.toLowerCase());
    uniqueTokens.add(pair.tokenOut.toLowerCase());
  }

  return Array.from(uniqueTokens);
}

// Helper function to generate random samples
function generateRandomSamples(count: number): {
  pairs: TokenPair[];
  amounts: number[];
} {
  if (count <= 0 || HARDCODED_PAIRS.length === 0 || TEST_AMOUNTS.length === 0) {
    return { pairs: [], amounts: [] };
  }

  const randomPairs: TokenPair[] = [];
  const randomAmounts: number[] = [];

  for (let i = 0; i < count; i++) {
    // Get random pair
    const randomPairIndex = Math.floor(Math.random() * HARDCODED_PAIRS.length);
    randomPairs.push({ ...HARDCODED_PAIRS[randomPairIndex] });

    // Get random amount
    const randomAmountIndex = Math.floor(Math.random() * TEST_AMOUNTS.length);
    randomAmounts.push(TEST_AMOUNTS[randomAmountIndex]);
  }

  return { pairs: randomPairs, amounts: randomAmounts };
}

// Helper function to fetch token data onchain
async function fetchTokenDataOnchain(
  tokenAddress: Address,
): Promise<{ symbol: string; decimals: number; name: string }> {
  // Handle native token
  if (isNativeToken(tokenAddress)) {
    return { symbol: "MON", decimals: 18, name: "Monad" };
  }

  try {
    // Wrap the fetch logic with retry mechanism
    return await retryWithBackoff(
      async () => {
        // Create a public client for reading from the blockchain
        const publicClient = createPublicClient({
          chain: customChain,
          transport: http(customChain.rpcUrls.default.http[0]),
        });

        // Fetch symbol, decimals, and name in parallel
        const [symbol, decimals, name] = await Promise.all([
          publicClient.readContract({
            address: tokenAddress as Address,
            abi: erc20Abi,
            functionName: "symbol",
          }) as Promise<string>,
          publicClient.readContract({
            address: tokenAddress as Address,
            abi: erc20Abi,
            functionName: "decimals",
          }) as Promise<number>,
          publicClient.readContract({
            address: tokenAddress as Address,
            abi: erc20Abi,
            functionName: "name",
          }) as Promise<string>,
        ]);

        return { symbol, decimals, name };
      },
      {
        maxAttempts: 5,
        initialDelay: 2000,
        maxDelay: 10000,
        onRetry: (attempt) => {
          console.log(`  ⟳ Retrying (attempt ${attempt + 1}/5) for ${tokenAddress}...`);
        },
      },
    );
  } catch (error: any) {
    console.error(`  Failed to fetch token data for ${tokenAddress}:`, error.message);
    return { symbol: "UNKNOWN", decimals: 18, name: "Unknown Token" };
  }
}

// Helper function to fetch USDC price for a token using the baseline aggregator
async function fetchUSDCPriceForToken(tokenAddress: string): Promise<number | null> {
  if (!USDC_ADDRESS) {
    return null;
  }
  // Skip if it's USDC itself
  if (tokenAddress.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
    return 1; // 1 USDC = 1 USDC
  }

  try {
    // Create baseline aggregator (Mace)
    const priceAggregator = createAggregator("mace", NETWORK_CONFIG.aggregatorBaseUrls.mace);

    // We need to know how much USDC we get for 1 unit of the token
    // So we query USDC -> token with 1 USDC input to get the exchange rate
    const tokenDecimals = TOKEN_DATABASE?.[tokenAddress.toLowerCase()]?.decimals || 18;
    const amountIn = (10 ** 6).toString(); // 1 USDC (USDC has 6 decimals)

    const request: QuoteRequest = {
      chain: CHAIN_ID,
      tokenIn: USDC_ADDRESS,
      tokenOut: tokenAddress,
      amountIn: amountIn,
      tokenInDecimals: 6, // USDC has 6 decimals
      tokenOutDecimals: tokenDecimals,
      includePoolInfo: false,
      slippage: SLIPPAGE,
    };

    const url = priceAggregator.buildQuoteUrl(request);
    const fetchOptions: FetchOptions = {};
    priceAggregator.addRequestData(request, fetchOptions);

    const response = await fetch(url, fetchOptions as RequestInit);
    if (!response.ok) {
      return null;
    }

    const data: any = await response.json();
    const { outputAmount } = priceAggregator.getOutput(data);
    const amountOut = BigInt(outputAmount || "0");

    if (amountOut > 0) {
      // Convert amountOut to number with proper decimals
      const formattedAmountOut = Number(amountOut) / 10 ** tokenDecimals;
      // This gives us how many tokens we get for 1 USDC
      return formattedAmountOut;
    }

    return null;
  } catch (error) {
    return null;
  }
}

// Helper function to fetch MON price for a token using the baseline aggregator
async function fetchMONPriceForToken(tokenAddress: string): Promise<number | null> {
  // Skip if it's MON itself
  if (tokenAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase()) {
    return 1; // 1 MON = 1 MON
  }

  try {
    // Create baseline aggregator (Mace)
    const priceAggregator = createAggregator("mace", NETWORK_CONFIG.aggregatorBaseUrls.mace);

    // We need to know how much MON we get for 1 unit of the token
    // So we query MON -> token with 1 MON input to get the exchange rate
    const tokenDecimals = TOKEN_DATABASE?.[tokenAddress.toLowerCase()]?.decimals || 18;
    const amountIn = (10 ** 18).toString(); // 1 MON

    const request: QuoteRequest = {
      chain: CHAIN_ID,
      tokenIn: NATIVE_TOKEN_ADDRESS,
      tokenOut: tokenAddress,
      amountIn: amountIn,
      tokenInDecimals: 18,
      tokenOutDecimals: tokenDecimals,
      includePoolInfo: false,
      slippage: SLIPPAGE,
    };

    const url = priceAggregator.buildQuoteUrl(request);
    const fetchOptions: FetchOptions = {};
    priceAggregator.addRequestData(request, fetchOptions);

    const response = await fetch(url, fetchOptions as RequestInit);

    if (response.status !== 200) {
      console.log(`  Failed to fetch MON price for ${tokenAddress}: HTTP ${response.status}`);
      return null;
    }

    const data = (await response.json()) as any;
    const { outputAmount } = priceAggregator.getOutput(data);

    if (!outputAmount || outputAmount === "0") {
      console.log(`  No liquidity for MON -> ${tokenAddress}`);
      return null;
    }

    // Calculate MON price: how much of tokenOut we get for 1 MON
    const tokenOutAmount = parseFloat(outputAmount) / 10 ** tokenDecimals;
    const monPriceInToken = tokenOutAmount; // This is how much of the token we get for 1 MON

    return monPriceInToken;
  } catch (error: any) {
    console.error(`  Error fetching MON price for ${tokenAddress}:`, error.message);
    return null;
  }
}

// Helper function to fetch prices for all unique tokens
async function fetchPricesForAllTokens(): Promise<void> {
  console.log("Fetching MON and USDC prices for all tokens...\n");

  // Get unique tokens from pairs
  const uniqueTokens = extractUniqueTokens();

  // Initialize price dictionaries
  TOKEN_PRICES_IN_NATIVE_TOKEN = {};
  TOKEN_PRICES_IN_USDC = {};

  for (const tokenAddress of uniqueTokens) {
    const tokenData = TOKEN_DATABASE?.[tokenAddress.toLowerCase()];
    if (!tokenData) {
      console.log(`  Skipping ${tokenAddress} - no token data`);
      continue;
    }

    console.log(`  Fetching prices for ${tokenData.symbol} (${tokenAddress})...`);

    // Fetch MON price
    const monPrice = await fetchMONPriceForToken(tokenAddress);
    if (monPrice !== null) {
      TOKEN_PRICES_IN_NATIVE_TOKEN[tokenAddress.toLowerCase()] = monPrice;
      console.log(`    ✓ 1 MON = ${monPrice} ${tokenData.symbol}`);
    } else {
      console.log(`    ✗ Failed to fetch MON price`);
    }

    // Fetch USDC price
    if (USDC_ADDRESS) {
      const usdcPrice = await fetchUSDCPriceForToken(tokenAddress);
      if (usdcPrice !== null) {
        TOKEN_PRICES_IN_USDC[tokenAddress.toLowerCase()] = usdcPrice;
        console.log(`    ✓ 1 USDC = ${usdcPrice} ${tokenData.symbol}`);
      } else {
        console.log(`    ✗ Failed to fetch USDC price`);
      }
    } else {
      console.log(`    - Skipping USDC pricing (MONAD_USDC_ADDRESS not set)`);
    }

    // Small delay to avoid rate limiting
    await sleep(100);
  }

  console.log(`\nPrice fetching completed:`);
  console.log(`  - MON prices: ${Object.keys(TOKEN_PRICES_IN_NATIVE_TOKEN).length} tokens`);
  console.log(`  - USDC prices: ${Object.keys(TOKEN_PRICES_IN_USDC).length} tokens\n`);
}

// Helper function to load tokens from onchain data
async function loadTokensFromOnchain(): Promise<void> {
  console.log("Fetching token data from onchain...\n");

  // Extract unique tokens from HARDCODED_PAIRS
  const uniqueTokens = extractUniqueTokens();
  console.log(`Found ${uniqueTokens.length} unique tokens in HARDCODED_PAIRS`);

  // Initialize TOKEN_DATABASE if not already initialized
  if (!TOKEN_DATABASE) {
    TOKEN_DATABASE = {};
  }

  // Fetch data for each token
  let successCount = 0;
  let failCount = 0;

  for (const tokenAddress of uniqueTokens) {
    try {
      console.log(`Fetching data for ${tokenAddress}...`);
      const tokenData = await fetchTokenDataOnchain(tokenAddress as Address);
      TOKEN_DATABASE[tokenAddress] = tokenData;
      console.log(`  ✓ ${tokenData.symbol} (${tokenData.name}) - ${tokenData.decimals} decimals`);
      successCount++;
    } catch (error: any) {
      console.error(`  ✗ Failed to fetch token data: ${error.message}`);
      failCount++;
    }
  }

  console.log(`\nToken data fetching completed: ${successCount} successful, ${failCount} failed\n`);
}

// Helper function to get token symbol
async function getTokenSymbol(tokenAddress: Address): Promise<string> {
  // Check token database (should be populated by loadTokensFromOnchain)
  const metadata = TOKEN_DATABASE?.[tokenAddress.toLowerCase()];
  if (metadata) {
    return metadata.symbol;
  }

  if (isNativeToken(tokenAddress)) {
    return "MON"; // Native token symbol
  }

  // If not found, return address as symbol
  console.warn(`  Token symbol not found in database for ${tokenAddress}`);
  return "UNKNOWN";
}

// Helper function to calculate gas cost in tokenOut
function calculateGasCostInTokenOut(gasUsed: string, tokenOutAddress: string, tokenOutDecimals: number): string {
  try {
    // Gas price on Monad (rough estimate; override by setting DEFAULT_GAS_PRICE where applicable)
    const gasPrice = BigInt("1000000000"); // 1 Gwei in Wei
    const gasCostInWei = BigInt(gasUsed) * gasPrice;
    const gasCostInMON = Number(gasCostInWei) / 10 ** 18;

    // Get MON price in tokenOut
    const monPriceInToken = TOKEN_PRICES_IN_NATIVE_TOKEN[tokenOutAddress.toLowerCase()];

    if (!monPriceInToken) {
      console.log(`  No MON price for token ${tokenOutAddress}, cannot calculate gas cost`);
      return "0";
    }

    // Calculate gas cost in tokenOut
    const gasCostInTokenOut = gasCostInMON * monPriceInToken;
    const gasCostInTokenOutWei = BigInt(Math.floor(gasCostInTokenOut * 10 ** tokenOutDecimals));

    return gasCostInTokenOutWei.toString();
  } catch (error: any) {
    console.error(`  Error calculating gas cost in tokenOut:`, error.message);
    return "0";
  }
}

// Helper function to calculate net amount
function calculateNetAmount(amountOut: string, gasCostInTokenOut: string): string {
  try {
    const amountOutBigInt = BigInt(amountOut);
    const gasCostBigInt = BigInt(gasCostInTokenOut);

    // Net amount = amountOut - gas cost
    const netAmount = amountOutBigInt - gasCostBigInt;

    // If net amount is negative, return 0
    if (netAmount < 0n) {
      return "0";
    }

    return netAmount.toString();
  } catch (error: any) {
    console.error(`  Error calculating net amount:`, error.message);
    return amountOut; // Return original amount if calculation fails
  }
}

// Helper function to get token decimals
async function getTokenDecimals(tokenAddress: Address): Promise<number> {
  // Check token database (should be populated by loadTokensFromOnchain)
  const metadata = TOKEN_DATABASE?.[tokenAddress.toLowerCase()];
  if (metadata) {
    return metadata.decimals;
  }

  if (isNativeToken(tokenAddress)) {
    return 18; // Native token decimals
  }

  // If not found, default to 18 decimals
  console.warn(`  Token decimals not found in database for ${tokenAddress}`);
  return 18;
}

// Cache for balance slots to avoid repeated searches
const BALANCE_SLOT_CACHE: Record<string, number> = {};

// Helper function to find ERC20 balance storage slot
// This tries common slot patterns used by most ERC20 tokens
async function findBalanceSlot(client: any, tokenAddress: Address, holderAddress: Address): Promise<number | null> {
  // Check cache first
  const cacheKey = tokenAddress.toLowerCase();
  if (BALANCE_SLOT_CACHE[cacheKey] !== undefined) {
    return BALANCE_SLOT_CACHE[cacheKey];
  }

  const testAmount = BigInt("123456789123456789123456789"); // Unique test amount

  console.log(`       Searching for balance slot for token ${tokenAddress}...`);

  for (const slot of COMMON_SLOTS_FOR_BALANCE_SET) {
    try {
      // Calculate the storage slot for this address
      // Standard Solidity mapping formula: keccak256(key . slot)
      const keyPadded = pad(holderAddress, { size: 32 });
      const slotPadded = pad(toHex(slot), { size: 32 });
      const balanceSlot = keccak256(concat([keyPadded, slotPadded])) as Hash;

      // Try setting a test balance
      await client.setStorageAt({
        address: tokenAddress,
        index: balanceSlot,
        value: pad(toHex(testAmount), { size: 32 }),
      });

      // Wait a bit for the state to update
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check if the balance was actually set
      const balance = (await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [holderAddress],
      })) as bigint;

      if (balance === testAmount) {
        console.log(`       ✓ Found balance slot ${slot} for token ${tokenAddress}`);
        BALANCE_SLOT_CACHE[cacheKey] = slot;

        // Reset to 0 to clean up
        await client.setStorageAt({
          address: tokenAddress,
          index: balanceSlot,
          value: pad(toHex(0n), { size: 32 }),
        });

        return slot;
      }
    } catch (error) {
      // Continue to next slot
      continue;
    }
  }

  console.warn(`       Could not find balance slot for token ${tokenAddress} through testing`);
  return null;
}

// Helper function to detect if a contract is a proxy and get its implementation
async function detectProxyImplementation(client: any, address: Address): Promise<Address | null> {
  // Common proxy implementation storage slots
  const PROXY_SLOTS = [
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", // EIP-1967
    "0x5f3b5dfeb7b28cdbd7faba78963ee202a494e2a2cc8c9978b5e1354f480f6e77", // OpenZeppelin unstructured
    "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3", // Old implementation
  ];

  for (const slot of PROXY_SLOTS) {
    try {
      const implAddress = await client.getStorageAt({
        address,
        slot: slot as Hash,
      });

      if (implAddress && implAddress !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        // Remove padding and convert to address
        const impl = ("0x" + implAddress.slice(-40)) as Address;
        console.log(`       ✓ Detected proxy implementation at: ${impl}`);
        return impl;
      }
    } catch {
      // Continue checking other slots
    }
  }

  return null;
}

// Helper function to set ERC20 balance via storage manipulation
async function setERC20Balance(
  client: any,
  tokenAddress: Address,
  holderAddress: Address,
  amount: bigint,
): Promise<boolean> {
  console.log(`       Setting ERC20 balance for token ${tokenAddress}...`);

  // Check if this is a proxy contract
  const implementationAddress = await detectProxyImplementation(client, tokenAddress);
  if (implementationAddress) {
    console.log(`       This is a proxy contract. Will manipulate storage at implementation level.`);
  }

  // Method 1: Try Anvil's direct RPC method for setting ERC20 balance
  try {
    // Use anvil_setStorageAt directly with proper slot calculation
    for (const slot of COMMON_SLOTS_FOR_BALANCE_SET) {
      try {
        // Calculate storage slot using proper formula
        const abiEncodedKey = pad(holderAddress, { size: 32 }).slice(2); // Remove 0x
        const abiEncodedSlot = pad(toHex(slot), { size: 32 }).slice(2); // Remove 0x
        const concatenated = "0x" + abiEncodedKey + abiEncodedSlot;
        const storageSlot = keccak256(concatenated as Hash);

        // Read the original value first
        const originalValue = (await client.request({
          method: "eth_getStorageAt",
          params: [tokenAddress, storageSlot, "latest"],
        })) as Hash;

        // For proxy contracts, we need to manipulate storage at the proxy address
        await client.request({
          method: "anvil_setStorageAt",
          params: [tokenAddress, storageSlot, pad(toHex(amount), { size: 32 })],
        });

        // Wait 1 second for state to propagate and prevent timeouts
        await sleep(1000);

        // Check if it worked
        const balance = (await client.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [holderAddress],
        })) as bigint;

        if (balance >= amount) {
          console.log(`       ✓ Successfully set balance using direct RPC (slot ${slot}): ${balance.toString()}`);
          BALANCE_SLOT_CACHE[tokenAddress.toLowerCase()] = slot;
          return true;
        } else {
          // Restore the original value if this slot didn't work
          await client.request({
            method: "anvil_setStorageAt",
            params: [tokenAddress, storageSlot, originalValue],
          });
        }
      } catch {
        continue;
      }
    }
  } catch (rpcError) {
    console.log(`       Direct RPC method failed, trying alternative methods...`);
  }

  // Method 2: Try using hardhat_setBalance for ERC20 (sometimes works for certain tokens)
  try {
    // Some forks support setting ERC20 balances directly through hardhat methods
    await client.request({
      method: "hardhat_setBalance",
      params: [holderAddress, toHex(amount * 10n ** 18n)], // Try with a very large balance
    });

    // Now try to transfer tokens from a whale address if one exists
    // This is a workaround for tokens that don't allow direct balance manipulation
    const balance = (await client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holderAddress],
    })) as bigint;

    if (balance >= amount) {
      console.log(`       ✓ Successfully set balance using hardhat method: ${balance.toString()}`);
      return true;
    }
  } catch {
    // Method failed, continue to next
  }

  // Method 3: Try Anvil's impersonateAccount + deal method
  try {
    // First impersonate the account
    await client.impersonateAccount({ address: holderAddress });

    // Use Anvil's deal cheatcode to set the balance
    // deal(address token, address account, uint256 amount)
    const dealAbi = [
      {
        inputs: [
          { name: "token", type: "address" },
          { name: "account", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        name: "deal",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
      },
    ];

    try {
      await client.writeContract({
        address: "0x7109709ECfa91a80626fF3989D68f67F5b1DD12D" as Address, // Anvil VM contract
        abi: dealAbi,
        functionName: "deal",
        args: [tokenAddress, holderAddress, amount],
        account: holderAddress,
      });

      // Verify the balance was set
      const balance = (await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [holderAddress],
      })) as bigint;

      if (balance >= amount) {
        console.log(`       ✓ Successfully set balance using Anvil deal: ${balance.toString()}`);
        await client.stopImpersonatingAccount({ address: holderAddress });
        return true;
      }
    } catch (dealError) {
      // Deal method failed, try next method
    }

    await client.stopImpersonatingAccount({ address: holderAddress });
  } catch (impersonateError) {
    // Impersonate failed, continue to next method
  }

  // Method 4: Try OpenZeppelin v5.0.2 upgradeable pattern (ERC-7201 Namespaced Storage)
  try {
    // OpenZeppelin v5.0.2 uses ERC-7201 (Namespaced Storage Layout)
    // For ERC20Upgradeable, the namespace is calculated as:
    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC20")) - 1)) & ~bytes32(uint256(0xff))

    // The correct namespace for OpenZeppelin ERC20 v5.0.2
    const ERC20_NAMESPACE_ID = "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"; // keccak256("openzeppelin.storage.ERC20") - 1

    // The balances mapping is the first slot in the namespace (offset 0x00)
    const balancesSlot = BigInt(ERC20_NAMESPACE_ID);

    // Calculate the storage slot for the specific address
    // For mapping at slot s, address a: keccak256(abi.encode(a, s))
    const abiEncodedKey = pad(holderAddress, { size: 32 });
    const abiEncodedSlot = pad(toHex(balancesSlot), { size: 32 });

    // Try the correct order for OZ v5
    const balanceStorageSlot = keccak256(concat([abiEncodedKey, abiEncodedSlot])) as Hash;

    await client.request({
      method: "anvil_setStorageAt",
      params: [tokenAddress, balanceStorageSlot, pad(toHex(amount), { size: 32 })],
    });

    // Wait 1 second to prevent timeouts
    await sleep(1000);

    // Verify the balance
    const balance = (await client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holderAddress],
    })) as bigint;

    if (balance >= amount) {
      console.log(`       ✓ Successfully set balance using OpenZeppelin v5.0.2 pattern: ${balance.toString()}`);
      return true;
    }
  } catch {
    // OpenZeppelin v5 pattern didn't work, continue to next method
  }

  // Method 5: Try direct storage manipulation with slot finding
  try {
    const slot = await findBalanceSlot(client, tokenAddress, holderAddress);

    if (slot !== null) {
      // Calculate the storage slot for the balance mapping
      const keyPadded = pad(holderAddress, { size: 32 });
      const slotPadded = pad(toHex(slot), { size: 32 });
      const balanceSlot = keccak256(concat([keyPadded, slotPadded])) as Hash;

      // Read the original value first
      const originalValue = (await client.request({
        method: "eth_getStorageAt",
        params: [tokenAddress, balanceSlot, "latest"],
      })) as Hash;

      // Set the balance
      await client.setStorageAt({
        address: tokenAddress,
        index: balanceSlot,
        value: pad(toHex(amount), { size: 32 }),
      });

      // Wait 1 second to prevent timeouts
      await sleep(1000);

      // Verify the balance was set correctly
      const actualBalance = (await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [holderAddress],
      })) as bigint;

      if (actualBalance >= amount) {
        console.log(`       ✓ Successfully set balance via storage (slot ${slot}): ${actualBalance.toString()}`);
        return true;
      } else {
        // Restore the original value if this didn't work
        await client.setStorageAt({
          address: tokenAddress,
          index: balanceSlot,
          value: originalValue,
        });
      }
    }
  } catch (storageError) {
    console.error(`       Storage manipulation error:`, storageError);
  }

  // Method 6: Try using Anvil's setBalance with a wrapped approach
  try {
    // For some tokens, we might need to manipulate totalSupply as well
    // Try common totalSupply slots
    const totalSupplySlots = [2, 3, 4, 5, 6, 7, 8];

    for (const supplySlot of totalSupplySlots) {
      try {
        // Set a very large total supply to ensure we have enough tokens
        const largeTotalSupply = amount * 1000n;
        await client.setStorageAt({
          address: tokenAddress,
          index: pad(toHex(supplySlot), { size: 32 }),
          value: pad(toHex(largeTotalSupply), { size: 32 }),
        });

        // Now try setting balance again with the known slots
        for (const balSlot of [0, 1, 2, 3, 4, 5]) {
          const keyPadded = pad(holderAddress, { size: 32 });
          const slotPadded = pad(toHex(balSlot), { size: 32 });
          const balanceSlot = keccak256(concat([keyPadded, slotPadded])) as Hash;

          await client.setStorageAt({
            address: tokenAddress,
            index: balanceSlot,
            value: pad(toHex(amount), { size: 32 }),
          });

          const balance = (await client.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [holderAddress],
          })) as bigint;

          if (balance >= amount) {
            console.log(`       ✓ Successfully set balance with totalSupply adjustment: ${balance.toString()}`);
            BALANCE_SLOT_CACHE[tokenAddress.toLowerCase()] = balSlot;
            return true;
          }
        }
      } catch {
        continue;
      }
    }
  } catch (totalSupplyError) {
    console.error(`       Total supply manipulation error:`, totalSupplyError);
  }

  // Method 7: Special handling for proxy contracts with reverse slot ordering
  if (implementationAddress) {
    try {
      console.log(`       Attempting proxy-specific storage patterns...`);

      // For proxies, try various slot patterns with different key orderings
      const proxySlots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 51, 52, 100, 101, 102];

      for (const slot of proxySlots) {
        try {
          // Try slot.key order (reverse of standard)
          const keyPadded = pad(holderAddress, { size: 32 });
          const slotPadded = pad(toHex(slot), { size: 32 });
          const balanceSlotReverse = keccak256(concat([slotPadded, keyPadded])) as Hash;

          // Read the original value first
          const originalValue = (await client.request({
            method: "eth_getStorageAt",
            params: [tokenAddress, balanceSlotReverse, "latest"],
          })) as Hash;

          await client.request({
            method: "anvil_setStorageAt",
            params: [
              tokenAddress, // Storage at proxy
              balanceSlotReverse,
              pad(toHex(amount), { size: 32 }),
            ],
          });

          const balance = (await client.readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [holderAddress],
          })) as bigint;

          if (balance >= amount) {
            console.log(`       ✓ Proxy balance set with reverse slot ordering (slot ${slot}): ${balance.toString()}`);
            BALANCE_SLOT_CACHE[tokenAddress.toLowerCase()] = slot;
            return true;
          } else {
            // Restore the original value if this slot didn't work
            await client.request({
              method: "anvil_setStorageAt",
              params: [tokenAddress, balanceSlotReverse, originalValue],
            });
          }
        } catch {
          continue;
        }
      }
    } catch {
      console.log(`       Proxy-specific methods failed`);
    }
  }

  console.error(`       ✗ Failed to set ERC20 balance for ${tokenAddress}`);
  return false;
}

// Helper function to set native token balance
async function setNativeBalance(client: any, address: Address, amount: bigint): Promise<void> {
  try {
    await client.setBalance({
      address,
      value: amount,
    });
    console.log(`       Set native balance for ${address}: ${amount.toString()}`);
  } catch (error) {
    console.error(`     Error setting native balance:`, error);
    throw error;
  }
}

// Helper function to approve ERC20 token
async function approveERC20(
  client: any,
  tokenAddress: Address,
  spenderAddress: Address,
  amount: bigint,
): Promise<void> {
  try {
    // Use max uint256 for infinite approval to avoid approval issues
    const MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

    const hash = await client.writeContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [spenderAddress, MAX_UINT256],
      account: TEST_ACCOUNT,
    });

    await client.waitForTransactionReceipt({ hash });
    console.log(`       Approved infinite tokens to ${spenderAddress}`);
  } catch (error) {
    console.error(`       Error approving ERC20:`, error);
    throw error;
  }
}

// Helper function to get token balance
async function getTokenBalance(
  client: any,
  tokenAddress: Address,
  holderAddress: Address,
  isNative: boolean,
): Promise<bigint> {
  if (isNative) {
    return await client.getBalance({ address: holderAddress });
  } else {
    return (await client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holderAddress],
    })) as bigint;
  }
}

// Helper function to fork to specific block
async function forkToBlock(client: any, blockNumber: bigint): Promise<void> {
  try {
    // Use retry logic for fork reset with extended timeouts
    await resetForkWithRetry(client, MONAD_RPC_URL, blockNumber, {
      maxAttempts: 5, // Try up to 5 times for fork operations
    });

    // Wait 1 second after forking to prevent timeouts
    await sleep(1000);

    const currentBlock = await client.getBlockNumber();
    console.log(`       Fork set to block: ${currentBlock}`);
  } catch (error: any) {
    console.error(`    Error forking to block ${blockNumber}:`, error.message);
    throw error;
  }
}

// Helper function to simulate transaction
async function simulateTransaction(
  client: any,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  swapData: SwapTransaction,
): Promise<SimulationResult> {
  try {
    const isNative = isNativeToken(tokenIn);

    // Set up balances
    if (isNative) {
      // Set a very high balance to ensure enough for value + gas costs
      // Gas costs can be unpredictable, so we set 1000000x the swap amount or minimum 1000 MON
      const minBalance = BigInt(1000) * BigInt(10) ** BigInt(18); // 1000 MON
      const calculatedBalance = amountIn * 1000000n;
      const balance = calculatedBalance > minBalance ? calculatedBalance : minBalance;
      await setNativeBalance(client, TEST_ACCOUNT, balance);

      // Verify the balance was set
      const actualBalance = await client.getBalance({ address: TEST_ACCOUNT });
      console.log(`       Verified native balance: ${actualBalance.toString()}`);
    } else {
      // Set 10x the required amount to handle fees, slippage, and other edge cases
      const bufferMultiplier = 10n;
      const bufferedAmount = amountIn * bufferMultiplier;
      const balanceSetSuccess = await setERC20Balance(client, tokenIn, TEST_ACCOUNT, bufferedAmount);

      // Verify the balance was set
      const actualBalance = (await client.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [TEST_ACCOUNT],
      })) as bigint;
      console.log(`       Verified ERC20 balance: ${actualBalance.toString()}`);

      if (!balanceSetSuccess || actualBalance < amountIn) {
        console.error(`       ERROR: Failed to set ERC20 balance. Expected ${amountIn}, got ${actualBalance}`);
        return {
          status: "error",
          amountOut: "0",
          error: `Failed to set token balance for simulation`,
        };
      }

      // Approve the swap contract with the buffered amount to ensure enough allowance
      await approveERC20(client, tokenIn, swapData.to as Address, bufferedAmount);

      // Verify the approval
      const allowance = (await client.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "allowance",
        args: [TEST_ACCOUNT, swapData.to as Address],
      })) as bigint;
      console.log(`       Verified allowance: ${allowance.toString()}`);

      if (allowance < amountIn) {
        console.warn(`       WARNING: Approval failed. Expected ${amountIn}, got ${allowance}`);
      }
    }

    // Wait 1 second after balance setup to ensure state is settled
    await sleep(1000);

    // Get initial balance of output token
    const isNativeOut = isNativeToken(tokenOut);
    const initialBalance = await getTokenBalance(client, tokenOut as Address, TEST_ACCOUNT, isNativeOut);

    // Wait before verification to prevent timeouts
    await sleep(1000);

    // Verify target contract exists
    const targetCode = await client.getBytecode({
      address: swapData.to as Address,
    });
    if (!targetCode || targetCode === "0x") {
      throw new Error(`Target contract ${swapData.to} does not exist`);
    }

    // Execute the swap transaction with retry logic
    let receipt: any;

    try {
      // Use retry logic for transaction execution
      receipt = await executeTransactionWithRetry(
        client,
        {
          account: TEST_ACCOUNT,
          to: swapData.to as Address,
          data: swapData.data as Hash,
          value: swapData.value ? BigInt(swapData.value) : 0n,
          gas: 30000000n, // Use calculated gas limit or fallback
        },
        {
          maxAttempts: 3,
          timeout: 600_000, // 10 minute timeout for transaction
        },
      );
    } catch (txError: any) {
      console.error(`    Transaction failed after retries: ${txError.message}`);

      // Try to get revert reason
      if (txError.cause?.reason) {
        console.error(`    Revert reason: ${txError.cause.reason}`);
      }

      // Check if it's a timeout that we should propagate for higher-level retry
      if (txError.message?.includes("timeout") || txError.message?.includes("timed out")) {
        throw txError; // Re-throw to be handled by higher-level retry
      }

      return {
        status: "error",
        amountOut: "0",
        error: txError.cause?.reason || txError.message || "Unknown error",
      };
    }

    if (receipt.status === "success") {
      // Wait 1 second after transaction to ensure state is settled
      await sleep(1000);

      // Get final balance and calculate amount out
      const finalBalance = await getTokenBalance(client, tokenOut as Address, TEST_ACCOUNT, isNativeOut);
      const amountOut = finalBalance - initialBalance;

      // Calculate net output (output - gas in tokenOut)
      const tokenOutDecimals = await getTokenDecimals(tokenOut as Address);
      const gasCostInTokenOut = calculateGasCostInTokenOut(receipt.gasUsed.toString(), tokenOut, tokenOutDecimals);
      const netOutput = calculateNetAmount(amountOut.toString(), gasCostInTokenOut);

      console.log(
        `       Simulation successful - Output: ${amountOut.toString()} (Gas: ${receipt.gasUsed.toString()}) | Net Output: ${netOutput}`,
      );

      return {
        status: "success",
        amountOut: amountOut.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };
    } else {
      console.log(`    Transaction reverted (Gas: ${receipt.gasUsed.toString()})`);

      // Try to decode the revert reason
      try {
        const call = await client.call({
          account: TEST_ACCOUNT,
          to: swapData.to as Address,
          data: swapData.data as Hash,
          value: swapData.value ? BigInt(swapData.value) : 0n,
          blockNumber: receipt.blockNumber,
        });
        console.log(`       Revert data: ${call.data}`);
      } catch (callError: any) {
        console.log(`       Revert details: ${callError.message}`);
      }

      return {
        status: "reverted",
        amountOut: "0",
        error: "Transaction reverted",
        gasUsed: receipt.gasUsed.toString(),
      };
    }
  } catch (error: any) {
    console.error(`    Simulation error: ${error.message}`);
    return {
      status: "error",
      amountOut: "0",
      error: error.message || "Unknown error",
    };
  }
}

// Helper function to build quote URL using aggregator class
function buildQuoteUrl(aggregator: BaseAggregator, request: QuoteRequest): string {
  return aggregator.buildQuoteUrl(request);
}

// Helper function to fetch quote (without simulation)
async function fetchQuote(
  aggregator: BaseAggregator,
  pair: TokenPair,
  usdAmount: number,
): Promise<TestResult & { txData?: any; amountIn?: string }> {
  // Fetch token info if not already in the pair object
  const tokenInDecimals = await getTokenDecimals(pair.tokenIn as Address);
  const tokenOutDecimals = await getTokenDecimals(pair.tokenOut as Address);
  const tokenFromSymbol = pair.tokenFromSymbol ?? (await getTokenSymbol(pair.tokenIn as Address));
  const tokenToSymbol = pair.tokenToSymbol ?? (await getTokenSymbol(pair.tokenOut as Address));

  // Update the pair object to avoid fetching again
  pair.tokenFromSymbol = tokenFromSymbol;
  pair.tokenToSymbol = tokenToSymbol;

  // Calculate amountIn based on USD amount and token price
  // amountIn = usdAmount * price * 10^decimals
  const amountIn = calculateAmountIn(usdAmount, pair.tokenIn, tokenInDecimals);
  const amountInTokenIn = amountIn.toString(); // Keep in Wei

  const request: QuoteRequest = {
    chain: CHAIN_ID,
    tokenIn: pair.tokenIn,
    tokenOut: pair.tokenOut,
    amountIn: amountIn.toString(),
    tokenInDecimals: tokenInDecimals,
    tokenOutDecimals: tokenOutDecimals,
    includePoolInfo: true,
    slippage: SLIPPAGE,
  };

  const url = buildQuoteUrl(aggregator, request);
  const startTime = performance.now();

  try {
    // Use aggregator class to add request data
    const fetchOptions: FetchOptions = {};
    aggregator.addRequestData(request, fetchOptions);

    const response = await fetch(url, fetchOptions as RequestInit);
    const endTime = performance.now();
    const duration = Math.round(endTime - startTime);

    // Get current block number from the network
    const publicClient = createPublicClient({
      chain: customChain,
      transport: http(customChain.rpcUrls.default.http[0]),
    });
    const blockNumber = await publicClient.getBlockNumber();

    const rawBody = await response.text();
    let data: any = null;
    let parsedOk = false;
    if (rawBody) {
      try {
        data = JSON.parse(rawBody);
        parsedOk = true;
      } catch {
        data = rawBody; // keep raw text
      }
    }

    // Use aggregator class to parse output (only if JSON)
    const { outputAmount, txData, routesCount, fullData } = parsedOk ? aggregator.getOutput(data) : {
      outputAmount: "0",
      txData: null,
      routesCount: 0,
      fullData: data,
    };

    const quoteError = response.ok
      ? undefined
      : parsedOk
        ? (data?.error || data?.message || data?.detail || data?.reason || `HTTP ${response.status}`)?.toString?.()
        : `Non-JSON response (HTTP ${response.status}): ${String(rawBody).slice(0, 300)}`;

    return {
      time: new Date().toUTCString(),
      timestamp: Date.now(),
      protocol: aggregator.name,
      tokenFromSymbol: tokenFromSymbol,
      tokenToSymbol: tokenToSymbol,
      tokenIn: pair.tokenIn,
      tokenOut: pair.tokenOut,
      amount: usdAmount.toString(),
      amountInTokenIn: amountInTokenIn,
      output: outputAmount,
      duration,
      status: response.status,
      url,
      routes: routesCount,
      durationResult: "",
      outputResult: "",
      outputAdj: outputAmount,
      blockNumber: blockNumber.toString(),
      quoteError,
      simulationStatus: "pending",
      simulationOutput: "0",
      simulationError: undefined,
      txData: txData,
      amountIn: amountIn.toString(),
      fullData: fullData,
    };
  } catch (error) {
    const endTime = performance.now();
    const duration = Math.round(endTime - startTime);

    return {
      time: new Date().toUTCString(),
      timestamp: Date.now(),
      protocol: aggregator.name,
      tokenFromSymbol: tokenFromSymbol,
      tokenToSymbol: tokenToSymbol,
      tokenIn: pair.tokenIn,
      tokenOut: pair.tokenOut,
      amount: usdAmount.toString(),
      amountInTokenIn: amountInTokenIn,
      output: "0",
      duration,
      status: 0,
      url,
      routes: 0,
      durationResult: "",
      outputResult: "",
      outputAdj: "0",
      blockNumber: undefined,
      quoteError: (error as any)?.message || "Failed to fetch/parse quote",
      simulationStatus: "error",
      simulationOutput: "0",
      simulationError: "Failed to fetch quote",
    };
  }
}

// Helper function to compare results from multiple aggregators
function compareResults(results: TestResult[]): void {
  if (results.length === 0) return;

  // Filter out results with 0 output for duration comparison
  const validResults = results.filter((r) => {
    const output = BigInt(r.output || "0");
    return output > 0n;
  });

  // Find the fastest duration (only among valid results with non-zero output)
  const minDuration = validResults.length > 0 ? Math.min(...validResults.map((r) => r.duration)) : Infinity;

  // Find the best output
  const maxOutput = results.reduce((max, r) => {
    const output = BigInt(r.output || "0");
    return output > max ? output : max;
  }, 0n);

  // Find the best net amount (if available)
  const maxNetAmount = results.reduce((max, r) => {
    const netAmount = BigInt(r.netAmount || r.simulationOutput || r.output || "0");
    return netAmount > max ? netAmount : max;
  }, 0n);

  // Update each result with comparison metadata
  for (const result of results) {
    const output = BigInt(result.output || "0");

    // Duration comparison
    if (output === 0n) {
      // Failed results don't get marked as fastest
      result.durationResult = "failed";
    } else {
      const durationDiff = result.duration - minDuration;
      if (durationDiff === 0) {
        result.durationResult = "fastest";
      } else {
        result.durationResult = `+${durationDiff}.00ms`;
      }
    }

    // Output comparison
    if (output === maxOutput && maxOutput > 0n) {
      result.outputResult = "best";
    } else if (maxOutput > 0n) {
      const percentDiff = Number(((output - maxOutput) * 10000n) / maxOutput) / 100;
      result.outputResult = `${percentDiff.toFixed(1)}%`;
    } else {
      result.outputResult = "-100.0%";
    }

    // Mark best net amount (will be used in summary)
    const netAmount = BigInt(result.netAmount || result.simulationOutput || result.output || "0");
    (result as any).netAmountResult = netAmount === maxNetAmount && maxNetAmount > 0n ? "best" : "";
  }
}

// Helper function to calculate percentile from sorted array
function calculatePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;

  const index = (percentile / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) {
    return sortedValues[lower];
  }

  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

// Helper function to log reverted base aggregator transactions
async function logRevertedBaseTransaction(baseResult: any, filePath: string): Promise<void> {
  const separator = "=".repeat(80);

  let logContent = `\n${separator}\n`;
  logContent += `REVERTED TRANSACTION - ${new Date().toISOString()}\n`;
  logContent += `${separator}\n\n`;

  logContent += `Token In: ${baseResult.tokenIn}\n`;
  logContent += `Token Out: ${baseResult.tokenOut}\n`;
  logContent += `Block Number: ${baseResult.blockNumber || "N/A"}\n`;
  logContent += `Amount In (USD): $${baseResult.amount}\n`;
  logContent += `Amount In Token In (Wei): ${baseResult.amountInTokenIn || "N/A"}\n\n`;

  logContent += `QUOTE REQUEST:\n`;
  logContent += `  URL: ${baseResult.url || "N/A"}\n`;
  logContent += `  Protocol: ${baseResult.protocol}\n`;
  logContent += `  From: ${baseResult.tokenIn} (${baseResult.tokenFromSymbol || ""})\n`;
  logContent += `  To: ${baseResult.tokenOut} (${baseResult.tokenToSymbol || ""})\n`;
  logContent += `  Amount: ${baseResult.amountInTokenIn || "N/A"}\n\n`;

  logContent += `QUOTE RESPONSE:\n`;
  logContent += JSON.stringify(baseResult.fullData || {}, null, 2);
  logContent += `\n${separator}\n`;

  try {
    await appendFile(filePath, logContent);
  } catch (error) {
    // File doesn't exist, create it
    await writeFile(filePath, logContent);
  }
}

// Helper function to write better quotes comparison
async function writeBetterQuotesComparison(
  results: TestResult[],
  aggregatorInstances: BaseAggregator[],
  outputDir: string,
  outputFilePath: string,
): Promise<void> {
  // Find the base aggregator
  const baseAggregator = aggregatorInstances.find((agg) => agg.isBaseCompareAggregator());

  if (!baseAggregator) {
    console.log("No base aggregator found for comparison");
    return;
  }

  console.log(`Using ${baseAggregator.name} as base aggregator for comparison`);

  // Group results by route (tokenIn, tokenOut, amount)
  const routeGroups = new Map<string, TestResult[]>();

  for (const result of results) {
    const routeKey = `${result.tokenFromSymbol}-${result.tokenToSymbol}-${result.amount}`;
    if (!routeGroups.has(routeKey)) {
      routeGroups.set(routeKey, []);
    }
    routeGroups.get(routeKey)!.push(result);
  }

  // Compare results and find better quotes (only the best per route)
  const betterQuotes: any[] = [];

  for (const [routeKey, routeResults] of routeGroups.entries()) {
    // Find the base aggregator result
    const baseResult = routeResults.find((r) => r.protocol === baseAggregator.name);

    if (!baseResult) {
      continue;
    }

    // Check if base aggregator's simulation was reverted
    const baseReverted = baseResult.simulationStatus === "reverted";

    // Log reverted base aggregator transactions
    if (baseReverted) {
      const filename = `${outputFilePath.split("/").pop()?.split(".")[0]}_reverted.txt`;
      const filepath = `${outputDir}/${filename}`;
      await logRevertedBaseTransaction(baseResult, filepath);
    }

    // Get the base aggregator's net amount (or simulation output, or output)
    const baseNetAmount = BigInt(baseResult.netAmount || baseResult.simulationOutput || baseResult.output || "0");

    // If base has no valid output and didn't revert, skip
    if (baseNetAmount === 0n && !baseReverted) {
      continue;
    }

    // Find the best aggregator for this route (highest net amount)
    let bestResult: (typeof routeResults)[0] | null = null;
    let bestNetAmount = BigInt("0");

    for (const result of routeResults) {
      if (result.protocol === baseAggregator.name) {
        continue; // Skip the base aggregator itself
      }

      const otherNetAmount = BigInt(result.netAmount || result.simulationOutput || result.output || "0");

      // For reverted base, accept any successful result; otherwise only better results
      if (
        (baseReverted && otherNetAmount > 0n && result.simulationStatus !== "reverted") ||
        (!baseReverted && otherNetAmount > baseNetAmount)
      ) {
        // Check if this aggregator's net amount is better than the current best
        if (otherNetAmount > bestNetAmount) {
          bestResult = result;
          bestNetAmount = otherNetAmount;
        }
      }
    }

    // If we found a better aggregator (or any successful one when base reverted), add it to the results
    if (bestResult) {
      const improvement = baseReverted
        ? "N/A (base reverted)"
        : `+${Number(((bestNetAmount - baseNetAmount) * 10000n) / baseNetAmount) / 100}%`;

      const improvementPercentage = baseReverted
        ? 999999 // Use a large number to sort reverted cases
        : Number(((bestNetAmount - baseNetAmount) * 10000n) / baseNetAmount) / 100;

      betterQuotes.push({
        timestamp: bestResult.time,
        route: routeKey,
        tokenFromSymbol: bestResult.tokenFromSymbol,
        tokenToSymbol: bestResult.tokenToSymbol,
        tokenIn: bestResult.tokenIn,
        tokenOut: bestResult.tokenOut,
        amount: bestResult.amount,
        amountInTokenIn: bestResult.amountInTokenIn,
        aggregator: bestResult.protocol,
        baseAggregator: baseAggregator.name,
        baseOutput: baseResult.output,
        baseNetAmount: baseNetAmount.toString(),
        baseSimulationStatus: baseResult.simulationStatus,
        baseFullData: baseResult.fullData,
        aggregatorOutput: bestResult.output,
        aggregatorNetAmount: bestNetAmount.toString(),
        aggregatorFullData: bestResult.fullData,
        improvement: improvement,
        improvementPercentage: improvementPercentage,
        gasUsed: bestResult.gasUsed,
        simulationStatus: bestResult.simulationStatus,
        blockNumber: bestResult.blockNumber,
        url: bestResult.url,
        baseReverted: baseReverted,
        fullQuoteResponse: {
          protocol: bestResult.protocol,
          output: bestResult.output,
          netAmount: bestResult.netAmount,
          simulationOutput: bestResult.simulationOutput,
          gasUsed: bestResult.gasUsed,
          routes: bestResult.routes,
          status: bestResult.status,
          duration: bestResult.duration,
          fullData: bestResult.fullData,
        },
      });
    }
  }

  if (betterQuotes.length === 0) {
    console.log(`No quotes found that are better than ${baseAggregator.name}`);
    return;
  }

  // Generate filename with date
  const filename = `${outputFilePath.split("/").pop()?.split(".")[0]}_better_quotes.txt`;
  const filepath = `${outputDir}/${filename}`;

  // Create the content
  const lines: string[] = [];
  // Count reverted vs better quotes
  const revertedBaseCount = betterQuotes.filter((q) => q.baseReverted).length;
  const betterQuotesCount = betterQuotes.length - revertedBaseCount;

  lines.push("=".repeat(80));
  lines.push(`BETTER QUOTES COMPARISON REPORT`);
  lines.push(`Base Aggregator: ${baseAggregator.name}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total Routes: ${betterQuotes.length}`);
  lines.push(`  - Routes with Better Quotes: ${betterQuotesCount}`);
  lines.push(`  - Routes where ${baseAggregator.name} Reverted: ${revertedBaseCount}`);
  lines.push(`Note: Showing only the BEST aggregator per route`);
  lines.push("=".repeat(80));
  lines.push("");

  // Group by aggregator for summary
  const aggregatorSummary = new Map<string, number>();
  for (const quote of betterQuotes) {
    aggregatorSummary.set(quote.aggregator, (aggregatorSummary.get(quote.aggregator) || 0) + 1);
  }

  lines.push("SUMMARY BY AGGREGATOR (times each was the BEST):");
  lines.push("-".repeat(80));
  for (const [agg, count] of Array.from(aggregatorSummary.entries()).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${agg}: ${count} routes where it was the best`);
  }
  lines.push("");

  // Detailed quotes
  lines.push("DETAILED BETTER QUOTES:");
  lines.push("=".repeat(80));

  for (const quote of betterQuotes) {
    lines.push("");
    lines.push(`Route: ${quote.route}`);
    lines.push(`Tokens: ${quote.tokenFromSymbol} -> ${quote.tokenToSymbol}`);
    lines.push(`Amount: $${quote.amount}`);
    lines.push(`Amount in ${quote.tokenFromSymbol} (Wei): ${quote.amountInTokenIn}`);
    lines.push(`Best Aggregator: ${quote.aggregator}`);
    if (quote.baseReverted) {
      lines.push(`Status: BASE AGGREGATOR (${quote.baseAggregator}) REVERTED`);
      lines.push(`Base Simulation Status: ${quote.baseSimulationStatus}`);
    } else {
      lines.push(`Improvement over ${quote.baseAggregator}: ${quote.improvement}`);
    }
    lines.push(`Base Net Amount: ${quote.baseNetAmount}`);
    lines.push(`Best Aggregator Net Amount: ${quote.aggregatorNetAmount}`);
    if (quote.gasUsed) {
      lines.push(`Gas Used: ${quote.gasUsed}`);
    }
    lines.push(`Best Aggregator Simulation Status: ${quote.simulationStatus}`);
    lines.push(`Block: ${quote.blockNumber || "N/A"}`);
    lines.push("");
    lines.push("Full Quote Response:");
    lines.push(JSON.stringify(quote.fullQuoteResponse, null, 2));
    lines.push("");
    lines.push(`Full ${quote.baseAggregator} Response Data:`);
    lines.push(JSON.stringify(quote.baseFullData, null, 2));
    lines.push("");
    lines.push(`Full ${quote.aggregator} Response Data:`);
    lines.push(JSON.stringify(quote.aggregatorFullData, null, 2));
    lines.push("-".repeat(80));
  }

  // Write to text file
  await writeFile(filepath, lines.join("\n"));
  console.log(`Better quotes comparison written to ${filepath}`);

  // Also write to CSV file for easier analysis
  const csvFilepath = filepath.replace(".txt", ".csv");

  // Prepare CSV data (simplified for readability)
  const csvData = betterQuotes.map((quote) => ({
    route: quote.route,
    tokenFromSymbol: quote.tokenFromSymbol,
    tokenToSymbol: quote.tokenToSymbol,
    amount: quote.amount,
    amountInTokenIn: quote.amountInTokenIn,
    bestAggregator: quote.aggregator,
    baseAggregator: quote.baseAggregator,
    baseReverted: quote.baseReverted ? "YES" : "NO",
    baseSimulationStatus: quote.baseSimulationStatus,
    baseOutput: quote.baseOutput,
    baseNetAmount: quote.baseNetAmount,
    bestOutput: quote.aggregatorOutput,
    bestNetAmount: quote.aggregatorNetAmount,
    improvement: quote.baseReverted ? "N/A (base reverted)" : quote.improvementPercentage.toFixed(2),
    gasUsed: quote.gasUsed || "",
    bestSimulationStatus: quote.simulationStatus,
    blockNumber: quote.blockNumber || "",
    url: quote.url,
  }));

  const csv = stringify(csvData, {
    header: true,
    columns: [
      "route",
      "tokenFromSymbol",
      "tokenToSymbol",
      "amount",
      "amountInTokenIn",
      "bestAggregator",
      "baseAggregator",
      "baseReverted",
      "baseSimulationStatus",
      "baseOutput",
      "baseNetAmount",
      "bestOutput",
      "bestNetAmount",
      "improvement",
      "gasUsed",
      "bestSimulationStatus",
      "blockNumber",
      "url",
    ],
  });

  await writeFile(csvFilepath, csv);
  console.log(`Better quotes CSV written to ${csvFilepath}`);
  if (revertedBaseCount > 0) {
    console.log(
      `Found ${betterQuotesCount} better quotes and ${revertedBaseCount} alternatives for reverted ${baseAggregator.name} transactions`,
    );
  } else {
    console.log(`Found ${betterQuotes.length} best quotes better than ${baseAggregator.name} (one per route)`);
  }
}

// Token tier classification for weighted scoring
type TokenTier = 1 | 2 | 3;

// Define token tiers based on market importance
const TIER_1_TOKENS = new Set(["MON", "WETH", "WBTC", "USDC", "USDT"]);
const TIER_2_TOKENS = new Set(["gMON", "sMON", "aprMON", "shMON", "CHOG"]);
// All other tokens are Tier 3

// Classify token into tier
function getTokenTier(tokenSymbol: string): TokenTier {
  if (TIER_1_TOKENS.has(tokenSymbol)) return 1;
  if (TIER_2_TOKENS.has(tokenSymbol)) return 2;
  return 3;
}

// Calculate pair weight based on token tiers
function getPairWeight(tokenFromSymbol: string, tokenToSymbol: string): number {
  const tier1 = getTokenTier(tokenFromSymbol);
  const tier2 = getTokenTier(tokenToSymbol);

  // Sort tiers so we can use a simple lookup
  const [minTier, maxTier] = [tier1, tier2].sort();

  // Tier 1 ↔ Tier 1: 10x
  if (minTier === 1 && maxTier === 1) return 10;
  // Tier 1 ↔ Tier 2: 5x
  if (minTier === 1 && maxTier === 2) return 5;
  // Tier 1 ↔ Tier 3: 2x
  if (minTier === 1 && maxTier === 3) return 2;
  // Tier 2 ↔ Tier 2: 3x
  if (minTier === 2 && maxTier === 2) return 3;
  // Tier 2 ↔ Tier 3: 1x (baseline)
  if (minTier === 2 && maxTier === 3) return 1;
  // Tier 3 ↔ Tier 3: 1x (baseline)
  return 1;
}

// Trade size weights for realistic volume distribution
const TRADE_SIZE_WEIGHTS = {
  small: 0.4,
  medium: 0.5,
  large: 0.1,
} as const;

// Calculate weighted best quote percentage
function calculateWeightedBestQuotePercentage(
  results: TestResult[],
  aggregatorName: string,
): { weightedPercentage: number; totalWeightedBestQuotes: number; totalWeightedTests: number } {
  const categorizeTradeSize = (amount: number): "small" | "medium" | "large" => {
    if (amount <= 100) return "small";
    if (amount <= 10000) return "medium";
    return "large";
  };

  const aggregatorResults = results.filter((r) => r.protocol === aggregatorName);

  let totalWeightedBestQuotes = 0;
  let totalWeightedTests = 0;

  for (const result of aggregatorResults) {
    const pairWeight = getPairWeight(result.tokenFromSymbol, result.tokenToSymbol);
    const sizeCategory = categorizeTradeSize(parseFloat(result.amount));
    const sizeWeight = TRADE_SIZE_WEIGHTS[sizeCategory];

    const combinedWeight = pairWeight * sizeWeight;

    // Add to total weighted tests
    totalWeightedTests += combinedWeight;

    // If this is a best quote, add to weighted best quotes
    if (result.outputResult === "best") {
      totalWeightedBestQuotes += combinedWeight;
    }
  }

  const weightedPercentage = totalWeightedTests > 0 ? (totalWeightedBestQuotes / totalWeightedTests) * 100 : 0;

  return {
    weightedPercentage,
    totalWeightedBestQuotes,
    totalWeightedTests,
  };
}

// Helper function to generate summary report
function generateSummaryReport(results: TestResult[], randomSampleCount: number): string {
  const lines: string[] = [];

  if (results.length === 0) {
    const msg = "No results to analyze.";
    console.log(msg);
    return msg;
  }

  // Get all unique aggregators
  const aggregators = Array.from(new Set(results.map((r) => r.protocol)));

  // Count total number of test routes
  // If using random sampling, use the sample count
  // Otherwise, calculate from the total combinations of pairs × amounts
  let totalRoutes: number;
  if (randomSampleCount > 0) {
    totalRoutes = randomSampleCount;
  } else {
    // For full test mode, use the count of unique pairs × amounts
    // Get this from the aggregator with the most results (assumes at least one aggregator tests all routes)
    const aggregatorResultCounts = aggregators.map((agg) => results.filter((r) => r.protocol === agg).length);
    totalRoutes = Math.max(...aggregatorResultCounts);
  }

  lines.push("\n" + "=".repeat(80));
  lines.push("SUMMARY REPORT");
  lines.push("=".repeat(80));
  if (randomSampleCount > 0) {
    lines.push(`Mode: Random Sampling (${randomSampleCount} samples)`);
  } else {
    lines.push(`Mode: Full Test (all pairs × all amounts)`);
  }
  lines.push(`Total Routes Tested: ${totalRoutes}`);
  lines.push(`Total Aggregators: ${aggregators.length}`);
  lines.push(`Total Tests: ${results.length}\n`);

  // For each aggregator, calculate comprehensive statistics
  const stats = aggregators.map((aggregatorName) => {
    const aggregatorResults = results.filter((r) => r.protocol === aggregatorName);
    const aggregatorRouteCount = aggregatorResults.length;

    const bestQuoteCount = aggregatorResults.filter((r) => r.outputResult === "best").length;
    const fastestCount = aggregatorResults.filter((r) => r.durationResult === "fastest").length;

    const bestQuotePercentage = aggregatorRouteCount > 0 ? (bestQuoteCount / aggregatorRouteCount) * 100 : 0;
    const fastestPercentage = aggregatorRouteCount > 0 ? (fastestCount / aggregatorRouteCount) * 100 : 0;

    // Calculate success rate (responses where output > 0)
    const successfulResults = aggregatorResults.filter((r) => {
      const output = BigInt(r.output || "0");
      return output > 0n;
    });
    const successCount = successfulResults.length;
    const successRate = aggregatorResults.length > 0 ? (successCount / aggregatorResults.length) * 100 : 0;

    // Calculate latency percentiles (only for successful requests)
    const successfulDurations = successfulResults.map((r) => r.duration).sort((a, b) => a - b);
    const p50 = calculatePercentile(successfulDurations, 50);
    const p95 = calculatePercentile(successfulDurations, 95);
    const p99 = calculatePercentile(successfulDurations, 99);

    // Simulation statistics
    // 1. Reverted simulations from successful quotes
    const successfulQuotes = aggregatorResults.filter((r) => {
      const output = BigInt(r.output || "0");
      return output > 0n && r.status === 200;
    });
    const revertedSimulations = successfulQuotes.filter((r) => r.simulationStatus === "reverted");
    const revertedCount = revertedSimulations.length;
    const revertedPercentage = successfulQuotes.length > 0 ? (revertedCount / successfulQuotes.length) * 100 : 0;

    // 2. Average difference between quote and simulation (for successful simulations only)
    const successfulSimulations = aggregatorResults.filter((r) => r.simulationStatus === "success");
    let avgDifference = 0;
    if (successfulSimulations.length > 0) {
      const differences = successfulSimulations.map((r) => {
        const quoteOutput = BigInt(r.output || "0");
        const simOutput = BigInt(r.simulationOutput || "0");

        if (quoteOutput === 0n) return 0;

        // Calculate percentage difference: ((sim - quote) / quote) * 100
        const diff = Number(((simOutput - quoteOutput) * 10000n) / quoteOutput) / 100;
        return diff;
      });

      avgDifference = differences.reduce((sum, d) => sum + d, 0) / differences.length;
    }

    // 3. Best simulation output count (will be calculated later after finding max)
    const successfulSimResults = successfulSimulations.filter((r) => {
      const simOutput = BigInt(r.simulationOutput || "0");
      return simOutput > 0n;
    });

    // Calculate weighted best quote percentage
    const weightedStats = calculateWeightedBestQuotePercentage(results, aggregatorName);

    return {
      aggregatorName,
      bestQuoteCount,
      bestQuotePercentage,
      fastestCount,
      fastestPercentage,
      successCount,
      totalCount: aggregatorResults.length,
      successRate,
      p50,
      p95,
      p99,
      // Simulation stats
      revertedCount,
      revertedPercentage,
      successfulQuotesCount: successfulQuotes.length,
      avgDifference,
      successfulSimulations: successfulSimResults,
      // Weighted stats
      weightedBestQuotePercentage: weightedStats.weightedPercentage,
      totalWeightedBestQuotes: weightedStats.totalWeightedBestQuotes,
      totalWeightedTests: weightedStats.totalWeightedTests,
    };
  });

  // Display Best Quote Percentage
  const sortedByBestQuote = [...stats].sort((a, b) => b.bestQuotePercentage - a.bestQuotePercentage);
  lines.push("BEST QUOTE PERCENTAGE (by aggregator):");
  lines.push("-".repeat(80));
  for (const stat of sortedByBestQuote) {
    lines.push(
      `  ${stat.aggregatorName.padEnd(25)}: ${stat.bestQuotePercentage.toFixed(2).padStart(6)}%  (${stat.bestQuoteCount}/${stat.totalCount} routes)`,
    );
  }

  lines.push("");

  // Display Weighted Best Quote Percentage
  const sortedByWeightedBestQuote = [...stats].sort(
    (a, b) => b.weightedBestQuotePercentage - a.weightedBestQuotePercentage,
  );
  lines.push("WEIGHTED BEST QUOTE PERCENTAGE (by aggregator):");
  lines.push("-".repeat(80));
  lines.push("Weighted by pair importance (Tier 1-3) and trade size distribution");
  lines.push("Trade size weights: Small (40%), Medium (50%), Large (10%)");
  lines.push("Pair weights: T1-T1 (10x), T1-T2 (5x), T2-T2 (3x), T1-T3 (2x), T2-T3 (1x), T3-T3 (1x)");
  lines.push("-".repeat(80));
  for (const stat of sortedByWeightedBestQuote) {
    lines.push(
      `  ${stat.aggregatorName.padEnd(25)}: ${stat.weightedBestQuotePercentage.toFixed(2).padStart(6)}%  (weighted: ${stat.totalWeightedBestQuotes.toFixed(2)}/${stat.totalWeightedTests.toFixed(2)})`,
    );
  }

  lines.push("");

  // Best quote breakdown by pair and aggregator
  lines.push("BEST QUOTE BREAKDOWN BY PAIR AND AGGREGATOR:");
  lines.push("-".repeat(80));

  // Group results by pair
  const pairGroups = new Map<string, TestResult[]>();
  for (const result of results) {
    const pairKey = `${result.tokenFromSymbol}-${result.tokenToSymbol}`;
    if (!pairGroups.has(pairKey)) {
      pairGroups.set(pairKey, []);
    }
    pairGroups.get(pairKey)!.push(result);
  }

  // For each pair, show aggregator stats
  for (const [pairKey, pairResults] of Array.from(pairGroups.entries()).sort()) {
    // Count best quotes per aggregator for this pair
    const pairAggregatorStats = aggregators.map((aggregatorName) => {
      const aggregatorPairResults = pairResults.filter((r) => r.protocol === aggregatorName);
      const aggregatorPairCount = aggregatorPairResults.length;
      const bestCount = aggregatorPairResults.filter((r) => r.outputResult === "best").length;
      const percentage = aggregatorPairCount > 0 ? (bestCount / aggregatorPairCount) * 100 : 0;

      return {
        aggregatorName,
        bestCount,
        percentage,
        totalAmounts: aggregatorPairCount,
      };
    });

    // Sort by best count (descending), then by aggregator name
    pairAggregatorStats.sort((a, b) => {
      if (b.bestCount !== a.bestCount) {
        return b.bestCount - a.bestCount;
      }
      return a.aggregatorName.localeCompare(b.aggregatorName);
    });

    lines.push(`  ${pairKey}:`);
    for (const stat of pairAggregatorStats) {
      lines.push(
        `    ${stat.aggregatorName.padEnd(23)}: ${stat.bestCount}/${stat.totalAmounts} (${stat.percentage.toFixed(2)}%)`,
      );
    }
    lines.push("");
  }

  // Break down best quote percentage by trade size
  // Define trade size categories
  const categorizeTradeSize = (amount: number): "small" | "medium" | "large" => {
    if (amount <= 100) return "small";
    if (amount <= 10000) return "medium";
    return "large";
  };

  // Calculate stats by trade size
  const tradeSizeCategories = ["small", "medium", "large"] as const;

  for (const category of tradeSizeCategories) {
    const categoryResults = results.filter((r) => categorizeTradeSize(parseFloat(r.amount)) === category);

    // Calculate category routes based on mode
    let categoryRoutes: number;
    if (randomSampleCount > 0) {
      // In random sampling mode, count how many samples fall into this category
      // by finding the aggregator with the most results in this category
      const categoryAggregatorCounts = aggregators.map(
        (agg) => categoryResults.filter((r) => r.protocol === agg).length,
      );
      categoryRoutes = Math.max(...categoryAggregatorCounts, 0);
    } else {
      // In full test mode, use the aggregator with the most results
      const categoryAggregatorCounts = aggregators.map(
        (agg) => categoryResults.filter((r) => r.protocol === agg).length,
      );
      categoryRoutes = Math.max(...categoryAggregatorCounts, 0);
    }

    if (categoryRoutes === 0) continue;

    const categoryStats = aggregators.map((aggregatorName) => {
      const aggregatorResults = categoryResults.filter((r) => r.protocol === aggregatorName);
      const aggregatorCategoryCount = aggregatorResults.length;
      const bestQuoteCount = aggregatorResults.filter((r) => r.outputResult === "best").length;
      const bestQuotePercentage = aggregatorCategoryCount > 0 ? (bestQuoteCount / aggregatorCategoryCount) * 100 : 0;

      return {
        aggregatorName,
        bestQuoteCount,
        bestQuotePercentage,
        totalCount: aggregatorCategoryCount,
      };
    });

    // Sort by best quote percentage (descending)
    categoryStats.sort((a, b) => b.bestQuotePercentage - a.bestQuotePercentage);

    // Display category header
    const categoryName = category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`BEST QUOTE PERCENTAGE - ${categoryName.toUpperCase()} TRADES (by aggregator):`);
    lines.push("-".repeat(80));
    for (const stat of categoryStats) {
      lines.push(
        `  ${stat.aggregatorName.padEnd(25)}: ${stat.bestQuotePercentage.toFixed(2).padStart(6)}%  (${stat.bestQuoteCount}/${stat.totalCount} routes)`,
      );
    }
    lines.push("");
  }

  // Sort by fastest percentage (descending)
  stats.sort((a, b) => b.fastestPercentage - a.fastestPercentage);

  lines.push("FASTEST RESPONSE PERCENTAGE (by aggregator):");
  lines.push("-".repeat(80));
  for (const stat of stats) {
    lines.push(
      `  ${stat.aggregatorName.padEnd(20)}: ${stat.fastestPercentage.toFixed(2)}%  (${stat.fastestCount}/${stat.totalCount} routes)`,
    );
  }

  lines.push("");

  // Display Success Rate (best to worst)
  const sortedBySuccessRate = [...stats].sort((a, b) => b.successRate - a.successRate);
  lines.push("SUCCESS RATE (by aggregator):");
  lines.push("-".repeat(80));
  for (const stat of sortedBySuccessRate) {
    lines.push(
      `  ${stat.aggregatorName.padEnd(25)}: ${stat.successRate.toFixed(2).padStart(6)}%  (${stat.successCount}/${stat.totalCount} successful)`,
    );
  }

  lines.push("");

  // Display P50 Latency (best to worst - lower is better)
  const sortedByP50 = [...stats].sort((a, b) => a.p50 - b.p50);
  lines.push("P50 LATENCY (by aggregator):");
  lines.push("-".repeat(80));
  for (const stat of sortedByP50) {
    if (stat.p50 > 0) {
      lines.push(`  ${stat.aggregatorName.padEnd(25)}: ${stat.p50.toFixed(2).padStart(8)}ms`);
    } else {
      lines.push(`  ${stat.aggregatorName.padEnd(25)}: ${"N/A".padStart(8)}`);
    }
  }

  lines.push("");

  // Display P95 Latency (best to worst - lower is better)
  const sortedByP95 = [...stats].sort((a, b) => a.p95 - b.p95);
  lines.push("P95 LATENCY (by aggregator):");
  lines.push("-".repeat(80));
  for (const stat of sortedByP95) {
    if (stat.p95 > 0) {
      lines.push(`  ${stat.aggregatorName.padEnd(25)}: ${stat.p95.toFixed(2).padStart(8)}ms`);
    } else {
      lines.push(`  ${stat.aggregatorName.padEnd(25)}: ${"N/A".padStart(8)}`);
    }
  }

  lines.push("");

  // Display P99 Latency (best to worst - lower is better)
  const sortedByP99 = [...stats].sort((a, b) => a.p99 - b.p99);
  lines.push("P99 LATENCY (by aggregator):");
  lines.push("-".repeat(80));
  for (const stat of sortedByP99) {
    if (stat.p99 > 0) {
      lines.push(`  ${stat.aggregatorName.padEnd(25)}: ${stat.p99.toFixed(2).padStart(8)}ms`);
    } else {
      lines.push(`  ${stat.aggregatorName.padEnd(25)}: ${"N/A".padStart(8)}`);
    }
  }

  // SIMULATION STATISTICS (only if simulation was enabled)
  const hasSimulationData = results.some((r) => r.simulationStatus !== "skipped" && r.simulationStatus !== "pending");

  if (hasSimulationData) {
    lines.push("");
    lines.push("=".repeat(80));
    lines.push("SIMULATION STATISTICS");
    lines.push("=".repeat(80));
    lines.push("");

    // Get unique trade amounts (used across multiple sections)
    const tradeAmounts = Array.from(new Set(results.map((r) => parseFloat(r.amount)))).sort((a, b) => a - b);

    // 1. Simulation Revert Rate
    const sortedByRevertRate = [...stats].sort((a, b) => a.revertedPercentage - b.revertedPercentage);
    lines.push("SIMULATION REVERT RATE (reverted simulations / successful quotes):");
    lines.push("-".repeat(80));
    for (const stat of sortedByRevertRate) {
      if (stat.successfulQuotesCount > 0) {
        lines.push(
          `  ${stat.aggregatorName.padEnd(25)}: ${stat.revertedPercentage.toFixed(2).padStart(6)}%  (${stat.revertedCount}/${stat.successfulQuotesCount} reverted)`,
        );
      } else {
        lines.push(`  ${stat.aggregatorName.padEnd(25)}: ${"N/A".padStart(6)}   (no successful quotes)`);
      }
    }

    lines.push("");

    // 2. Simulation Revert Rate by Trade Size
    lines.push("SIMULATION REVERT RATE BY TRADE SIZE:");
    lines.push("-".repeat(80));

    for (const amount of tradeAmounts) {
      const resultsForAmount = results.filter((r) => parseFloat(r.amount) === amount);

      if (resultsForAmount.length === 0) continue;

      lines.push(`  Trade Size: $${amount}`);

      const revertStatsByAgg = aggregators.map((aggregatorName) => {
        const aggregatorResults = resultsForAmount.filter((r) => r.protocol === aggregatorName);

        // Count successful quotes (status 200 with output > 0)
        const successfulQuotes = aggregatorResults.filter((r) => {
          const output = BigInt(r.output || "0");
          return output > 0n && r.status === 200;
        });

        // Count reverted simulations from successful quotes
        const revertedSimulations = successfulQuotes.filter((r) => r.simulationStatus === "reverted");

        const revertedCount = revertedSimulations.length;
        const successQuotesCount = successfulQuotes.length;
        const revertPercentage = successQuotesCount > 0 ? (revertedCount / successQuotesCount) * 100 : 0;

        return {
          aggregatorName,
          revertedCount,
          successQuotesCount,
          revertPercentage,
        };
      });

      // Sort by revert percentage (ascending - lower is better)
      const sortedByRevert = revertStatsByAgg.sort((a, b) => a.revertPercentage - b.revertPercentage);

      for (const stat of sortedByRevert) {
        if (stat.successQuotesCount > 0) {
          lines.push(
            `    ${stat.aggregatorName.padEnd(23)}: ${stat.revertPercentage.toFixed(2).padStart(6)}%  (${stat.revertedCount}/${stat.successQuotesCount} reverted)`,
          );
        } else {
          lines.push(`    ${stat.aggregatorName.padEnd(23)}: ${"N/A".padStart(6)}   (no successful quotes)`);
        }
      }

      lines.push("");
    }

    // 3. Best Net Amount Percentage (only if net amounts are available)
    const hasNetAmounts = results.some((r) => r.netAmount && r.netAmount !== "0");

    if (hasNetAmounts) {
      // Group by route and find best net amount for each
      const netAmountRouteGroups = new Map<string, TestResult[]>();
      const resultsWithNetAmounts = results.filter((r) => r.netAmount && r.netAmount !== "0");

      for (const result of resultsWithNetAmounts) {
        const netRouteKey = `${result.tokenFromSymbol}-${result.tokenToSymbol}-${result.amount}`;
        if (!netAmountRouteGroups.has(netRouteKey)) {
          netAmountRouteGroups.set(netRouteKey, []);
        }
        netAmountRouteGroups.get(netRouteKey)!.push(result);
      }

      // For each route, find the best net amount
      for (const [, routeResults] of netAmountRouteGroups.entries()) {
        const maxNetAmount = routeResults.reduce((max, r) => {
          const netAmount = BigInt(r.netAmount || "0");
          return netAmount > max ? netAmount : max;
        }, 0n);

        // Mark the best net amount for each result
        for (const result of routeResults) {
          const netAmount = BigInt(result.netAmount || "0");
          (result as any).bestNetAmount = netAmount === maxNetAmount && maxNetAmount > 0n;
        }
      }

      // Count how many times each aggregator had the best net amount
      // Use total number of unique route groups (samples)
      const totalNetRoutes = netAmountRouteGroups.size;
      const netAmountStats = aggregators.map((aggregatorName) => {
        const aggregatorNetResults = resultsWithNetAmounts.filter((r) => r.protocol === aggregatorName);
        const bestNetCount = aggregatorNetResults.filter((r) => (r as any).bestNetAmount === true).length;
        const bestNetPercentage = totalNetRoutes > 0 ? (bestNetCount / totalNetRoutes) * 100 : 0; // percentage of routes with the best net amount

        return {
          aggregatorName,
          bestNetCount,
          bestNetPercentage,
        };
      });

      const sortedByBestNet = [...netAmountStats].sort((a, b) => b.bestNetPercentage - a.bestNetPercentage);
      lines.push("BEST NET AMOUNT PERCENTAGE (after gas costs - by aggregator):");
      lines.push("-".repeat(80));
      for (const stat of sortedByBestNet) {
        lines.push(
          `  ${stat.aggregatorName.padEnd(25)}: ${stat.bestNetPercentage.toFixed(2).padStart(6)}%  (${stat.bestNetCount}/${totalNetRoutes} routes)`,
        );
      }

      lines.push("");
    }

    // 4. Average Quote vs Simulation Difference
    const sortedByAvgDiff = [...stats].sort((a, b) => Math.abs(a.avgDifference) - Math.abs(b.avgDifference));
    lines.push("AVERAGE QUOTE VS SIMULATION DIFFERENCE (for successful simulations):");
    lines.push("-".repeat(80));
    for (const stat of sortedByAvgDiff) {
      if (stat.successfulSimulations.length > 0) {
        const sign = stat.avgDifference >= 0 ? "+" : "";
        lines.push(`  ${stat.aggregatorName.padEnd(25)}: ${(sign + stat.avgDifference.toFixed(2)).padStart(8)}%`);
      } else {
        lines.push(`  ${stat.aggregatorName.padEnd(25)}: ${"N/A".padStart(8)}   (no successful simulations)`);
      }
    }

    lines.push("");

    // 3. Average Gas Usage by Aggregator and Trade Size
    lines.push("AVERAGE GAS USAGE BY TRADE SIZE:");
    lines.push("-".repeat(80));

    for (const amount of tradeAmounts) {
      const resultsForAmount = results.filter((r) => parseFloat(r.amount) === amount && r.gasUsed);

      if (resultsForAmount.length === 0) continue;

      lines.push(`  Trade Size: $${amount}`);

      const gasStatsByAgg = aggregators.map((aggregatorName) => {
        const aggregatorResults = resultsForAmount.filter((r) => r.protocol === aggregatorName && r.gasUsed);

        if (aggregatorResults.length === 0) {
          return {
            aggregatorName,
            avgGas: 0,
            count: 0,
          };
        }

        const totalGas = aggregatorResults.reduce((sum, r) => sum + BigInt(r.gasUsed || "0"), 0n);
        const avgGas = Number(totalGas) / aggregatorResults.length;

        return {
          aggregatorName,
          avgGas,
          count: aggregatorResults.length,
        };
      });

      // Sort by average gas (ascending - lower is better)
      const sortedByGas = gasStatsByAgg.sort((a, b) => a.avgGas - b.avgGas);

      for (const stat of sortedByGas) {
        if (stat.count > 0) {
          lines.push(
            `    ${stat.aggregatorName.padEnd(23)}: ${stat.avgGas.toFixed(0).padStart(10)} gas (${stat.count} simulations)`,
          );
        } else {
          lines.push(`    ${stat.aggregatorName.padEnd(23)}: ${"N/A".padStart(10)}      (no simulations)`);
        }
      }

      lines.push("");
    }

    // 4. Best Simulation Output Percentage
    // First, we need to calculate which aggregator had the best simulation output for each route
    const resultsWithSimulation = results.filter((r) => r.simulationStatus === "success");

    if (resultsWithSimulation.length > 0) {
      // Group by pair and amount to find best simulation output for each route
      const routeGroups = new Map<string, TestResult[]>();
      for (const result of resultsWithSimulation) {
        const routeKey = `${result.tokenFromSymbol}-${result.tokenToSymbol}-${result.amount}`;
        if (!routeGroups.has(routeKey)) {
          routeGroups.set(routeKey, []);
        }
        routeGroups.get(routeKey)!.push(result);
      }

      // For each route, find the best simulation output
      for (const [, routeResults] of routeGroups.entries()) {
        const maxSimOutput = routeResults.reduce((max, r) => {
          const simOutput = BigInt(r.simulationOutput || "0");
          return simOutput > max ? simOutput : max;
        }, 0n);

        // Mark the best simulation output for each result
        for (const result of routeResults) {
          const simOutput = BigInt(result.simulationOutput || "0");
          (result as any).simulationOutputResult = simOutput === maxSimOutput && maxSimOutput > 0n ? "best" : "";
        }
      }

      // Count how many times each aggregator had the best simulation output
      // Use total number of unique route groups (samples)
      const totalSimRoutes = routeGroups.size;
      const simStats = aggregators.map((aggregatorName) => {
        const aggregatorSimResults = resultsWithSimulation.filter((r) => r.protocol === aggregatorName);
        const bestSimCount = aggregatorSimResults.filter((r) => (r as any).simulationOutputResult === "best").length;
        const bestSimPercentage = totalSimRoutes > 0 ? (bestSimCount / totalSimRoutes) * 100 : 0;

        return {
          aggregatorName,
          bestSimCount,
          bestSimPercentage,
        };
      });

      const sortedByBestSim = [...simStats].sort((a, b) => b.bestSimPercentage - a.bestSimPercentage);
      lines.push("BEST SIMULATION OUTPUT PERCENTAGE (by aggregator):");
      lines.push("-".repeat(80));
      for (const stat of sortedByBestSim) {
        lines.push(
          `  ${stat.aggregatorName.padEnd(25)}: ${stat.bestSimPercentage.toFixed(2).padStart(6)}%  (${stat.bestSimCount}/${totalSimRoutes} routes)`,
        );
      }
    } else {
      lines.push("BEST SIMULATION OUTPUT PERCENTAGE:");
      lines.push("-".repeat(80));
      lines.push("  No successful simulations to compare");
    }
  }

  // PAIRWISE COMPARISON (One-on-One)
  lines.push("");
  lines.push("=".repeat(80));
  lines.push("PAIRWISE COMPARISON (One-on-One)");
  lines.push("=".repeat(80));
  lines.push("");

  // For each aggregator, compare it against every other aggregator
  for (const aggregatorA of aggregators) {
    lines.push(`${aggregatorA}:`);

    for (const aggregatorB of aggregators) {
      if (aggregatorA === aggregatorB) continue;

      // Find all tests where both aggregators provided results
      // Group by route (pair + amount) to compare them head-to-head
      const routeComparisons = new Map<string, { aResult: TestResult; bResult: TestResult }>();

      for (const resultA of results.filter((r) => r.protocol === aggregatorA)) {
        const routeKey = `${resultA.tokenFromSymbol}-${resultA.tokenToSymbol}-${resultA.amount}`;

        // Find corresponding result for aggregatorB
        const resultB = results.find(
          (r) =>
            r.protocol === aggregatorB &&
            r.tokenFromSymbol === resultA.tokenFromSymbol &&
            r.tokenToSymbol === resultA.tokenToSymbol &&
            r.amount === resultA.amount,
        );

        if (resultB) {
          routeComparisons.set(routeKey, { aResult: resultA, bResult: resultB });
        }
      }

      // Count wins for aggregatorA (where A has better output than B)
      let wins = 0;
      let totalComparisons = 0;

      for (const { aResult, bResult } of routeComparisons.values()) {
        const outputA = BigInt(aResult.output || "0");
        const outputB = BigInt(bResult.output || "0");

        // Only count comparisons where both have valid outputs
        if (outputA > 0n || outputB > 0n) {
          totalComparisons++;
          if (outputA > outputB) {
            wins++;
          }
        }
      }

      const winPercentage = totalComparisons > 0 ? (wins / totalComparisons) * 100 : 0;

      lines.push(
        `  vs ${aggregatorB.padEnd(20)}: ${winPercentage.toFixed(1).padStart(5)}% wins  (${wins}/${totalComparisons} comparisons)`,
      );
    }

    lines.push("");
  }

  lines.push("");
  lines.push("=".repeat(80) + "\n");

  // Join all lines and output to console
  const report = lines.join("\n");
  console.log(report);

  return report;
}

// Main comparison function
async function runComparison(): Promise<void> {
  // If no command-line aggregators were specified, show interactive selection
  let aggregatorsToUse = AGGREGATORS;
  if (!selectedAggregatorNames || selectedAggregatorNames.length === 0) {
    aggregatorsToUse = await selectAggregatorsInteractively();
  }

  // Convert AggregatorConfig to BaseAggregator instances
  const aggregatorInstances = aggregatorsToUse.map((config) => createAggregator(config.name, config.baseUrl));

  console.log(`Aggregator Comparison Script - Simulation ${SIMULATION ? "ENABLED" : "DISABLED"}`);
  console.log(
    `Comparing ${aggregatorInstances.length} aggregators: ${aggregatorInstances.map((a) => a.name).join(", ")}\n`,
  );

  // Fetch token data from onchain before starting comparison
  await loadTokensFromOnchain();

  // Fetch MON prices for all tokens
  await fetchPricesForAllTokens();

  let pairs: TokenPair[];
  let testAmounts: number[];
  let pairsToAmounts: Map<TokenPair, number[]> = new Map();

  if (randomSampleCount > 0) {
    // Use random sampling
    console.log(`Generating ${randomSampleCount} random samples...`);
    const randomSamples = generateRandomSamples(randomSampleCount);

    // Create a map of pair to amounts for random sampling
    // Each pair gets its corresponding random amount
    for (let i = 0; i < randomSamples.pairs.length; i++) {
      const pair = randomSamples.pairs[i];
      const amount = randomSamples.amounts[i];

      // Find if we already have this pair
      let existingPair: TokenPair | undefined;
      for (const [p] of pairsToAmounts.entries()) {
        if (p.tokenIn === pair.tokenIn && p.tokenOut === pair.tokenOut) {
          existingPair = p;
          break;
        }
      }

      if (existingPair) {
        pairsToAmounts.get(existingPair)!.push(amount);
      } else {
        pairsToAmounts.set(pair, [amount]);
      }
    }

    pairs = Array.from(pairsToAmounts.keys());
    console.log(`Generated ${randomSampleCount} random samples covering ${pairs.length} unique pairs`);
    console.log("Random samples:");
    let sampleIndex = 0;
    for (const [pair, amounts] of pairsToAmounts.entries()) {
      for (const amount of amounts) {
        sampleIndex++;
        console.log(
          `  Sample ${sampleIndex}: ${pair.tokenIn.slice(0, 8)}... -> ${pair.tokenOut.slice(0, 8)}... with amount $${amount}`,
        );
      }
    }
    console.log();
  } else {
    // Use all pairs and amounts
    console.log("Using hardcoded token pairs...");
    pairs = HARDCODED_PAIRS;
    testAmounts = TEST_AMOUNTS;

    // Create the map for normal mode (all pairs with all amounts)
    for (const pair of pairs) {
      pairsToAmounts.set(pair, testAmounts);
    }

    if (pairs.length === 0) {
      console.log("No pairs configured.");
      return;
    }

    console.log(`Found ${pairs.length} unique token pairs`);
  }

  console.log("Starting comparison...\n");

  const allResults: TestResult[] = [];

  // Calculate total number of samples (pair-amount combinations)
  let totalSamples = 0;
  for (const amounts of pairsToAmounts.values()) {
    totalSamples += amounts.length;
  }

  let currentSampleIndex = 0;
  const testingStartTime = Date.now();

  for (const [pair, amounts] of pairsToAmounts.entries()) {
    // Fetch symbols once for logging (will be cached in pair object)
    const tokenFromSymbol = await getTokenSymbol(pair.tokenIn as Address);
    const tokenToSymbol = await getTokenSymbol(pair.tokenOut as Address);
    pair.tokenFromSymbol = tokenFromSymbol;
    pair.tokenToSymbol = tokenToSymbol;

    // Create test client only if needed for simulation
    const client = SIMULATION ? await getTestClient() : null;

    for (const usdAmount of amounts) {
      currentSampleIndex++;

      // Calculate ETA
      const elapsedTime = Date.now() - testingStartTime;
      const averageTimePerSample = elapsedTime / (currentSampleIndex - 1 || 1);
      const samplesRemaining = totalSamples - currentSampleIndex + 1;
      const estimatedTimeRemaining = averageTimePerSample * samplesRemaining;

      // Format ETA as HH:MM:SS
      const formatTime = (ms: number): string => {
        const seconds = Math.floor(ms / 1000);
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
      };

      const etaString = currentSampleIndex === 1 ? "Calculating..." : formatTime(estimatedTimeRemaining);

      console.log(
        `Testing ${tokenFromSymbol} -> ${tokenToSymbol} ${currentSampleIndex}/${totalSamples} | ETA: ${etaString}`,
      );
      console.log(`  USD Amount: $${usdAmount}`);

      // Step 1: Fetch quotes from all aggregators in parallel
      console.log(`  Fetching quotes from all aggregators...`);
      const quoteResults = await Promise.all(
        aggregatorInstances.map(async (aggregator) => {
          console.log(`    Fetching quote from ${aggregator.name}...`);
          return await fetchQuote(aggregator, pair, usdAmount);
        }),
      );

      // Step 2: If simulation is enabled, run simulations sequentially
      const results: TestResult[] = [];

      if (SIMULATION && client) {
        console.log(`  Running simulations sequentially...`);

        for (const quoteResult of quoteResults) {
          console.log(`    Simulating ${quoteResult.protocol}...`);

          // Fork to the specific block for accurate simulation
          if (quoteResult.blockNumber) {
            await forkToBlock(client, BigInt(quoteResult.blockNumber));
          }

          // Wait 1 second between simulations to prevent timeouts
          await sleep(1000);

          // Run simulation if we have transaction data
          let simulationResult: SimulationResult = {
            status: "skipped",
            amountOut: "0",
            error: "Simulation skipped",
          };

          if (quoteResult.status === 200 && quoteResult.txData) {
            try {
              const swapData: SwapTransaction = {
                to: quoteResult.txData.to,
                data: quoteResult.txData.data,
                value: quoteResult.txData.value,
              };

              // Simulate the swap with overall retry wrapper for timeout recovery
              simulationResult = await retryWithBackoff(
                async () => {
                  try {
                    return await simulateTransaction(
                      client,
                      pair.tokenIn as Address,
                      pair.tokenOut as Address,
                      BigInt(quoteResult.amountIn || "0"),
                      swapData,
                    );
                  } catch (error: any) {
                    // Only retry on timeout errors at this level
                    if (error.message?.includes("timeout") || error.message?.includes("timed out")) {
                      console.log("       Simulation timeout, will retry entire operation...");
                      // Reset the fork before retry
                      if (quoteResult.blockNumber) {
                        await forkToBlock(client, BigInt(quoteResult.blockNumber));
                      }
                      throw error;
                    }
                    // Don't retry other errors
                    throw error;
                  }
                },
                {
                  maxAttempts: 3,
                  initialDelay: 5000,
                  maxDelay: 30000,
                  onRetry: (attempt, error) => {
                    console.log(`       Retry attempt ${attempt}/3 for simulation:`, error.message);
                  },
                },
              );
            } catch (simError: any) {
              console.error(`      Simulation error after retries:`, simError.message);
              simulationResult = {
                status: "error",
                amountOut: "0",
                error: simError.message,
              };
            }
          } else if (!quoteResult.txData) {
            simulationResult = {
              status: "error",
              amountOut: "0",
              error: "No transaction data",
            };
          }

          // Calculate net amount if we have gas usage
          let gasCostInTokenOut = "0";
          let netAmount = simulationResult.amountOut;

          if (simulationResult.gasUsed) {
            const tokenOutDecimals = await getTokenDecimals(pair.tokenOut as Address);
            gasCostInTokenOut = calculateGasCostInTokenOut(simulationResult.gasUsed, pair.tokenOut, tokenOutDecimals);

            netAmount = calculateNetAmount(simulationResult.amountOut, gasCostInTokenOut);
          }

          // Update result with simulation data
          const finalResult: TestResult = {
            ...quoteResult,
            simulationStatus: simulationResult.status,
            simulationOutput: simulationResult.amountOut,
            simulationError: simulationResult.error,
            gasUsed: simulationResult.gasUsed,
            gasCostInTokenOut: gasCostInTokenOut,
            netAmount: netAmount,
            fullData: (quoteResult as any).fullData,
          };

          // Remove extra fields that aren't part of TestResult
          delete (finalResult as any).txData;
          delete (finalResult as any).amountIn;

          results.push(finalResult);
        }
      } else {
        // No simulation, just use quote results with simulation status set
        for (const quoteResult of quoteResults) {
          const finalResult: TestResult = {
            ...quoteResult,
            simulationStatus: "skipped",
            simulationOutput: "0",
            simulationError: "Simulation disabled",
            fullData: (quoteResult as any).fullData,
          };

          // Remove extra fields that aren't part of TestResult
          delete (finalResult as any).txData;
          delete (finalResult as any).amountIn;

          results.push(finalResult);
        }
      }

      // Wait 1 second before continuing
      console.log(`  Waiting 1 second...`);
      await sleep(1000);

      // Compare all results
      compareResults(results);

      // Add to all results
      allResults.push(...results);

      // Log results
      console.log(`  Results:`);
      for (const result of results) {
        console.log(
          `    ${result.protocol}: Output: ${result.output} | Net Output: ${result.netAmount} | Duration: ${result.duration}ms | Block: ${result.blockNumber || "N/A"} | Simulation: ${result.simulationStatus} | Output: ${result.outputResult} | Duration: ${result.durationResult}`,
        );
      }
      console.log(`--------------------------------`);
      console.log(``);
    }

    console.log("");
  }

  // Write results to CSV
  console.log("Writing results to CSV...");

  // Create output directory if it doesn't exist
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Generate timestamped filename
  const outputFilePath = generateOutputFilename(OUTPUT_DIR);

  // Add simulationOutputTokenOutDecimals, outputTokenOutDecimals, and netAmountTokenOutDecimals to each result
  const resultsWithDecimals = await Promise.all(
    allResults.map(async (result) => {
      const tokenOutDecimals = await getTokenDecimals(result.tokenOut as Address);
      const simulationOutputTokenOutDecimals = formatUnits(BigInt(result.simulationOutput || "0"), tokenOutDecimals);
      const outputTokenOutDecimals = formatUnits(BigInt(result.output || "0"), tokenOutDecimals);
      const netAmountTokenOutDecimals = formatUnits(BigInt(result.netAmount || "0"), tokenOutDecimals);

      return {
        ...result,
        outputTokenOutDecimals,
        simulationOutputTokenOutDecimals,
        netAmountTokenOutDecimals,
      };
    }),
  );

  const csv = stringify(resultsWithDecimals, {
    header: true,
    columns: [
      "time",
      "timestamp",
      "protocol",
      "tokenFromSymbol",
      "tokenToSymbol",
      "tokenIn",
      "tokenOut",
      "amount",
      "amountInTokenIn",
      "output",
      "outputTokenOutDecimals",
      "duration",
      "status",
      "url",
      "routes",
      "durationResult",
      "outputResult",
      "outputAdj",
      "blockNumber",
      "quoteError",
      "simulationStatus",
      "simulationOutput",
      "simulationOutputTokenOutDecimals",
      "simulationError",
      "gasUsed",
      "gasCostInTokenOut",
      "netAmount",
      "netAmountTokenOutDecimals",
    ],
  });

  await writeFile(outputFilePath, csv);
  console.log(`Results written to ${outputFilePath}`);
  console.log(`Total tests: ${allResults.length}`);

  // Generate and display summary report
  const summaryReport = generateSummaryReport(allResults, randomSampleCount);

  // Write summary report to .txt file
  const summaryFilePath = outputFilePath.replace(/\.csv$/, ".txt");
  await writeFile(summaryFilePath, summaryReport);
  console.log(`Summary report written to ${summaryFilePath}`);

  // Write better quotes comparison
  await writeBetterQuotesComparison(allResults, aggregatorInstances, OUTPUT_DIR, outputFilePath);
}

// Run the comparison with error recovery and graceful shutdown
async function main() {
  // Setup graceful shutdown
  setupGracefulShutdown(async () => {
    console.log("Cleaning up resources...");
    // Add any cleanup logic here if needed
    if (testClient) {
      console.log("Closing test client connection...");
      // Client cleanup if needed
    }
  });

  try {
    await runComparison();
    process.exit(0);
  } catch (error: any) {
    console.error("Fatal error:", error.message);
    if (error.stack) {
      console.error("Stack trace:", error.stack);
    }
    process.exit(1);
  }
}

// Start the application
main();