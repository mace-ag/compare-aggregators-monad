import type { QuoteRequest } from "../types";
import { BaseAggregator, type AggregatorOutput, type FetchOptions } from "./baseAggregator";

export class KuruAggregator extends BaseAggregator {
  constructor(name: string, baseUrl: string) {
    super(name, baseUrl);

    // Kuru Flow API uses a Bearer JWT token (docs: https://docs.kuru.io/api-reference/calculate-best-path-quote)
    // Provide via env: KURU_JWT
    if (!process.env.KURU_JWT) {
      console.error(`Error: KURU_JWT is not set in environment variables.`);
      console.error(`Kuru Flow API requires a Bearer JWT (see Kuru docs).`);
      console.error(`Set KURU_JWT=<token> in your .env file.`);
      process.exit(1);
    }
    if (!process.env.DEFAULT_SENDER_ACCOUNT) {
      console.error(`Error: DEFAULT_SENDER_ACCOUNT is not set in environment variables.`);
      console.error(`This account is required for the ${name} aggregator.`);
      console.error(`Please set DEFAULT_SENDER_ACCOUNT in your .env file.`);
      process.exit(1);
    }
  }

  buildQuoteUrl(_request: QuoteRequest): string {
    return this.baseUrl;
  }

  addRequestData(request: QuoteRequest, fetchOptions: FetchOptions): void {
    fetchOptions.method = "POST";
    fetchOptions.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.KURU_JWT}`,
    };
    fetchOptions.body = JSON.stringify({
      userAddress: process.env.DEFAULT_SENDER_ACCOUNT || "",
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amount: request.amountIn,
      autoSlippage: true,
      slippageTolerance: Math.floor((request.slippage || 0.005) * 10000), // bps (50 = 0.5%)
    });
  }

  getOutput(data: any): AggregatorOutput {
    // Kuru Flow API format
    const outputAmount = data.output || "0";

    // If buildResponse has tx data, try to normalize it.
    const tx = data.buildResponse?.transaction || data.buildResponse?.tx || null;
    const txData = tx?.to && tx?.data ? { to: tx.to, data: tx.data, value: tx.value } : null;

    // Best-effort route count
    const hops = data.path?.hops || data.path?.route?.hops || [];
    const routesCount = Array.isArray(hops) ? hops.length : 0;

    return {
      outputAmount,
      txData,
      routesCount,
      fullData: data,
    };
  }

  isSimulationSupported(): boolean {
    return false; // Kuru tx build response format may vary; disable by default for now
  }

  isBaseCompareAggregator(): boolean {
    return false; // Not the base aggregator for comparisons
  }
}
