import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import * as fs from "fs";
import TxoracleJson from "../../idl/txoracle.json";
import { Txoracle } from "./txoracle-types";
import { config } from "../config";

// DailyOddsMerkleRoots accounts: 8-byte discriminator, epochDay as u16 LE at
// offset 8, then 288 five-minute-interval Merkle roots. The PDA seed string is
// not published, so we map epochDay -> account by reading the accounts.
const ODDS_ROOTS_DISCRIMINATOR = "0d6e05ed89f203dd";

export type OddsValidationResult = {
  ok: boolean;
  epochDay: number;
  rootsAccount: string;
  unitsConsumed?: number;
  error?: string;
  logs?: string[];
};

export class ChainValidator {
  readonly connection: Connection;
  readonly program: Program<Txoracle>;
  private readonly wallet: Keypair;
  private oddsRootsByDay = new Map<number, PublicKey>();

  constructor() {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    const secret = JSON.parse(config.walletJson || fs.readFileSync(config.walletPath, "utf8"));
    this.wallet = Keypair.fromSecretKey(Uint8Array.from(secret));

    const provider = new anchor.AnchorProvider(
      this.connection,
      new anchor.Wallet(this.wallet),
      { commitment: "confirmed" }
    );
    anchor.setProvider(provider);
    this.program = new Program<Txoracle>(TxoracleJson as unknown as Txoracle, provider);
  }

  // Simulations don't need a fresh blockhash every call — cache it briefly
  // to halve RPC traffic (the public devnet endpoint rate-limits bursts).
  private blockhash?: { value: string; fetchedAt: number };

  private async cachedBlockhash(): Promise<string> {
    if (!this.blockhash || Date.now() - this.blockhash.fetchedAt > 20_000) {
      this.blockhash = {
        value: (await this.connection.getLatestBlockhash()).blockhash,
        fetchedAt: Date.now(),
      };
    }
    return this.blockhash.value;
  }

  /** Build (or refresh) the epochDay -> DailyOddsMerkleRoots account map. */
  async refreshOddsRootsMap(): Promise<void> {
    const accounts = await this.connection.getProgramAccounts(this.program.programId, {
      dataSlice: { offset: 0, length: 10 },
    });
    const map = new Map<number, PublicKey>();
    for (const { pubkey, account } of accounts) {
      const data = Buffer.from(account.data);
      if (data.subarray(0, 8).toString("hex") !== ODDS_ROOTS_DISCRIMINATOR) continue;
      map.set(data.readUInt16LE(8), pubkey);
    }
    this.oddsRootsByDay = map;
    console.log(`[chain] odds roots map: ${map.size} days`);
  }

  async oddsRootsAccountForTs(tsMs: number): Promise<PublicKey | undefined> {
    const epochDay = Math.floor(tsMs / 86_400_000);
    if (!this.oddsRootsByDay.has(epochDay)) await this.refreshOddsRootsMap();
    return this.oddsRootsByDay.get(epochDay);
  }

  /**
   * Verify an odds update against the on-chain Merkle root by simulating the
   * program's validate_odds view instruction. Simulation success means the
   * proof chain (leaf -> batch sub-tree -> daily main tree root) is sound.
   */
  async validateOdds(validation: any): Promise<OddsValidationResult> {
    const o = validation.odds;
    const epochDay = Math.floor(o.Ts / 86_400_000);
    const rootsAccount = await this.oddsRootsAccountForTs(o.Ts);
    if (!rootsAccount) {
      return { ok: false, epochDay, rootsAccount: "", error: `no on-chain roots account for epochDay ${epochDay}` };
    }

    const oddsSnapshot = {
      fixtureId: new BN(o.FixtureId),
      messageId: o.MessageId,
      ts: new BN(o.Ts),
      bookmaker: o.Bookmaker,
      bookmakerId: o.BookmakerId,
      superOddsType: o.SuperOddsType,
      gameState: o.GameState ?? null,
      inRunning: o.InRunning,
      marketParameters: o.MarketParameters ?? null,
      marketPeriod: o.MarketPeriod ?? null,
      priceNames: o.PriceNames,
      prices: o.Prices,
    };

    const summary = {
      fixtureId: new BN(validation.summary.fixtureId),
      updateStats: {
        updateCount: validation.summary.updateStats.updateCount,
        minTimestamp: new BN(validation.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(validation.summary.updateStats.maxTimestamp),
      },
      oddsSubTreeRoot: validation.summary.oddsSubTreeRoot,
    };

    try {
      const tx = await this.program.methods
        .validateOdds(
          new BN(o.Ts),
          oddsSnapshot as any,
          summary as any,
          validation.subTreeProof,
          validation.mainTreeProof
        )
        .accounts({ dailyOddsMerkleRoots: rootsAccount })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })])
        .transaction();

      tx.feePayer = this.wallet.publicKey;
      tx.recentBlockhash = await this.cachedBlockhash();

      const sim = await this.connection.simulateTransaction(tx);
      if (sim.value.err) {
        return {
          ok: false,
          epochDay,
          rootsAccount: rootsAccount.toBase58(),
          error: JSON.stringify(sim.value.err),
          logs: sim.value.logs ?? undefined,
        };
      }
      return {
        ok: true,
        epochDay,
        rootsAccount: rootsAccount.toBase58(),
        unitsConsumed: sim.value.unitsConsumed,
      };
    } catch (e: any) {
      return { ok: false, epochDay, rootsAccount: rootsAccount.toBase58(), error: e.message };
    }
  }
}
