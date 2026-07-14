import * as fs from "fs";
import * as readline from "readline";
import * as zlib from "zlib";
import { Tick } from "./types";

/**
 * Replays a captured tick log through the same pipeline the live stream
 * feeds, preserving inter-tick timing scaled by `speed`. Judges can watch a
 * full recorded World Cup match — decisions, proofs and all — after the
 * tournament is over; on-chain Merkle roots are permanent, so every proof
 * still verifies.
 */
export class ReplayStream {
  private stopped = false;

  constructor(
    private file: string,
    private speed: number,
    private onTick: (t: Tick) => void,
    private onStatus: (msg: string) => void
  ) {}

  async start(): Promise<void> {
    while (!this.stopped) {
      this.onStatus(`REPLAY: ${this.file} at ${this.speed}x speed`);
      await this.playOnce();
      this.onStatus("REPLAY: recording finished — restarting from the top");
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  stop() {
    this.stopped = true;
  }

  private async playOnce(): Promise<void> {
    const raw = fs.createReadStream(this.file);
    const input = this.file.endsWith(".gz") ? raw.pipe(zlib.createGunzip()) : raw;
    const rl = readline.createInterface({ input });
    let prevTs: number | null = null;
    for await (const line of rl) {
      if (this.stopped) break;
      if (!line.trim()) continue;
      let tick: Tick;
      try {
        tick = JSON.parse(line);
      } catch {
        continue;
      }
      // skip heartbeats and synthetic test entries
      if (!tick.FixtureId || !tick.MessageId || tick.FixtureId === 999) continue;

      if (prevTs !== null && tick.Ts > prevTs) {
        const wait = Math.min((tick.Ts - prevTs) / this.speed, 15_000);
        if (wait > 5) await new Promise((r) => setTimeout(r, wait));
      }
      prevTs = tick.Ts;
      this.onTick(tick);
    }
  }
}
