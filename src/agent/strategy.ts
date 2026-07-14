import { Tick, Position, Fixture } from "./types";
import { TickStore } from "./store";

export const FT_1X2 = "1X2_PARTICIPANT_RESULT|FT|-";
export const ET_1X2 = "1X2_PARTICIPANT_RESULT|et|-";
/** Markets the agent trades: regulation-time 1X2 and, in knockout games, extra-time 1X2. */
export const TRADEABLE_1X2 = new Set([FT_1X2, ET_1X2]);

export type Signal = {
  fixtureId: number;
  outcome: number; // index into PriceNames
  tick: Tick;
  refTick: Tick;
  deltaPp: number;
  reason: string;
};

/**
 * Steam-move strategy on the de-margined full-time 1X2 market.
 *
 * The TxLINE stable price is an aggregate fair probability. When an outcome's
 * implied probability rises by STEAM_PP percentage points within LOOKBACK_MS
 * (a "steam move" — e.g. a goal or heavy market support), the agent buys
 * prediction-market-style shares of that outcome at the current probability.
 * Positions are marked to the live probability and closed on reversal,
 * take-profit, or timeout. Every entry/exit references the exact odds tick,
 * which is then proven against the on-chain Merkle root.
 */
export class SteamStrategy {
  static readonly STEAM_PP = 2.5; // entry: prob up >= 2.5pp in window
  // Skip goal shocks: a jump this large means the market already repriced a
  // goal — chasing it buys the top (confirmed on captured live data, where
  // +20pp entries were stopped out while gentle-drift entries won).
  static readonly MAX_STEAM_PP = 8.0;
  static readonly LOOKBACK_MS = 10 * 60 * 1000;
  static readonly STOP_PP = 2.0; // exit: prob down >= 2pp from entry
  static readonly TAKE_PP = 5.0; // exit: prob up >= 5pp from entry
  static readonly MAX_HOLD_MS = 45 * 60 * 1000;
  static readonly STAKE = 100;
  // Longshots are untradeable with an absolute stop: at ~7% probability a
  // -2pp stop is a -30% relative move that noise hits instantly (both
  // Switzerland entries at 6.8%/7.8% were stopped for -30/-28 units).
  static readonly MIN_PROB = 15;
  static readonly MAX_PROB = 90; // no value buying near-certainties

  constructor(private store: TickStore) {}

  /** Evaluate a new 1X2 tick (FT or extra time); return entry signals (one per outcome max). */
  onTick(tick: Tick, openPositions: Position[]): Signal[] {
    const market = TickStore.marketKey(tick);
    if (!TRADEABLE_1X2.has(market)) return [];
    const hist = this.store.marketHistory(tick.FixtureId, market);
    if (hist.length < 2) return [];

    const signals: Signal[] = [];
    const cutoff = tick.Ts - SteamStrategy.LOOKBACK_MS;
    // reference = oldest tick inside the lookback window
    const ref = hist.find((h) => h.Ts >= cutoff) ?? hist[0];
    if (ref.MessageId === tick.MessageId) return [];

    for (let i = 0; i < tick.PriceNames.length; i++) {
      const now = parseFloat(tick.Pct[i]);
      const before = parseFloat(ref.Pct[i]);
      const delta = now - before;
      if (!Number.isFinite(delta)) continue; // suspension/malformed tick
      if (now < SteamStrategy.MIN_PROB || now > SteamStrategy.MAX_PROB) continue;
      if (delta < SteamStrategy.STEAM_PP || delta > SteamStrategy.MAX_STEAM_PP) continue;
      const alreadyOpen = openPositions.some(
        (p) =>
          p.fixtureId === tick.FixtureId &&
          p.outcome === tick.PriceNames[i] &&
          (p.market ?? FT_1X2) === market &&
          p.status === "open"
      );
      if (alreadyOpen) continue;
      signals.push({
        fixtureId: tick.FixtureId,
        outcome: i,
        tick,
        refTick: ref,
        deltaPp: delta,
        reason: `steam move: ${tick.PriceNames[i]} prob ${before.toFixed(1)}% -> ${now.toFixed(1)}% (+${delta.toFixed(1)}pp in ${Math.round((tick.Ts - ref.Ts) / 60000)}min)`,
      });
    }
    return signals;
  }

  /** Should an open position be closed on this tick? Only ticks of the position's own market count. */
  shouldClose(position: Position, tick: Tick): string | null {
    if (TickStore.marketKey(tick) !== (position.market ?? FT_1X2) || tick.FixtureId !== position.fixtureId) return null;
    const idx = tick.PriceNames.indexOf(position.outcome);
    if (idx < 0) return null;
    const now = parseFloat(tick.Pct[idx]);
    if (!Number.isFinite(now)) return null; // suspension/malformed tick
    const delta = now - position.entry.pct;
    if (delta <= -SteamStrategy.STOP_PP) return `stop: prob ${position.entry.pct.toFixed(1)}% -> ${now.toFixed(1)}%`;
    if (delta >= SteamStrategy.TAKE_PP) return `take-profit: prob ${position.entry.pct.toFixed(1)}% -> ${now.toFixed(1)}%`;
    if (tick.Ts - position.openedAt >= SteamStrategy.MAX_HOLD_MS) return "timeout: max holding period";
    if (tick.GameState && /^(F|FO|A|C)/.test(tick.GameState)) return `game over (${tick.GameState})`;
    return null;
  }

  /** Prediction-market style P&L: buy shares at entry prob, sell at exit prob. */
  static pnl(stake: number, entryPct: number, exitPct: number): number {
    return +(stake * ((exitPct - entryPct) / entryPct)).toFixed(2);
  }
}

export function outcomeName(fixture: Fixture | undefined, outcome: string): string {
  if (!fixture) return outcome;
  if (outcome === "part1") return fixture.Participant1;
  if (outcome === "part2") return fixture.Participant2;
  return "Draw";
}
