// Measures how soon after a live tick its on-chain proof becomes verifiable.
// Takes the freshest real tick from today's log, then polls /odds/validation +
// validate_odds simulation every 30s until PROOF OK, printing elapsed time.

import * as fs from "fs";
import * as path from "path";
import { txline } from "./txline/client";
import { ChainValidator } from "./chain/validator";

async function main() {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(__dirname, "..", "data", `ticks-${day}.jsonl`);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  let tick: any = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = JSON.parse(lines[i]);
    if (t.FixtureId !== 999) {
      tick = t;
      break;
    }
  }
  if (!tick) throw new Error("no real ticks recorded yet");

  const intervalEnd = (Math.floor(tick.Ts / 300_000) + 1) * 300_000;
  console.log(`tick ${tick.MessageId} @ ${new Date(tick.Ts).toISOString()}`);
  console.log(`its 5-min interval closes at ${new Date(intervalEnd).toISOString()}`);

  const validator = new ChainValidator();
  const started = Date.now();
  const deadline = started + 20 * 60 * 1000;

  while (Date.now() < deadline) {
    try {
      const validation = await txline.oddsValidation(tick.MessageId, tick.Ts);
      const result = await validator.validateOdds(validation);
      if (result.ok) {
        const afterTick = ((Date.now() - tick.Ts) / 60000).toFixed(1);
        const afterInterval = ((Date.now() - intervalEnd) / 60000).toFixed(1);
        console.log(`PROOF OK — ${afterTick} min after tick, ${afterInterval} min after interval close (CU ${result.unitsConsumed})`);
        return;
      }
      console.log(`${new Date().toISOString().slice(11, 19)} not yet: ${result.error?.slice(0, 120)}`);
    } catch (e: any) {
      console.log(`${new Date().toISOString().slice(11, 19)} not yet: HTTP ${e.response?.status ?? e.message?.slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  console.log("TIMEOUT: proof not available within 20 min — increase verifier grace/retries!");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
