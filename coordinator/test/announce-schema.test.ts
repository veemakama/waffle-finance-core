import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  announceSchema,
  DIRECTION_CHAINS,
  type AnnounceInput
} from "../src/validation/announce.js";
import type { Direction } from "../src/persistence/orders-repo.js";

const VALID_HASHLOCK = "0x" + "a".repeat(64);
const ADDR = {
  ethereum: "0x1111111111111111111111111111111111111111",
  stellar: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
  solana: "11111111111111111111111111111111"
} as const;

const ALL_DIRECTIONS = Object.keys(DIRECTION_CHAINS) as Direction[];

function valid(direction: Direction): AnnounceInput {
  const { src, dst } = DIRECTION_CHAINS[direction];
  return {
    direction,
    hashlock: VALID_HASHLOCK,
    srcChain: src,
    srcAddress: ADDR[src],
    srcAsset: "native",
    srcAmount: "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    dstChain: dst,
    dstAddress: ADDR[dst],
    dstAsset: "native",
    dstAmount: "100000000"
  };
}

describe("announceSchema — valid combinations", () => {
  it.each(ALL_DIRECTIONS)("accepts a correct %s announcement", (direction) => {
    const result = announceSchema.safeParse(valid(direction));
    expect(result.success).toBe(true);
  });
});

describe("announceSchema — direction/chain alignment", () => {
  it("rejects eth_to_xlm with srcChain: 'solana'", () => {
    const result = announceSchema.safeParse({
      ...valid("eth_to_xlm"),
      srcChain: "solana",
      srcAddress: ADDR.solana
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "srcChain");
      expect(issue).toBeDefined();
      expect(issue!.message).toContain("srcChain=ethereum");
    }
  });

  it("rejects a mismatched dstChain", () => {
    const result = announceSchema.safeParse({
      ...valid("eth_to_xlm"),
      dstChain: "solana",
      dstAddress: ADDR.solana
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "dstChain")).toBe(true);
    }
  });

  // Every direction must reject every chain pairing that isn't its own.
  it.each(ALL_DIRECTIONS)(
    "rejects %s when paired with another direction's chains",
    (direction) => {
      const wrong = ALL_DIRECTIONS.find(
        (d) =>
          DIRECTION_CHAINS[d].src !== DIRECTION_CHAINS[direction].src ||
          DIRECTION_CHAINS[d].dst !== DIRECTION_CHAINS[direction].dst
      )!;
      const { src, dst } = DIRECTION_CHAINS[wrong];
      const result = announceSchema.safeParse({
        ...valid(direction),
        srcChain: src,
        srcAddress: ADDR[src],
        dstChain: dst,
        dstAddress: ADDR[dst]
      });
      expect(result.success).toBe(false);
    }
  );
});

describe("announceSchema — address format", () => {
  it("rejects an Ethereum src address that is not 0x + 40 hex", () => {
    const result = announceSchema.safeParse({ ...valid("eth_to_xlm"), srcAddress: "0xnothex" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "srcAddress")).toBe(true);
    }
  });

  it("rejects the Ethereum zero address", () => {
    const result = announceSchema.safeParse({
      ...valid("eth_to_xlm"),
      srcAddress: "0x0000000000000000000000000000000000000000"
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "srcAddress");
      expect(issue!.message).toContain("Zero address");
    }
  });

  it("rejects a malformed Stellar destination address", () => {
    const result = announceSchema.safeParse({ ...valid("eth_to_xlm"), dstAddress: "not-stellar" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "dstAddress")).toBe(true);
    }
  });

  it("rejects a malformed Solana destination address", () => {
    const result = announceSchema.safeParse({ ...valid("eth_to_sol"), dstAddress: "0OIl-bad" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "dstAddress")).toBe(true);
    }
  });
});

describe("announceSchema — field shapes", () => {
  it("rejects a hashlock that is not 0x + 64 hex", () => {
    const result = announceSchema.safeParse({ ...valid("eth_to_xlm"), hashlock: "0xabc" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer amount string", () => {
    const result = announceSchema.safeParse({ ...valid("eth_to_xlm"), srcAmount: "1.5" });
    expect(result.success).toBe(false);
  });

  it("reports a structured ZodError (multiple issues at once)", () => {
    expect(() =>
      announceSchema.parse({
        ...valid("eth_to_xlm"),
        srcChain: "solana", // direction mismatch
        srcAddress: "bad" // and a bad address for the declared chain
      })
    ).toThrow(z.ZodError);

    const result = announceSchema.safeParse({
      ...valid("eth_to_xlm"),
      srcChain: "solana",
      srcAddress: "bad"
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("srcChain");
      expect(paths).toContain("srcAddress");
    }
  });
});
