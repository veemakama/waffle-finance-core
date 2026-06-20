import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSecret, hashSecret, verifyPreimage } from "@wafflefinance/sdk/secrets";
import { EvmHtlcSim, SorobanHtlcSim, SolanaHtlcSim, type HtlcSim } from "./sim.js";

const TIMELOCK_SECONDS = 600;
const PAST_TIMELOCK = TIMELOCK_SECONDS + 1;

/**
 * The 12-hour / 24-hour asymmetric timelock convention used by the
 * sol_to_eth route:
 *   - Solana (source leg): 24-hour lock gives the resolver enough time to
 *     set up the destination lock and claim.
 *   - Ethereum (destination leg): 12-hour lock must expire BEFORE the source
 *     leg so the resolver can refund on Ethereum first if needed, then refund
 *     on Solana later.  If this ordering is reversed funds can get stuck.
 */
const SOL_SRC_TIMELOCK_SECONDS  = 24 * 60 * 60; // 24 h
const ETH_DST_TIMELOCK_SECONDS  = 12 * 60 * 60; // 12 h

// Independent oracle: Node's built-in crypto module. If the SDK's sha256
// agrees with this, it also agrees with every other standards-compliant
// sha256 implementation — Solidity's `sha256(...)` precompile, the Solana
// program's `sha2` crate, and Soroban's `env.crypto().sha256(...)` included.
function canonicalSha256(hex: `0x${string}`): `0x${string}` {
  const buf = Buffer.from(hex.slice(2), "hex");
  return `0x${createHash("sha256").update(buf).digest("hex")}` as `0x${string}`;
}

