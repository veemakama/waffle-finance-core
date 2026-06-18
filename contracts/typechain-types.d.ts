/**
 * Shim for `../typechain-types` imports in test files.
 *
 * When `tsc --noEmit` resolves `../typechain-types` from contracts/test/,
 * it finds this file before the typechain-types/ directory because TypeScript
 * checks `typechain-types.d.ts` before `typechain-types/index.ts`.
 *
 * This satisfies the type checker without pulling in the generated .ts source
 * files (which need the full hardhat/ts-node runtime).
 *
 * The Hardhat runner resolves the actual implementation from typechain-types/
 * and ignores this file at runtime.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ResolverRegistry   = any;
export type TestERC20          = any;
export type HTLCEscrow         = any;
export type HTLCReceiverMock   = any;
export type NoFallbackReceiver = any;
export type IHTLCEscrow        = any;
export type IResolverRegistry  = any;
