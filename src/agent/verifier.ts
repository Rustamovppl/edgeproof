import { txline } from "../txline/client";
import { ChainValidator } from "../chain/validator";
import { TickRef } from "./types";

type Job = {
  ref: TickRef;
  notBefore: number;
  attempts: number;
  onDone: (ref: TickRef) => void;
};

/**
 * Verifies odds ticks against on-chain Merkle roots.
 *
 * Roots are published at the end of each 5-minute UTC interval, so a live
 * tick can only be proven once its interval closes. Jobs are therefore
 * scheduled at tick_ts rounded up to the next interval boundary plus a grace
 * period, and retried a few times if the proof or root is not yet available.
 */
export class VerifierQueue {
  private queue: Job[] = [];
  private timer?: NodeJS.Timeout;
  static readonly GRACE_MS = 90 * 1000;
  static readonly RETRY_MS = 60 * 1000;
  static readonly MAX_ATTEMPTS = 8;

  constructor(private validator: ChainValidator, private onStatus: (msg: string) => void) {}

  start() {
    this.timer = setInterval(() => this.drain().catch(() => {}), 15_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  enqueue(ref: TickRef, onDone: (ref: TickRef) => void) {
    const intervalEnd = (Math.floor(ref.ts / 300_000) + 1) * 300_000;
    const notBefore = intervalEnd + VerifierQueue.GRACE_MS;
    this.queue.push({ ref, notBefore, attempts: 0, onDone });
    this.onStatus(
      `verification of ${ref.messageId} scheduled for ${new Date(notBefore).toISOString().slice(11, 19)}Z`
    );
  }

  pendingCount(): number {
    return this.queue.length;
  }

  private draining = false;

  private async drain() {
    if (this.draining) return; // a slow pass must not overlap the next timer fire
    this.draining = true;
    try {
      await this.drainOnce();
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce() {
    const now = Date.now();
    const due = this.queue.filter((j) => j.notBefore <= now);
    for (const job of due) {
      try {
        const validation = await txline.oddsValidation(job.ref.messageId, job.ref.ts);
        const result = await this.validator.validateOdds(validation);
        if (result.ok) {
          job.ref.verification = "verified";
          job.ref.rootsAccount = result.rootsAccount;
          job.ref.unitsConsumed = result.unitsConsumed;
          job.ref.verifiedAt = Date.now();
          this.remove(job);
          job.onDone(job.ref);
          this.onStatus(`PROOF OK ${job.ref.messageId} (CU ${result.unitsConsumed})`);
          continue;
        }
        throw new Error(result.error ?? "simulation failed");
      } catch (e: any) {
        job.attempts++;
        if (job.attempts >= VerifierQueue.MAX_ATTEMPTS) {
          job.ref.verification = "failed";
          job.ref.error = e.response?.status ? `HTTP ${e.response.status}` : e.message;
          this.remove(job);
          job.onDone(job.ref);
          this.onStatus(`PROOF FAILED ${job.ref.messageId}: ${job.ref.error}`);
        } else {
          job.notBefore = Date.now() + VerifierQueue.RETRY_MS;
        }
      }
    }
  }

  private remove(job: Job) {
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
  }
}