describe("cross-chain HTLC differential harness", () => {
  describe("hash primitive parity", () => {
    it("SDK hashSecret().sha256 matches Node's canonical sha256", () => {
      const s = generateSecret();
      expect(canonicalSha256(s.preimage)).toBe(s.sha256);
    });

    it("hashSecret is deterministic for a given preimage", () => {
      const s = generateSecret();
      expect(hashSecret(s.preimage).sha256).toBe(s.sha256);
      expect(hashSecret(s.preimage).keccak256).toBe(s.keccak256);
    });
  });

  // Shared per-chain scenarios. Driving all three simulators through the same
  // assertions is the actual differential check — if any chain diverges, the
  // corresponding case fails for that chain only.
  describe.each<{ label: string; factory: () => HtlcSim }>([
    { label: "EVM HTLCEscrow",            factory: () => new EvmHtlcSim()     },
    { label: "Soroban wafflefinance-htlc", factory: () => new SorobanHtlcSim() },
    { label: "Solana wafflefinance-htlc",  factory: () => new SolanaHtlcSim()  },
  ])("$label", ({ factory }) => {
    let chain: HtlcSim;
    let secret: ReturnType<typeof generateSecret>;
    let orderId: bigint;

    beforeEach(() => {
      chain = factory();
      secret = generateSecret();
      orderId = chain.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: TIMELOCK_SECONDS
      });
    });

    it("accepts the valid preimage and marks the order Claimed", () => {
      expect(() => chain.claimOrder(orderId, secret.preimage)).not.toThrow();
      expect(chain.getOrder(orderId).status).toBe("Claimed");
    });

    it("rejects an unrelated preimage with InvalidPreimage", () => {
      const other = generateSecret();
      expect(() => chain.claimOrder(orderId, other.preimage)).toThrow(/InvalidPreimage/);
      expect(chain.getOrder(orderId).status).toBe("Funded");
    });

    it("rejects refund while the order is still inside the timelock", () => {
      expect(() => chain.refundOrder(orderId)).toThrow(/NotExpired/);
      expect(chain.getOrder(orderId).status).toBe("Funded");
    });

    it("permits refund once the timelock has expired", () => {
      chain.advanceTime(PAST_TIMELOCK);
      expect(() => chain.refundOrder(orderId)).not.toThrow();
      expect(chain.getOrder(orderId).status).toBe("Refunded");
    });

    it("rejects claim once the timelock has expired", () => {
      chain.advanceTime(PAST_TIMELOCK);
      expect(() => chain.claimOrder(orderId, secret.preimage)).toThrow(/Expired/);
    });

    it("rejects a second claim against an already-claimed order", () => {
      chain.claimOrder(orderId, secret.preimage);
      expect(() => chain.claimOrder(orderId, secret.preimage)).toThrow(/OrderNotClaimable/);
    });
  });

  // ── Existing cross-chain round-trip: EVM ↔ Soroban ────────────────────────

  describe("cross-chain round-trip (eth ↔ stellar)", () => {
    it("one sha256 hashlock unlocks BOTH chains with the same preimage", () => {
      const secret = generateSecret();
      const evm = new EvmHtlcSim();
      const soroban = new SorobanHtlcSim();

      const evmId = evm.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      const sorobanId = soroban.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });

      evm.claimOrder(evmId, secret.preimage);
      soroban.claimOrder(sorobanId, secret.preimage);

      expect(evm.getOrder(evmId).status).toBe("Claimed");
      expect(soroban.getOrder(sorobanId).status).toBe("Claimed");
      expect(verifyPreimage(secret.preimage, secret.sha256)).toBe("sha256");
    });

    it("a keccak256-only hashlock works on EVM but is rejected by Soroban", () => {
      // This asymmetry is intentional: HTLCEscrow.sol accepts either
      // digest so it can interop with classic EVM tooling; the Soroban
      // contract is sha256-only. Cross-chain swaps therefore MUST use
      // the sha256 digest end-to-end.
      const secret = generateSecret();
      const evm = new EvmHtlcSim();
      const soroban = new SorobanHtlcSim();

      const evmId = evm.createOrder({ hashlock: secret.keccak256, timelockSeconds: TIMELOCK_SECONDS });
      const sorobanId = soroban.createOrder({ hashlock: secret.keccak256, timelockSeconds: TIMELOCK_SECONDS });

      expect(() => evm.claimOrder(evmId, secret.preimage)).not.toThrow();
      expect(() => soroban.claimOrder(sorobanId, secret.preimage)).toThrow(/InvalidPreimage/);
    });
  });

  // ── sol_to_eth route scenarios ────────────────────────────────────────────

  describe("sol_to_eth route", () => {
    // Happy path: user locks SOL on Solana, resolver locks ETH on Ethereum,
    // user claims ETH by revealing the preimage on-chain, resolver observes
    // the revealed preimage and claims SOL.
    it("happy path: sha256 hashlock unlocks both Solana and Ethereum legs", () => {
      const secret = generateSecret();
      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      // User creates the source lock on Solana with a 24-hour timelock.
      const solanaId = solana.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: SOL_SRC_TIMELOCK_SECONDS,
      });

      // Resolver creates the destination lock on Ethereum with a 12-hour timelock.
      const evmId = evm.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: ETH_DST_TIMELOCK_SECONDS,
      });

      // User (or relayer) claims ETH by revealing the preimage on Ethereum.
      expect(() => evm.claimOrder(evmId, secret.preimage)).not.toThrow();
      expect(evm.getOrder(evmId).status).toBe("Claimed");

      // Resolver observes the preimage on-chain and claims SOL.
      expect(() => solana.claimOrder(solanaId, secret.preimage)).not.toThrow();
      expect(solana.getOrder(solanaId).status).toBe("Claimed");

      // Both legs settled with the same preimage.
      expect(verifyPreimage(secret.preimage, secret.sha256)).toBe("sha256");
    });

    // Hashlock parity: a keccak256-only hashlock is rejected by the Solana
    // HTLC just as it is by Soroban.  The route MUST use sha256 end-to-end.
    it("keccak256-only hashlock is accepted by EVM but rejected by Solana (sha256 required for cross-chain)", () => {
      const secret = generateSecret();
      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      const solanaId = solana.createOrder({ hashlock: secret.keccak256, timelockSeconds: TIMELOCK_SECONDS });
      const evmId    = evm.createOrder({   hashlock: secret.keccak256, timelockSeconds: TIMELOCK_SECONDS });

      // EVM accepts keccak256 hashlocks (supports both sha256 and keccak256).
      expect(() => evm.claimOrder(evmId, secret.preimage)).not.toThrow();
      // Solana HTLC is sha256-only; must reject the keccak256 hashlock match.
      expect(() => solana.claimOrder(solanaId, secret.preimage)).toThrow(/InvalidPreimage/);
    });

    // Invalid preimage: a wrong preimage must be rejected on both legs.
    it("wrong preimage is rejected on both Solana and Ethereum legs", () => {
      const secret = generateSecret();
      const wrong  = generateSecret();
      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      const solanaId = solana.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      const evmId    = evm.createOrder({   hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });

      expect(() => solana.claimOrder(solanaId, wrong.preimage)).toThrow(/InvalidPreimage/);
      expect(() => evm.claimOrder(evmId, wrong.preimage)).toThrow(/InvalidPreimage/);
      expect(solana.getOrder(solanaId).status).toBe("Funded");
      expect(evm.getOrder(evmId).status).toBe("Funded");
    });

    // Timelock expiry: once the Solana source lock expires the user can refund.
    it("user can refund on Solana after the source timelock expires", () => {
      const secret = generateSecret();
      const solana = new SolanaHtlcSim();

      const solanaId = solana.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: SOL_SRC_TIMELOCK_SECONDS,
      });

      // Before expiry: refund must be rejected.
      expect(() => solana.refundOrder(solanaId)).toThrow(/NotExpired/);

      // Advance past the source timelock.
      solana.advanceTime(SOL_SRC_TIMELOCK_SECONDS + 1);
      expect(() => solana.refundOrder(solanaId)).not.toThrow();
      expect(solana.getOrder(solanaId).status).toBe("Refunded");
    });

    // Destination ETH lock expires before the source Solana lock — the correct
    // ordering.  Resolver refunds ETH first, then user refunds SOL.
    it("resolver can refund ETH destination before Solana source due to asymmetric timelocks", () => {
      const secret = generateSecret();
      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      const solanaId = solana.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: SOL_SRC_TIMELOCK_SECONDS, // 24 h
      });
      const evmId = evm.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: ETH_DST_TIMELOCK_SECONDS,  // 12 h
      });

      // Simulate a partial settlement scenario: neither party claims.
      // Advance past the shorter ETH destination timelock (12 h + 1 s).
      const postEthExpiry = ETH_DST_TIMELOCK_SECONDS + 1;
      solana.advanceTime(postEthExpiry);
      evm.advanceTime(postEthExpiry);

      // Resolver can refund their ETH.
      expect(() => evm.refundOrder(evmId)).not.toThrow();
      expect(evm.getOrder(evmId).status).toBe("Refunded");

      // Solana source lock has NOT yet expired — user cannot refund yet.
      expect(() => solana.refundOrder(solanaId)).toThrow(/NotExpired/);
      expect(solana.getOrder(solanaId).status).toBe("Funded");

      // Advance past the remaining Solana source timelock.
      solana.advanceTime(SOL_SRC_TIMELOCK_SECONDS - postEthExpiry + 1);
      expect(() => solana.refundOrder(solanaId)).not.toThrow();
      expect(solana.getOrder(solanaId).status).toBe("Refunded");
    });

    // Claim/refund race: if the destination ETH lock expires while the user
    // tries to claim, the claim must be rejected.
    it("claim is rejected on the Ethereum leg after the destination timelock expires", () => {
      const secret = generateSecret();
      const evm    = new EvmHtlcSim();

      const evmId = evm.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: ETH_DST_TIMELOCK_SECONDS,
      });

      evm.advanceTime(ETH_DST_TIMELOCK_SECONDS + 1);

      expect(() => evm.claimOrder(evmId, secret.preimage)).toThrow(/Expired/);
      expect(evm.getOrder(evmId).status).toBe("Funded");
    });

    // Preimage replay: a preimage that resolves one leg must NOT unlock an
    // unrelated order on the other chain.  This verifies that each order's
    // hashlock is checked independently.
    it("preimage from one order does not unlock a different order on any chain", () => {
      const secretA = generateSecret();
      const secretB = generateSecret();

      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      // Order A: Solana source
      const solIdA = solana.createOrder({ hashlock: secretA.sha256, timelockSeconds: TIMELOCK_SECONDS });
      // Order B: Ethereum destination (different secret)
      const evmIdB = evm.createOrder({   hashlock: secretB.sha256, timelockSeconds: TIMELOCK_SECONDS });

      // Trying to claim order B on EVM with secret A should fail.
      expect(() => evm.claimOrder(evmIdB, secretA.preimage)).toThrow(/InvalidPreimage/);
      // Trying to claim order A on Solana with secret B should fail.
      expect(() => solana.claimOrder(solIdA, secretB.preimage)).toThrow(/InvalidPreimage/);
    });

    // State reconciliation after partial settlement: if ETH is claimed but
    // SOL refund is attempted before expiry the contract state must be sane.
    it("partial settlement: ETH claimed, Solana refund still blocked until expiry", () => {
      const secret = generateSecret();
      const solana = new SolanaHtlcSim();
      const evm    = new EvmHtlcSim();

      const solanaId = solana.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: SOL_SRC_TIMELOCK_SECONDS,
      });
      const evmId = evm.createOrder({
        hashlock: secret.sha256,
        timelockSeconds: ETH_DST_TIMELOCK_SECONDS,
      });

      // Resolver claims ETH immediately.
      evm.claimOrder(evmId, secret.preimage);
      expect(evm.getOrder(evmId).status).toBe("Claimed");

      // Solana source order is still Funded — user has not yet been paid.
      expect(solana.getOrder(solanaId).status).toBe("Funded");

      // Attempted refund before expiry should still fail.
      expect(() => solana.refundOrder(solanaId)).toThrow(/NotExpired/);

      // Resolver can now claim SOL using the revealed preimage.
      expect(() => solana.claimOrder(solanaId, secret.preimage)).not.toThrow();
      expect(solana.getOrder(solanaId).status).toBe("Claimed");
    });

    // Three-way sha256 parity: the same preimage must satisfy sha256 checks on
    // all three chain simulators, confirming end-to-end hashlock compatibility.
    it("sha256 hashlock satisfies all three chain simulators with the same preimage", () => {
      const secret  = generateSecret();
      const solana  = new SolanaHtlcSim();
      const evm     = new EvmHtlcSim();
      const soroban = new SorobanHtlcSim();

      const solanaId  = solana.createOrder({  hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      const evmId     = evm.createOrder({     hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });
      const sorobanId = soroban.createOrder({ hashlock: secret.sha256, timelockSeconds: TIMELOCK_SECONDS });

      solana.claimOrder(solanaId,   secret.preimage);
      evm.claimOrder(evmId,         secret.preimage);
      soroban.claimOrder(sorobanId, secret.preimage);

      expect(solana.getOrder(solanaId).status).toBe("Claimed");
      expect(evm.getOrder(evmId).status).toBe("Claimed");
      expect(soroban.getOrder(sorobanId).status).toBe("Claimed");
    });
  });
});
