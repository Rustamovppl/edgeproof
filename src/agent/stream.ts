import { config } from "../config";
import { txline } from "../txline/client";
import { Tick } from "./types";

/**
 * SSE consumer for /odds/stream with automatic reconnect and JWT renewal.
 * Uses raw fetch streaming (Node 20+) — no extra dependency.
 */
export class OddsStream {
  private stopped = false;
  private attempt = 0;

  constructor(private onTick: (t: Tick) => void, private onStatus: (msg: string) => void) {}

  async start(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.consume();
        this.attempt = 0;
      } catch (e: any) {
        this.onStatus(`stream error: ${e.message}`);
      }
      if (this.stopped) break;
      const backoff = Math.min(30_000, 1000 * 2 ** this.attempt++);
      this.onStatus(`reconnecting in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  stop() {
    this.stopped = true;
  }

  private async consume(): Promise<void> {
    // Watchdog: pre-match ticks arrive every ~15s; if nothing is received for
    // STALL_MS the connection is presumed silently dead and gets re-opened.
    const STALL_MS = 3 * 60 * 1000;
    const abort = new AbortController();
    let lastData = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > STALL_MS) abort.abort(new Error("stream stalled"));
    }, 15_000);

    try {
      let res = await this.connect(txline.currentJwt, abort.signal);
      if (res.status === 401 || res.status === 403) {
        const jwt = await txline.renewJwt();
        res = await this.connect(jwt, abort.signal);
      }
      if (!res.ok || !res.body) {
        throw new Error(`stream connect failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
      }
      this.onStatus("stream connected");
      this.attempt = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed by server");
        lastData = Date.now();
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                const tick = JSON.parse(payload) as Tick;
                // heartbeat frames parse as JSON but carry no fixture/market
                if (tick.FixtureId && tick.MessageId) this.onTick(tick);
              } catch {
                // ignore non-JSON keepalives
              }
            }
          }
        }
      }
    } finally {
      clearInterval(watchdog);
      abort.abort();
    }
  }

  private connect(jwt: string, signal: AbortSignal): Promise<Response> {
    return fetch(`${config.apiBaseUrl}/odds/stream`, {
      signal,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Api-Token": config.apiToken,
        Accept: "text/event-stream",
      },
    });
  }
}
