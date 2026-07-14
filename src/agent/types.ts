export type Tick = {
  FixtureId: number;
  MessageId: string;
  Ts: number;
  Bookmaker: string;
  BookmakerId: number;
  SuperOddsType: string;
  GameState: string | null;
  InRunning: boolean;
  MarketParameters: string | null;
  MarketPeriod: string | null;
  PriceNames: string[];
  Prices: number[]; // decimal odds x1000
  Pct: string[]; // implied probabilities, de-margined
};

export type Fixture = {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  Competition: string;
  StartTime: number;
  GameState?: number;
};

export type VerificationStatus = "pending" | "verified" | "failed";

export type TickRef = {
  messageId: string;
  ts: number;
  pct: number;
  odds: number;
  verification: VerificationStatus;
  rootsAccount?: string;
  unitsConsumed?: number;
  verifiedAt?: number;
  error?: string;
};

export type Position = {
  id: string;
  fixtureId: number;
  fixtureName: string;
  outcome: string; // part1 | draw | part2
  outcomeName: string;
  market?: string; // TickStore market key; absent on legacy rows = FT 1X2
  stake: number; // paper units
  entry: TickRef;
  exit?: TickRef;
  openedAt: number;
  closedAt?: number;
  reason: string; // why the agent opened it
  closeReason?: string;
  pnl?: number; // realized, in units
  status: "open" | "closed";
};

export type AgentEvent =
  | { type: "tick"; tick: Tick }
  | { type: "decision"; position: Position }
  | { type: "close"; position: Position }
  | { type: "verification"; positionId: string; side: "entry" | "exit"; ref: TickRef }
  | { type: "status"; msg: string };
