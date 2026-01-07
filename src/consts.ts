// Test amounts in USD
export const TEST_AMOUNTS = [
  1, 2.5, 5, 10, 17.5, 25, 37.5, 50, 75, 100, 125, 150, 175, 200, 250, 375, 500, 750, 1000, 1750, 2500, 5000, 10000,
  25000, 50000, 100000, 250000, 500000,
];

// Native token addresses (these represent ETH/native currency)
export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

export const COMMON_SLOTS_FOR_BALANCE_SET = [
  // Most common slots
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  // Less common
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  // Special cases
  51, 52, 101, 102, 103, 104, 105,
  // Edge cases for non-standard tokens
  50, 100, 150, 200, 255,
];
