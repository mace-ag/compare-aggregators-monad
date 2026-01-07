import type { QuoteRequest } from "../types";
import { getAmountInTokenDecimals } from "../utils";
import { BaseAggregator, type AggregatorOutput, type FetchOptions } from "./baseAggregator";

export class OpenOceanAggregator extends BaseAggregator {
  constructor(name: string, baseUrl: string) {
    super(name, baseUrl);
  }

  buildQuoteUrl(request: QuoteRequest): string {
    const gasPrice = process.env.DEFAULT_GAS_PRICE || "1000000000"; // 1 gwei fallback
    if (!process.env.DEFAULT_GAS_PRICE) {
      // Don't hard-fail; OpenOcean requires a gasPrice param but it can be a reasonable default.
      console.warn(`[openocean] DEFAULT_GAS_PRICE not set; using fallback gasPrice=${gasPrice}`);
    }
    const params = new URLSearchParams({
      quoteType: "swap",
      inTokenAddress: request.tokenIn,
      outTokenAddress: request.tokenOut,
      amount: getAmountInTokenDecimals(request.amountIn, request.tokenInDecimals),
      gasPrice: gasPrice,
      slippage: ((request.slippage || 0.005) * 100).toString(), // Convert to percentage (1 = 1%)
      account: process.env.DEFAULT_SENDER_ACCOUNT || "",
    });
    return `${this.baseUrl}?${params.toString()}`;
  }

  addRequestData(_request: QuoteRequest, _fetchOptions: FetchOptions): void {
    // OpenOcean uses GET method, no additional options needed
  }

  getOutput(data: any): AggregatorOutput {
    // OpenOcean format: data.data contains both output and transaction info
    return {
      outputAmount: data.data?.outAmount || "0",
      txData: data.data
        ? {
            to: data.data.to,
            data: data.data.data,
            value: data.data.value,
          }
        : null, // The data object itself contains to, data, value
      routesCount: 0, // OpenOcean doesn't expose route count in the same way
      fullData: data,
    };
  }

  isSimulationSupported(): boolean {
    return true; // OpenOcean provides transaction data for simulation
  }

  isBaseCompareAggregator(): boolean {
    return false; // Not the base aggregator for comparisons
  }
}
