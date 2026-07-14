import express from "express";
import * as http from "http";
import * as path from "path";
import { txline } from "../txline/client";
import { ChainValidator } from "../chain/validator";
import { OddsStream } from "./stream";
import { ReplayStream } from "./replay";
import { TickStore } from "./store";
import { SteamStrategy, outcomeName, FT_1X2, ET_1X2 } from "./strategy";
import { Ledger } from "./ledger";
import { VerifierQueue } from "./verifier";
import { AgentEvent, Fixture, Position, Tick, TickRef } from "./types";

const PORT = Number(process.env.PORT ?? 8787);
const REPLAY_FILE = process.env.REPLAY_FILE;
const REPLAY_SPEED = Number(process.env.REPLAY_SPEED ?? 60);

const store = new TickStore(30 * 60 * 1000, !REPLAY_FILE);
const ledger = new Ledger();
const strategy = new SteamStrategy(store);
const validator = new ChainValidator();
const verifier = new VerifierQueue(validator, (msg) => broadcast({ type: "status", msg }));

const fixtures = new Map<number, Fixture>();
const sseClients = new Set<express.Response>();
const startedAt = Date.now();

function broadcast(ev: AgentEvent) {
  if (ev.type !== "tick") console.log(`[${new Date().toISOString().slice(11, 19)}]`, ev.type, ev.type === "status" ? ev.msg : "");
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) res.write(line);
}

async function refreshFixtures() {
  try {
    const list = await txline.fixturesSnapshot();
    for (const f of list) fixtures.set(f.FixtureId, f);
  } catch (e: any) {
    broadcast({ type: "status", msg: `fixtures refresh failed: ${e.message}` });
  }
}

function tickRef(tick: Tick, outcomeIdx: number): TickRef {
  return {
    messageId: tick.MessageId,
    ts: tick.Ts,
    pct: parseFloat(tick.Pct[outcomeIdx]),
    odds: tick.Prices[outcomeIdx] / 1000,
    verification: "pending",
  };
}

function onTick(tick: Tick) {
  store.record(tick);
  broadcast({ type: "tick", tick });

  // 1) exits first
  for (const pos of ledger.open()) {
    const closeReason = strategy.shouldClose(pos, tick);
    if (!closeReason) continue;
    const idx = tick.PriceNames.indexOf(pos.outcome);
    pos.exit = tickRef(tick, idx);
    pos.closedAt = Date.now();
    pos.closeReason = closeReason;
    pos.pnl = SteamStrategy.pnl(pos.stake, pos.entry.pct, pos.exit.pct);
    pos.status = "closed";
    ledger.upsert(pos);
    broadcast({ type: "close", position: pos });
    verifier.enqueue(pos.exit, (ref) => {
      ledger.upsert(pos);
      broadcast({ type: "verification", positionId: pos.id, side: "exit", ref });
    });
  }

  // 2) entries
  for (const sig of strategy.onTick(tick, ledger.open())) {
    const fixture = fixtures.get(tick.FixtureId);
    const outcome = tick.PriceNames[sig.outcome];
    const pos: Position = {
      id: `${tick.FixtureId}-${outcome}-${tick.Ts}`,
      fixtureId: tick.FixtureId,
      fixtureName: fixture ? `${fixture.Participant1} vs ${fixture.Participant2}` : String(tick.FixtureId),
      outcome,
      outcomeName: outcomeName(fixture, outcome) + (TickStore.marketKey(tick) === ET_1X2 ? " (extra time)" : ""),
      market: TickStore.marketKey(tick),
      stake: SteamStrategy.STAKE,
      entry: tickRef(tick, sig.outcome),
      openedAt: Date.now(),
      reason: sig.reason,
      status: "open",
    };
    ledger.upsert(pos);
    broadcast({ type: "decision", position: pos });
    verifier.enqueue(pos.entry, (ref) => {
      ledger.upsert(pos);
      broadcast({ type: "verification", positionId: pos.id, side: "entry", ref });
    });
  }
}

