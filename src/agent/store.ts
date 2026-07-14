import * as fs from "fs";
import * as path from "path";
import { Tick } from "./types";

const DATA_DIR = path.join(__dirname, "..", "..", "data");

/**
 * Persists every raw tick to a JSONL file (one per UTC day) and keeps an
 * in-memory rolling history per fixture/market for the strategy.
 */
export class TickStore {
  private streams = new Map<string, fs.WriteStream>();
  /** fixtureId -> market key -> chronological ticks (trimmed to windowMs) */
  private history = new Map<number, Map<string, Tick[]>>();
  totalTicks = 0;

  constructor(private windowMs = 30 * 60 * 1000, private persist = true) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  static marketKey(t: Tick): string {
    return `${t.SuperOddsType}|${t.MarketPeriod ?? "FT"}|${t.MarketParameters ?? "-"}`;
  }

  record(t: Tick): void {
    this.totalTicks++;
    if (this.persist) {
      const day = new Date(t.Ts).toISOString().slice(0, 10);
      let ws = this.streams.get(day);
      if (!ws) {
        ws = fs.createWriteStream(path.join(DATA_DIR, `ticks-${day}.jsonl`), { flags: "a" });
        this.streams.set(day, ws);
      }
      ws.write(JSON.stringify(t) + "\n");
    }

    // Suspension ticks (empty Prices/Pct — e.g. market pause at kick-off or
    // around goals) are kept on disk but excluded from strategy history.
    if (!t.Prices?.length || !t.Pct?.length || t.Pct.some((p) => !Number.isFinite(parseFloat(p)))) {
      return;
    }

    // in-memory history
    let markets = this.history.get(t.FixtureId);
    if (!markets) {
      markets = new Map();
      this.history.set(t.FixtureId, markets);
    }
    const key = TickStore.marketKey(t);
    let arr = markets.get(key);
    if (!arr) {
      arr = [];
      markets.set(key, arr);
    }
    arr.push(t);
    const cutoff = t.Ts - this.windowMs;
    while (arr.length > 2 && arr[0].Ts < cutoff) arr.shift();
  }

  marketHistory(fixtureId: number, key: string): Tick[] {
    return this.history.get(fixtureId)?.get(key) ?? [];
  }

  latest(fixtureId: number, key: string): Tick | undefined {
    const arr = this.marketHistory(fixtureId, key);
    return arr[arr.length - 1];
  }

  fixtureIds(): number[] {
    return [...this.history.keys()];
  }

  marketsOf(fixtureId: number): string[] {
    return [...(this.history.get(fixtureId)?.keys() ?? [])];
  }
}
