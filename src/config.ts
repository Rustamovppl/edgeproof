import * as dotenv from "dotenv";
import * as path from "path";

// Credentials live in the repo-root .env shared with the setup scripts
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });
dotenv.config(); // allow local overrides via edgeproof/.env

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  apiBaseUrl: process.env.TXLINE_API_BASE_URL ?? "https://txline-dev.txodds.com/api",
  guestStartUrl: "https://txline-dev.txodds.com/auth/guest/start",
  apiToken: required("TXLINE_API_TOKEN"),
  initialJwt: process.env.TXLINE_JWT ?? "",
  rpcUrl: process.env.SOLANA_DEVNET_RPC ?? "https://api.devnet.solana.com",
  programId: process.env.TXORACLE_PROGRAM_ID ?? "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
  // Either a path to a keypair file or the JSON key array itself (for
  // platforms like Render where secrets are env vars, not files).
  walletPath: process.env.BURNER_WALLET ?? "",
  walletJson: process.env.BURNER_WALLET_JSON ?? "",
};

if (!config.walletPath && !config.walletJson) {
  throw new Error("Set BURNER_WALLET (keypair file path) or BURNER_WALLET_JSON (key array)");
}