/**
 * Safety sweep: positions are normally closed by incoming ticks, but if a
 * fixture's stream goes quiet (match ended, coverage stopped) the position
 * would stay open forever. Close anything past MAX_HOLD at its last known
 * price.
 */
function sweepStalePositions() {
  const now = Date.now();
  for (const pos of ledger.open()) {
    if (now - pos.openedAt < SteamStrategy.MAX_HOLD_MS + 60_000) continue;
    const last = store.latest(pos.fixtureId, pos.market ?? FT_1X2);
    const idx = last ? last.PriceNames.indexOf(pos.outcome) : -1;
    if (!last || idx < 0) continue;
    pos.exit = tickRef(last, idx);
    pos.closedAt = now;
    pos.closeReason = "sweep: no fresh ticks, closed at last known price";
    pos.pnl = SteamStrategy.pnl(pos.stake, pos.entry.pct, pos.exit.pct);
    pos.status = "closed";
    ledger.upsert(pos);
    broadcast({ type: "close", position: pos });
    verifier.enqueue(pos.exit, (ref) => {
      ledger.upsert(pos);
      broadcast({ type: "verification", positionId: pos.id, side: "exit", ref });
    });
  }
}

// ---------- HTTP API ----------
const app = express();
app.use(express.static(path.join(__dirname, "..", "..", "public")));

app.get("/api/state", (_req, res) => {
  const fixtureStates = [...fixtures.values()]
    .map((f) => {
      // Show whichever 1X2 market is currently alive: extra time takes over
      // from the regulation market once the oracle switches to it.
      const ft = store.latest(f.FixtureId, FT_1X2);
      const et = store.latest(f.FixtureId, ET_1X2);
      const latest = et && (!ft || et.Ts > ft.Ts) ? et : ft;
      return latest
        ? {
            fixture: f,
            latest1x2: {
              names: latest.PriceNames.map((n) => outcomeName(f, n)),
              pct: latest.Pct.map(parseFloat),
              odds: latest.Prices.map((p) => p / 1000),
              ts: latest.Ts,
              messageId: latest.MessageId,
              inRunning: latest.InRunning,
              gameState: latest.GameState,
              period: latest === et ? "extra time" : "full time",
            },
          }
        : { fixture: f, latest1x2: null };
    })
    .sort((a, b) => a.fixture.StartTime - b.fixture.StartTime);

  res.json({
    startedAt,
    replay: Boolean(REPLAY_FILE),
    now: Date.now(),
    totalTicks: store.totalTicks,
    pendingVerifications: verifier.pendingCount(),
    realizedPnl: ledger.realizedPnl(),
    positions: ledger.all().slice(0, 50),
    fixtures: fixtureStates,
  });
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ---------- boot ----------
/** The verification queue lives in memory — re-enqueue unproven ticks after a restart. */
function requeuePendingProofs() {
  for (const pos of ledger.all()) {
    for (const side of ["entry", "exit"] as const) {
      const ref = pos[side];
      if (ref && ref.verification === "pending") {
        verifier.enqueue(ref, (r) => {
          ledger.upsert(pos);
          broadcast({ type: "verification", positionId: pos.id, side, ref: r });
        });
      }
    }
  }
}

async function main() {
  await refreshFixtures();
  setInterval(refreshFixtures, 10 * 60 * 1000);
  setInterval(sweepStalePositions, 60 * 1000);
  verifier.start();
  requeuePendingProofs();

  http.createServer(app).listen(PORT, () => {
    console.log(`EdgeProof dashboard: http://localhost:${PORT}`);
  });

  const stream = REPLAY_FILE
    ? new ReplayStream(REPLAY_FILE, REPLAY_SPEED, onTick, (msg) => broadcast({ type: "status", msg }))
    : new OddsStream(onTick, (msg) => broadcast({ type: "status", msg }));
  await stream.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
