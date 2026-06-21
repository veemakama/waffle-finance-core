import { z } from "zod";
import type { Chain, Direction } from "../persistence/orders-repo.js";

/**
 * Centralised validation for order announcements.
 *
 * The schema validates BOTH field shapes and cross-field relationships
 * (direction <-> chains, and address format <-> chain) so that malformed
 * payloads are rejected at parse time with a structured ZodError, rather
 * than reaching the service layer and surfacing as an ad-hoc error later.
 */

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;
// Base-58 Solana pubkey: 32–44 alphanumeric chars excluding 0, O, I, l
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The src/dst chains each supported swap direction must use. Keep this map
 * in sync whenever a new direction is added — it is the single source of
 * truth for direction/chain alignment.
 */
export const DIRECTION_CHAINS: Record<Direction, { src: Chain; dst: Chain }> = {
  eth_to_xlm: { src: "ethereum", dst: "stellar" },
  xlm_to_eth: { src: "stellar", dst: "ethereum" },
  eth_to_sol: { src: "ethereum", dst: "solana" },
  sol_to_eth: { src: "solana", dst: "ethereum" }
};

/** Returns an error message if `addr` is not well-formed for `chain`, else null. */
function addressError(chain: Chain, addr: string): string | null {
  if (chain === "ethereum") {
    if (!HEX_ADDRESS.test(addr)) return `${addr} is not a valid Ethereum address`;
    if (addr.toLowerCase() === ZERO_ADDRESS) return "Zero address is not a valid Ethereum address";
    return null;
  }
  if (chain === "stellar") {
    return STELLAR_ADDRESS.test(addr) ? null : `${addr} is not a valid Stellar account`;
  }
  if (chain === "solana") {
    return SOLANA_ADDRESS.test(addr) ? null : `${addr} is not a valid Solana address`;
  }
  return null;
}

const announceShape = z.object({
  direction: z.enum(["eth_to_xlm", "xlm_to_eth", "eth_to_sol", "sol_to_eth"]),
  hashlock: z.string().regex(HEX32, "hashlock must be 0x + 64 hex chars"),
  srcChain: z.enum(["ethereum", "stellar", "solana"]),
  srcAddress: z.string(),
  srcAsset: z.string().min(1),
  srcAmount: z.string().regex(/^\d+$/, "srcAmount must be a decimal integer string"),
  srcSafetyDeposit: z.string().regex(/^\d+$/, "srcSafetyDeposit must be a decimal integer string"),
  dstChain: z.enum(["ethereum", "stellar", "solana"]),
  dstAddress: z.string(),
  dstAsset: z.string().min(1),
  dstAmount: z.string().regex(/^\d+$/, "dstAmount must be a decimal integer string")
});

export const announceSchema = announceShape.superRefine((input, ctx) => {
  // 1) The declared direction must line up with the src/dst chains.
  const want = DIRECTION_CHAINS[input.direction];
  if (input.srcChain !== want.src) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["srcChain"],
      message: `Direction ${input.direction} requires srcChain=${want.src} (got ${input.srcChain})`
    });
  }
  if (input.dstChain !== want.dst) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dstChain"],
      message: `Direction ${input.direction} requires dstChain=${want.dst} (got ${input.dstChain})`
    });
  }

  // 2) Each address must be well-formed for the chain it belongs to.
  const srcErr = addressError(input.srcChain, input.srcAddress);
  if (srcErr) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["srcAddress"], message: srcErr });
  }
  const dstErr = addressError(input.dstChain, input.dstAddress);
  if (dstErr) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dstAddress"], message: dstErr });
  }
});

export type AnnounceInput = z.infer<typeof announceSchema>;
