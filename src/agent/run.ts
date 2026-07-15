import express from "express";
import * as fs from "fs";
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
  if (REPLAY_FILE) {
    // Replayed matches have left the live fixtures snapshot — load their
    // metadata from the recorded copy so the dashboard can name them.
    try {
      const recorded = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "..", "data", "recorded-fixtures.json"), "utf8")
      ) as Fixture[];
      for (const f of recorded) if (!fixtures.has(f.FixtureId)) fixtures.set(f.FixtureId, f);
    } catch {
      // recorded metadata is optional
    }
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

/** Close whatever is still open at the recording's end, then wipe market history. */
function onReplayLoop() {
  for (const pos of ledger.open()) {
    const last = store.latest(pos.fixtureId, pos.market ?? FT_1X2);
    const idx = last ? last.PriceNames.indexOf(pos.outcome) : -1;
    if (last && idx >= 0) {
      pos.exit = tickRef(last, idx);
      pos.pnl = SteamStrategy.pnl(pos.stake, pos.entry.pct, pos.exit.pct);
    } else {
      pos.pnl = 0;
    }
    pos.closedAt = Date.now();
    pos.closeReason = "recording ended";
    pos.status = "closed";
    ledger.upsert(pos);
    broadcast({ type: "close", position: pos });
    if (pos.exit) {
      const exit = pos.exit;
      verifier.enqueue(exit, (ref) => {
        ledger.upsert(pos);
        broadcast({ type: "verification", positionId: pos.id, side: "exit", ref });
      });
    }
  }
  store.reset();
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
    // in replay mode, show only the matches actually being replayed
    .filter((x) => !REPLAY_FILE || x.latest1x2)
    // the dashboard is a World Cup product: hide friendlies unless they have live prices
    .filter((x) => x.fixture.Competition === "World Cup" || x.latest1x2)
    // hide long-finished matches with no price data — nothing to look at
    .filter((x) => x.latest1x2 || x.fixture.StartTime > Date.now() - 6 * 3600 * 1000)
    .sort((a, b) => a.fixture.StartTime - b.fixture.StartTime);

  // The strategy was re-tuned live at 2026-07-11 22:13:58Z after the first
  // night's goal-chasing losses; split P&L so the dashboard tells that story.
  const TUNING_CUTOFF = 1783808038000;
  const closed = ledger.all().filter((p) => p.status === "closed" && p.pnl !== undefined);
  const pnlBefore = +closed.filter((p) => p.openedAt < TUNING_CUTOFF).reduce((s, p) => s + p.pnl!, 0).toFixed(2);
  const pnlTuned = +closed.filter((p) => p.openedAt >= TUNING_CUTOFF).reduce((s, p) => s + p.pnl!, 0).toFixed(2);

  res.json({
    startedAt,
    replay: Boolean(REPLAY_FILE),
    pnlBefore,
    pnlTuned,
    integrity,
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
// Continuous feed-integrity sampling: beyond proving its own decisions, the
// agent spot-checks random ticks from the raw feed against the on-chain
// roots, so oracle tampering would surface even on ticks it never traded.
const integrity = { ok: 0, fail: 0, lastMessageId: "", lastCheckedAt: 0 };

async function sampleFeedIntegrity() {
  const fixtureIds = store.fixtureIds();
  if (!fixtureIds.length) return;
  const fid = fixtureIds[Math.floor(Math.random() * fixtureIds.length)];
  const markets = store.marketsOf(fid);
  if (!markets.length) return;
  const hist = store.marketHistory(fid, markets[Math.floor(Math.random() * markets.length)]);
  // proofs exist only once the tick's 5-minute interval root is published
  const provable = hist.filter((t) => t.Ts < Date.now() - 7 * 60 * 1000);
  const tick = provable[Math.floor(Math.random() * provable.length)];
  if (!tick) return;
  try {
    const validation = await txline.oddsValidation(tick.MessageId, tick.Ts);
    const result = await validator.validateOdds(validation);
    if (!result.ok) throw new Error(result.error ?? "simulation failed");
    integrity.ok++;
    integrity.lastMessageId = tick.MessageId;
    integrity.lastCheckedAt = Date.now();
    broadcast({ type: "status", msg: `integrity check OK — random tick ${tick.MessageId} matches the on-chain root` });
  } catch (e: any) {
    integrity.fail++;
    broadcast({ type: "status", msg: `integrity check FAILED for ${tick.MessageId}: ${e.message?.slice(0, 120)}` });
  }
}

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
  setInterval(() => sampleFeedIntegrity().catch(() => {}), 5 * 60 * 1000);
  verifier.start();
  requeuePendingProofs();

  http.createServer(app).listen(PORT, () => {
    console.log(`EdgeProof dashboard: http://localhost:${PORT}`);
  });

  const stream = REPLAY_FILE
    ? new ReplayStream(
        REPLAY_FILE,
        REPLAY_SPEED,
        onTick,
        (msg) => broadcast({ type: "status", msg }),
        onReplayLoop
      )
    : new OddsStream(onTick, (msg) => broadcast({ type: "status", msg }));
  await stream.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
