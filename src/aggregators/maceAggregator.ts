import type { QuoteRequest } from "../types";
import { zeroAddress } from "viem";
import { BaseAggregator, type AggregatorOutput, type FetchOptions } from "./baseAggregator";

export class MaceAggregator extends BaseAggregator {
  constructor(name: string, baseUrl: string) {
    super(name, baseUrl);

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
    };

    // Mace uses "native" for native tokens, otherwise the token address
    const isNativeIn =
      request.tokenIn === zeroAddress || request.tokenIn === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const isNativeOut =
      request.tokenOut === zeroAddress || request.tokenOut === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

    const tokenInMace = isNativeIn ? "native" : request.tokenIn;
    const tokenOutMace = isNativeOut ? "native" : request.tokenOut;

    fetchOptions.body = JSON.stringify({
      from: process.env.DEFAULT_SENDER_ACCOUNT || "", // Caller address (required by API)
      in: [
        {
          token: tokenInMace,
          amount: request.amountIn,
        },
      ],
      out: [
        {
          token: tokenOutMace,
          minAmount: "0",
          slippageToleranceBps: Math.floor((request.slippage || 0.005) * 10000), // Convert to basis points
        },
      ],
    });
  }

  getOutput(data: any): AggregatorOutput {
    // Mace format: routes[0].expectedOut[0].amount (hex format)
    const hexAmount = data.routes?.[0]?.expectedOut?.[0]?.amount || "0x0";
    const outputAmount = BigInt(hexAmount).toString(); // Convert hex to decimal

    // Count the number of adapter hops across all routes
    const routesCount =
      data.routes?.[0]?.routes?.reduce((total: number, route: any) => {
        return total + (route.adapterHops?.length || 0);
      }, 0) || 0;

    return {
      outputAmount,
      txData: null, // Transaction data structure TBD
      routesCount,
      fullData: data,
    };
  }

  isSimulationSupported(): boolean {
    return false; // Mace does not provide transaction data for simulation
  }

  isBaseCompareAggregator(): boolean {
    return false; // Not the base aggregator for comparisons
  }
}
