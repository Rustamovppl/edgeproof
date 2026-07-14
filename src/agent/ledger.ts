import * as fs from "fs";
import * as path from "path";
import { Position } from "./types";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
// Replay mode journals to its own file so recorded live history stays pristine
const LEDGER_FILE = process.env.LEDGER_FILE
  ? path.resolve(process.env.LEDGER_FILE)
  : path.join(DATA_DIR, "ledger.jsonl");

/** Append-only journal of every position event; state is rebuilt on restart. */
export class Ledger {
  positions = new Map<string, Position>();

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LEDGER_FILE)) {
      for (const line of fs.readFileSync(LEDGER_FILE, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line) as Position;
          this.positions.set(p.id, p);
        } catch {
          // skip corrupt lines
        }
      }
    }
  }

  upsert(p: Position) {
    this.positions.set(p.id, p);
    fs.appendFileSync(LEDGER_FILE, JSON.stringify(p) + "\n");
  }

  open(): Position[] {
    return [...this.positions.values()].filter((p) => p.status === "open");
  }

  all(): Position[] {
    return [...this.positions.values()].sort((a, b) => b.openedAt - a.openedAt);
  }

  realizedPnl(): number {
    return +[...this.positions.values()]
      .filter((p) => p.status === "closed" && p.pnl !== undefined)
      .reduce((s, p) => s + p.pnl!, 0)
      .toFixed(2);
  }
}
