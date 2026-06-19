/**
 * Unit tests for QuoteService SWR caching behaviour.
 *
 * All tests run entirely in-process — no network calls are made.  The global
 * `fetch` is stubbed per test so CoinGecko responses can be scripted
 * deterministically.
 */

import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import pino from "pino";
import { QuoteService } from "../src/services/quote-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOOP_LOGGER = pino({ level: "silent" });

/** A valid CoinGecko response for the ETH-XLM pair. */
function mockCoinGeckoResponse(ethUsd: number, xlmUsd: number): Response {
  return new Response(
    JSON.stringify({ ethereum: { usd: ethUsd }, stellar: { usd: xlmUsd } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** A valid CoinGecko response for the ETH-SOL pair. */
function mockCoinGeckoSolResponse(ethUsd: number, solUsd: number): Response {
  return new Response(
    JSON.stringify({ ethereum: { usd: ethUsd }, solana: { usd: solUsd } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** Advance vitest's fake timer by `ms` and flush the full microtask queue.
 *
 * The background refresh chain inside _fetchAndStore goes through at least
 * 5 async hops: fetch resolves → Response.json() resolves → cache.set →
 * _fetchAndStore returns → .catch/.finally on the inflight promise.
 * We flush 10 times to be safe across all Node 22/24 event-loop orderings.
 */
async function advanceAndFlush(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("QuoteService — SWR caching", () => {
  let fetchMock: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Fresh window ──────────────────────────────────────────────────────────

  it("returns fresh data without hitting the upstream again within freshTtlMs", async () => {
    fetchMock.mockResolvedValueOnce(mockCoinGeckoResponse(3000, 0.10));

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 15_000, staleTtlMs: 60_000, maxStaleTtlMs: 300_000 });

    const first = await svc.getQuote("ETH-XLM");
    expect(first.staleness).toBe("fresh");
    expect(first.srcUsd).toBe(3000);
    expect(first.dstUsd).toBe(0.10);

    // Advance just under the fresh window.
    await advanceAndFlush(14_000);
    const second = await svc.getQuote("ETH-XLM");
    expect(second.staleness).toBe("fresh");

    // Upstream was only called once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Stale window — background refresh ─────────────────────────────────────

  it("serves stale data immediately and kicks off a background refresh within staleTtlMs", async () => {
    // First call: live fetch.
    fetchMock.mockResolvedValueOnce(mockCoinGeckoResponse(3000, 0.10));
    // Background refresh triggered after stale window.
    fetchMock.mockResolvedValueOnce(mockCoinGeckoResponse(3100, 0.11));

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 5_000, staleTtlMs: 30_000, maxStaleTtlMs: 300_000 });

    await svc.getQuote("ETH-XLM");

    // Advance past fresh but within stale.
    await advanceAndFlush(10_000);

    const stale = await svc.getQuote("ETH-XLM");
    // Served stale immediately.
    expect(stale.staleness).toBe("stale");
    expect(stale.srcUsd).toBe(3000);

    // Wait for background refresh to settle.
    await advanceAndFlush(100);

    const refreshed = await svc.getQuote("ETH-XLM");
    expect(refreshed.srcUsd).toBe(3100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Thundering herd: concurrent callers during cold start ─────────────────

  it("collapses concurrent requests into a single upstream call (thundering-herd guard)", async () => {
    // A deferred promise lets us control when the upstream resolves so all
    // five callers are in-flight simultaneously before any resolves.
    let resolveUpstream!: (r: Response) => void;
    const upstreamPending = new Promise<Response>((resolve) => {
      resolveUpstream = resolve;
    });

    fetchMock.mockReturnValue(upstreamPending);

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 15_000, staleTtlMs: 60_000, maxStaleTtlMs: 300_000 });

    // Fire 5 concurrent requests — all will await the same pending promise.
    const allQuotes = Promise.all([
      svc.getQuote("ETH-XLM"),
      svc.getQuote("ETH-XLM"),
      svc.getQuote("ETH-XLM"),
      svc.getQuote("ETH-XLM"),
      svc.getQuote("ETH-XLM"),
    ]);

    // Verify fetch was only called once across all 5 concurrent calls.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Now resolve the upstream — all callers should settle with the same data.
    resolveUpstream(mockCoinGeckoResponse(3200, 0.12));
    const [a, b, c, d, e] = await allQuotes;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const snap of [a, b, c, d, e]) {
      expect(snap.srcUsd).toBe(3200);
      expect(snap.dstUsd).toBe(0.12);
    }
  });

  // ── API outage: returns fallback, not an error ─────────────────────────────

  it("returns hardcoded fallback when the upstream is unavailable at cold start", async () => {
    fetchMock.mockRejectedValue(new Error("Network error"));

    const svc = new QuoteService(NOOP_LOGGER);
    const snap = await svc.getQuote("ETH-XLM");

    expect(snap.staleness).toBe("fallback");
    expect(snap.source).toBe("fallback");
    // Hardcoded fallback prices are non-null.
    expect(snap.srcUsd).not.toBeNull();
    expect(snap.dstUsd).not.toBeNull();
  });

  it("returns last-known-good entry (marked fallback) when upstream fails after a prior fetch", async () => {
    // First call: live data.
    fetchMock.mockResolvedValueOnce(mockCoinGeckoResponse(3000, 0.10));
    // Second call (background refresh): upstream outage.
    fetchMock.mockRejectedValueOnce(new Error("coingecko 503"));

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 5_000, staleTtlMs: 30_000, maxStaleTtlMs: 300_000 });

    const live = await svc.getQuote("ETH-XLM");
    expect(live.srcUsd).toBe(3000);

    // Move past fresh into stale window to trigger background refresh.
    await advanceAndFlush(10_000);
    await svc.getQuote("ETH-XLM"); // triggers background refresh

    // Wait for the failed refresh to settle.
    await advanceAndFlush(100);

    // Move past max-stale to force the next call to block on a new fetch —
    // which also fails.
    fetchMock.mockRejectedValueOnce(new Error("still down"));
    await advanceAndFlush(400_000);

    const fallback = await svc.getQuote("ETH-XLM");
    // Prices should be last-known-good (3000 / 0.10), not hardcoded, and
    // marked as fallback so the UI can warn.
    expect(fallback.staleness).toBe("fallback");
    expect(fallback.srcUsd).toBe(3000);
    expect(fallback.dstUsd).toBe(0.10);
  });

  it("returns a clear failure signal when a non-200 response is received", async () => {
    fetchMock.mockResolvedValue(new Response("Service Unavailable", { status: 503 }));

    const svc = new QuoteService(NOOP_LOGGER);
    const snap = await svc.getQuote("ETH-XLM");

    expect(snap.staleness).toBe("fallback");
    expect(snap.source).toBe("fallback");
  });

  it("does not serve data beyond maxStaleTtlMs from the last live fetch without at least a fallback signal", async () => {
    fetchMock.mockResolvedValueOnce(mockCoinGeckoResponse(3000, 0.10));
    // All subsequent upstream calls fail.
    fetchMock.mockRejectedValue(new Error("outage"));

    const svc = new QuoteService(NOOP_LOGGER, {
      freshTtlMs: 5_000,
      staleTtlMs: 30_000,
      maxStaleTtlMs: 60_000,
    });

    await svc.getQuote("ETH-XLM");

    // Jump well past maxStaleTtlMs.
    await advanceAndFlush(120_000);

    const snap = await svc.getQuote("ETH-XLM");
    // staleness must be "fallback" — the service must not return "fresh" or
    // "stale" for data older than maxStaleTtlMs.
    expect(snap.staleness).toBe("fallback");
    // But prices should still be last-known-good, not null.
    expect(snap.srcUsd).not.toBeNull();
  });

  // ── Background refresh does not block callers ──────────────────────────────

  it("never blocks the current caller during a background refresh", async () => {
    // Initial live fetch: resolves immediately.
    fetchMock.mockResolvedValueOnce(mockCoinGeckoResponse(3000, 0.10));

    // Background refresh: resolves only after the test completes.
    // We use a deferred that we resolve in cleanup to avoid vitest
    // detecting an unresolved promise on teardown.
    let resolveBackground!: (r: Response) => void;
    const backgroundPending = new Promise<Response>((res) => { resolveBackground = res; });
    fetchMock.mockReturnValueOnce(backgroundPending);

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 5_000, staleTtlMs: 30_000, maxStaleTtlMs: 300_000 });

    await svc.getQuote("ETH-XLM");

    // Enter the stale window — next call triggers a background refresh.
    await advanceAndFlush(10_000);

    // This call must return with stale data immediately, without blocking on
    // the pending background refresh.
    const snap = await svc.getQuote("ETH-XLM");

    expect(snap.srcUsd).toBe(3000); // stale data returned synchronously
    expect(snap.staleness).toBe("stale");
    // fetch was called twice: initial + background refresh kick-off.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Resolve the background promise so vitest teardown doesn't see a
    // dangling pending promise.
    resolveBackground(mockCoinGeckoResponse(3000, 0.10));
    await backgroundPending;
  });

  // ── quoteEthXlm convenience method ────────────────────────────────────────

  it("quoteEthXlm() returns stringified prices and staleness metadata", async () => {
    fetchMock.mockResolvedValueOnce(mockCoinGeckoResponse(3400, 0.11));

    const svc = new QuoteService(NOOP_LOGGER);
    const result = await svc.quoteEthXlm();

    expect(result.ethUsd).toBe("3400");
    expect(result.xlmUsd).toBe("0.11");
    expect(result.staleness).toBe("fresh");
    expect(typeof result.fetchedAt).toBe("number");
    expect(typeof result.ageMs).toBe("number");
  });

  // ── ETH-SOL pair ─────────────────────────────────────────────────────────

  it("caches ETH-XLM and ETH-SOL independently", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("stellar")) {
        return Promise.resolve(mockCoinGeckoResponse(3000, 0.10));
      }
      return Promise.resolve(mockCoinGeckoSolResponse(3000, 160));
    });

    const svc = new QuoteService(NOOP_LOGGER);

    const xlm = await svc.getQuote("ETH-XLM");
    const sol = await svc.getQuote("ETH-SOL");

    expect(xlm.dstUsd).toBe(0.10);
    expect(sol.dstUsd).toBe(160);
    // Two separate upstream calls — one per pair.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── rate field ────────────────────────────────────────────────────────────

  it("computes the correct rate field as srcUsd / dstUsd", async () => {
    fetchMock.mockResolvedValueOnce(mockCoinGeckoResponse(4000, 0.20));

    const svc = new QuoteService(NOOP_LOGGER);
    const snap = await svc.getQuote("ETH-XLM");

    // 4000 / 0.20 = 20000
    expect(snap.rate).toBeCloseTo(20_000, 2);
  });
});
