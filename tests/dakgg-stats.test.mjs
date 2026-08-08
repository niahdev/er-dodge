import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareMostCharacters,
  getCachedDakggStats,
  getDakggStats,
  resetDakggStatsCacheForTests,
  tierForMmr,
} from "../netlify/functions/lib/dakgg-stats.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DAKGG_STATS_FILE = path.resolve(
  here,
  "../data/dakgg_stats.json.gz",
);
process.env.DAKGG_STATS_URL = "http://127.0.0.1:9/unavailable";

test("maps MMR to a DAK.GG tier key", () => {
  assert.equal(tierForMmr(3500), "gold");
  assert.equal(tierForMmr(3600), "platinum");
  assert.equal(tierForMmr(6400), "meteorite_plus");
  assert.equal(tierForMmr(7400), "mithril_plus");
  assert.equal(tierForMmr(7400, 1000), "in1000");
  assert.equal(tierForMmr(7400, 1001), "mithril_plus");
});

test("loads the bundled cache explicitly for previous-season analysis", async () => {
  resetDakggStatsCacheForTests();
  const data = await getCachedDakggStats();
  assert.equal(data.schemaVersion, 1);
  assert.ok(data.tiers.gold.characters["72"]);
});

test("loads the artifact fallback and compares a most-played character", async () => {
  resetDakggStatsCacheForTests();
  const data = await getDakggStats();
  const comparison = compareMostCharacters(
    {
      mmr: 3500,
      totalGames: 100,
      characterStats: [
        {
          characterCode: 72,
          totalGames: 100,
          wins: 15,
          top3: 40,
          averageRank: 4.1,
        },
      ],
    },
    [{ characterNum: 72, damageToPlayer: 16000 }],
    data,
  );

  assert.equal(comparison.tierKey, "gold");
  assert.equal(comparison.characters[0].characterName, "카티야");
  assert.equal(comparison.characters[0].games, 100);
  assert.ok(comparison.characters[0].baselineGames > 1000);
  assert.ok(comparison.characters[0].averageDamageDelta > 0);
});
