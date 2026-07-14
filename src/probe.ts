// End-to-end milestone probe:
// fixtures snapshot -> odds snapshot -> Merkle proof -> on-chain validate_odds simulation

import { txline } from "./txline/client";
import { ChainValidator } from "./chain/validator";

async function main() {
  console.log("1) fixtures snapshot...");
  const fixtures = await txline.fixturesSnapshot();
  console.log(`   ${fixtures.length} fixtures`);
  const upcoming = fixtures.filter((f: any) => f.Competition === "World Cup");
  console.log(`   World Cup fixtures: ${upcoming.map((f: any) => `${f.Participant1}-${f.Participant2} (#${f.FixtureId})`).join(", ")}`);

  console.log("2) hunting for a fixture with odds...");
  let sampleOdds: any = null;
  let sampleFixture: any = null;
  for (const f of [...upcoming, ...fixtures.filter((x: any) => x.Competition !== "World Cup")]) {
    try {
      const odds = await txline.oddsSnapshot(f.FixtureId, Date.now());
      if (Array.isArray(odds) && odds.length > 0) {
        sampleOdds = odds[0];
        sampleFixture = f;
        console.log(`   fixture #${f.FixtureId} ${f.Participant1}-${f.Participant2}: ${odds.length} odds updates`);
        break;
      }
    } catch {
      // 403/404 on fixtures without odds coverage — keep scanning
    }
  }
  if (!sampleOdds) throw new Error("no odds found on any fixture");
  console.log("   sample odds:", JSON.stringify(sampleOdds));

  console.log("3) requesting Merkle proof from /odds/validation...");
  const validation = await txline.oddsValidation(sampleOdds.MessageId, sampleOdds.Ts);
  console.log(`   proof: subTree ${validation.subTreeProof.length} nodes, mainTree ${validation.mainTreeProof.length} nodes`);

  console.log("4) simulating validate_odds on devnet...");
  const validator = new ChainValidator();
  const result = await validator.validateOdds(validation);
  console.log("   result:", JSON.stringify(result, null, 2));

  if (result.ok) {
    console.log(`\nPROOF OK — odds tick ${sampleOdds.MessageId} is anchored on-chain (CU: ${result.unitsConsumed})`);
  } else {
    console.log("\nPROOF FAILED");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.response?.data ?? e);
  process.exit(1);
});
