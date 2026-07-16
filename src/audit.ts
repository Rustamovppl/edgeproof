// EdgeProof audit mode — "don't trust the agent, verify it."
//
// Independently re-verifies EVERY price tick the agent ever acted on:
// for each entry/exit in the ledger it re-fetches the Merkle proof from
// TxLINE and re-simulates the txoracle validate_odds instruction against the
// root committed on Solana devnet. No agent state is trusted — only the
// append-only ledger, the oracle API, and the blockchain.
//
// Run: npm run audit

import * as fs from "fs";
import * as path from "path";
import { txline } from "./txline/client";
import { ChainValidator } from "./chain/validator";
import { Position, TickRef } from "./agent/types";

const LEDGER = path.join(__dirname, "..", "data", "ledger.jsonl");

type Row = {
  position: string;
  side: "entry" | "exit";
  messageId: string;
  ts: number;
  claimedPct: number;
  result: "OK" | "FAIL";
  rootsAccount?: string;
  cu?: number;
  error?: string;
};

async function main() {
  // Rebuild final position states from the append-only journal
  const positions = new Map<string, Position>();
  for (const line of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as Position;
      positions.set(p.id, p);
    } catch { /* skip corrupt lines */ }
  }

  const validator = new ChainValidator();
  const rows: Row[] = [];
  const refs: { pos: Position; side: "entry" | "exit"; ref: TickRef }[] = [];
  for (const pos of positions.values()) {
    refs.push({ pos, side: "entry", ref: pos.entry });
    if (pos.exit) refs.push({ pos, side: "exit", ref: pos.exit });
  }

  console.log(`EdgeProof audit — re-verifying ${refs.length} price ticks behind ${positions.size} decisions\n`);

  for (const { pos, side, ref } of refs) {
    // pace the loop: the public devnet RPC rate-limits bursts of simulations
    await new Promise((r) => setTimeout(r, 1200));
    const label = `${pos.fixtureName} · ${pos.outcomeName} · ${side}`;
    try {
      const validation = await txline.oddsValidation(ref.messageId, ref.ts);

      // The proof must be for the exact tick the agent claims it acted on
      if (validation.odds.MessageId !== ref.messageId || validation.odds.Ts !== ref.ts) {
        throw new Error("oracle returned a different tick than claimed");
      }

      const result = await validator.validateOdds(validation);
      if (!result.ok) throw new Error(result.error ?? "on-chain simulation failed");

      rows.push({
        position: label, side, messageId: ref.messageId, ts: ref.ts,
        claimedPct: ref.pct, result: "OK",
        rootsAccount: result.rootsAccount, cu: result.unitsConsumed,
      });
      console.log(`  OK   ${label}`);
      console.log(`       tick ${ref.messageId} @ ${new Date(ref.ts).toISOString()}`);
      console.log(`       root account ${result.rootsAccount} (CU ${result.unitsConsumed})`);
    } catch (e: any) {
      const error = e.response?.status ? `HTTP ${e.response.status}` : e.message;
      rows.push({ position: label, side, messageId: ref.messageId, ts: ref.ts, claimedPct: ref.pct, result: "FAIL", error });
      console.log(`  FAIL ${label}: ${error}`);
    }
  }

  const ok = rows.filter((r) => r.result === "OK").length;
  console.log(`\n=== AUDIT RESULT: ${ok}/${rows.length} ticks independently verified on-chain ===`);

  const outFile = path.join(__dirname, "..", "data", `audit-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ auditedAt: new Date().toISOString(), verified: ok, total: rows.length, rows }, null, 2));
  console.log(`Full report: ${outFile}`);
  if (ok < rows.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
