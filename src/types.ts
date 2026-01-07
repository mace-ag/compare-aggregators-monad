export interface TokenPair {
  tokenFromSymbol?: string;
  tokenToSymbol?: string;
  tokenIn: string;
  tokenOut: string;
}

export interface AggregatorConfig {
  name: string;
  baseUrl: string;
}

export interface QuoteRequest {
  chain: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  includePoolInfo?: boolean;
  slippage?: number;
}

export interface QuoteResponse {
  outputAmount: string;
  routes?: any[];
  [key: string]: any;
}

export interface TestResult {
  time: string;
  timestamp: number;
  protocol: string;
  tokenFromSymbol: string;
  tokenToSymbol: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountInTokenIn: string; // Amount in Wei (smallest unit)
  output: string;
  outputTokenOutDecimals?: string; // Formatted quote output with proper decimals
  duration: number;
  status: number;
  url: string;
  routes: number;
  durationResult: string;
  outputResult: string;
  outputAdj: string;
  blockNumber?: string;
  quoteError?: string; // Non-simulation quote error info (HTTP error body, parse issues, etc.)
  simulationStatus: string;
  simulationOutput: string;
  simulationOutputTokenOutDecimals?: string; // Formatted simulation output amount with proper decimals
  simulationError?: string;
  gasUsed?: string;
  netAmount?: string; // Net amount after gas costs (in tokenOut)
  netAmountTokenOutDecimals?: string; // Formatted net amount with proper decimals
  gasCostInTokenOut?: string; // Gas cost converted to tokenOut
  fullData?: any; // Full response data from the aggregator
}

export interface ComparisonResult {
  prodResult: TestResult;
  stageResult: TestResult;
}

export interface SimulationResult {
  status: "success" | "reverted" | "error" | "skipped";
  amountOut: string;
  error?: string;
  gasUsed?: string;
}

export interface SwapTransaction {
  to: string;
  data: string;
  value?: string;
}
