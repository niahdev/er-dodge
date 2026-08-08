import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildNoRecentRankResult,
  calculateScore,
  getPreviousRankSeasonFromGames,
} from "../netlify/functions/lib/analyzer.mjs";
import {
  getDakggStats,
  resetDakggStatsCacheForTests,
} from "../netlify/functions/lib/dakgg-stats.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DAKGG_STATS_FILE = path.resolve(
  here,
  "../data/dakgg_stats.json.gz",
);
process.env.DAKGG_STATS_URL = "http://127.0.0.1:9/unavailable";

async function artifact() {
  resetDakggStatsCacheForTests();
  return getDakggStats();
}

function stats(overrides = {}) {
  return {
    mmr: 3500,
    totalGames: 100,
    totalWins: 13,
    top3: 0.38,
    averageRank: 4.5,
    characterStats: [
      { characterCode: 72, totalGames: 65, wins: 10, top3: 30, averageRank: 4.2 },
      { characterCode: 1, totalGames: 35, wins: 3, top3: 8, averageRank: 5.1 },
    ],
    ...overrides,
  };
}

test("selects the most recent previous ranked season for fallback analysis", () => {
  const games = [
    { matchingMode: 3, seasonId: 32 },
    { matchingMode: 2, seasonId: 31 },
    { matchingMode: 3, seasonId: 30 },
    { matchingMode: 3, seasonId: 29 },
  ];
  assert.equal(getPreviousRankSeasonFromGames(games, 32), 30);
  assert.equal(getPreviousRankSeasonFromGames(games, 30), 29);
  assert.equal(getPreviousRankSeasonFromGames([], 32), null);
});

test("holds scoring when no ranked game exists in the fetched history", () => {
  const result = buildNoRecentRankResult("테스트", {
    seasonId: 30,
    seasonLabel: "시즌 6",
    totalGames: 100,
    fetchedGames: 20,
  });
  assert.equal(result.score, null);
  assert.equal(result.analysisStatus, "no_recent_rank");
  assert.equal(result.grade, "분석 보류");
  assert.equal(result.metrics.recentGames, 0);
  assert.equal(result.scoreBreakdown.length, 0);
  assert.match(result.comment, /최근 20게임/);
  assert.match(result.warnings[0], /일반게임/);
});

test("uses five deduction areas and a 100 point starting score", async () => {
  const recent = Array.from({ length: 20 }, () => ({
    characterNum: 72,
    damageToPlayer: 15000,
    teamKill: 8,
    viewContribution: 22,
  }));
  const [score, , breakdown, protectedVerdict] = calculateScore(
    stats(),
    recent,
    await artifact(),
  );
  assert.equal(breakdown.length, 5);
  assert.equal(
    score,
    100 - breakdown.reduce((sum, item) => sum + item.deduction, 0),
  );
  assert.equal(protectedVerdict, false);
});

test("protects accounts below 20 total ranked games", async () => {
  const [score, comment, , protectedVerdict] = calculateScore(
    stats({ totalGames: 19, characterStats: [{ characterCode: 72, totalGames: 19 }] }),
    [],
    await artifact(),
  );
  assert.ok(score >= 0);
  assert.equal(protectedVerdict, true);
  assert.match(comment, /20판 미만/);
});

test("does not penalize missing or suspicious zero recent metrics", async () => {
  const [, , breakdown, protectedVerdict] = calculateScore(
    stats(),
    Array.from({ length: 20 }, () => ({
      characterNum: 72,
      damageToPlayer: 0,
      viewContribution: 0,
    })),
    await artifact(),
  );
  const performance = breakdown.find((item) => item.label === "캐릭터 성과");
  const vision = breakdown.find((item) => item.label === "시야점수");
  assert.equal(performance.deduction, 0);
  assert.equal(vision.deduction, 0);
  assert.equal(protectedVerdict, true);
});

test("excludes missing season metrics instead of coercing them to zero", async () => {
  const recent = Array.from({ length: 20 }, () => ({
    characterNum: 72,
    damageToPlayer: 15000,
    teamKill: 8,
    viewContribution: 22,
  }));
  const [, , breakdown, protectedVerdict] = calculateScore(
    stats({ totalWins: null, top3: null, averageRank: null }),
    recent,
    await artifact(),
  );
  assert.equal(
    breakdown.find((item) => item.label === "승률").deduction,
    0,
  );
  assert.equal(
    breakdown.find((item) => item.label === "TOP3").deduction,
    0,
  );
  assert.equal(
    breakdown.find((item) => item.label === "평균순위").deduction,
    0,
  );
  assert.equal(protectedVerdict, true);
});

test("treats a measured zero team-kill average as performance, not missing data", async () => {
  const data = await artifact();
  const baseline = data.tiers.gold.characters["72"];
  assert.ok(baseline.averageTeamKills > 0);
  const recent = Array.from({ length: 20 }, () => ({
    characterNum: 72,
    damageToPlayer: baseline.averageDamage,
    teamKill: 0,
    viewContribution: 22,
  }));
  const [, , breakdown] = calculateScore(stats(), recent, data);
  assert.equal(
    breakdown.find((item) => item.label === "캐릭터 성과").deduction,
    23,
  );
});

test("applies the maximum configured deduction in every area", async () => {
  const recent = Array.from({ length: 20 }, () => ({
    characterNum: 72,
    damageToPlayer: 1,
    teamKill: 1,
    viewContribution: 1,
  }));
  const [score, , breakdown, protectedVerdict] = calculateScore(
    stats({ totalWins: 0, top3: 0, averageRank: 7 }),
    recent,
    await artifact(),
  );
  assert.deepEqual(
    breakdown.map((item) => item.deduction),
    [23, 20, 25, 10, 20],
  );
  assert.equal(score, 2);
  assert.equal(protectedVerdict, false);
});

test("requires ten season games and three recent games for character performance", async () => {
  const data = await artifact();
  const recent = Array.from({ length: 3 }, () => ({
    characterNum: 72,
    damageToPlayer: 1,
    teamKill: 1,
    viewContribution: 20,
  }));
  const [, , eligibleBreakdown] = calculateScore(stats(), recent, data);
  assert.equal(
    eligibleBreakdown.find((item) => item.label === "캐릭터 성과").deduction,
    23,
  );

  const [, , excludedBreakdown, protectedVerdict] = calculateScore(
    stats({
      characterStats: [
        { characterCode: 72, totalGames: 9, wins: 1, top3: 3, averageRank: 4.2 },
      ],
    }),
    recent,
    data,
  );
  assert.equal(
    excludedBreakdown.find((item) => item.label === "캐릭터 성과").deduction,
    0,
  );
  assert.equal(protectedVerdict, false);
});

test("ignores characters below three recent games and weights eligible deductions", async () => {
  const recent = [
    ...Array.from({ length: 10 }, () => ({
      characterNum: 72,
      damageToPlayer: 1,
      teamKill: 1,
      viewContribution: 20,
    })),
    ...Array.from({ length: 6 }, () => ({
      characterNum: 1,
      damageToPlayer: 1,
      teamKill: 1,
      viewContribution: 20,
    })),
    ...Array.from({ length: 2 }, () => ({
      characterNum: 2,
      damageToPlayer: 1,
      teamKill: 1,
      viewContribution: 20,
    })),
    ...Array.from({ length: 2 }, () => ({
      characterNum: 3,
      damageToPlayer: 1,
      teamKill: 1,
      viewContribution: 20,
    })),
  ];
  const [, , breakdown] = calculateScore(stats(), recent, await artifact());
  const performance = breakdown.find((item) => item.label === "캐릭터 성과");
  assert.equal(performance.deduction, 18.4);
  assert.match(performance.detail, /유효 16\/20판/);
  assert.doesNotMatch(performance.detail, /2판/);
});

test("uses a 15 percent absolute win-rate baseline", async () => {
  const recent = Array.from({ length: 20 }, () => ({
    characterNum: 72,
    damageToPlayer: 22000,
    teamKill: 12,
    viewContribution: 35,
  }));
  const data = await artifact();
  for (const [winRate, expectedDeduction] of [
    [0.15, 0],
    [0.12, 4],
    [0.1, 9],
    [0.08, 15],
    [0.079, 20],
  ]) {
    const [, , breakdown] = calculateScore(
      stats({ totalGames: 1000, totalWins: winRate * 1000 }),
      recent,
      data,
    );
    assert.equal(
      breakdown.find((item) => item.label === "승률").deduction,
      expectedDeduction,
    );
  }
});

test("penalizes low absolute win and TOP3 rates", async () => {
  const recent = Array.from({ length: 20 }, () => ({
    characterNum: 72,
    damageToPlayer: 22000,
    teamKill: 12,
    viewContribution: 35,
  }));
  const [score, , breakdown] = calculateScore(
    stats({
      mmr: 5500,
      totalGames: 1000,
      totalWins: 73,
      top3: 0.325,
      averageRank: 4.66,
      characterStats: [{ characterCode: 72, totalGames: 1000 }],
    }),
    recent,
    await artifact(),
  );
  assert.equal(
    breakdown.find((item) => item.label === "승률").deduction,
    20,
  );
  assert.equal(
    breakdown.find((item) => item.label === "TOP3").deduction,
    17,
  );
  assert.equal(
    breakdown.find((item) => item.label === "평균순위").deduction,
    15,
  );
  assert.ok(score <= 54);
});

test("uses the absolute 3.7 to 4.7 placement scale", async () => {
  const recent = Array.from({ length: 20 }, () => ({
    characterNum: 72,
    damageToPlayer: 22000,
    teamKill: 12,
    viewContribution: 35,
  }));
  const data = await artifact();
  for (const [averageRank, expectedDeduction] of [
    [3.7, 0],
    [3.71, 5],
    [3.9, 5],
    [4.3, 10],
    [4.69, 15],
    [4.7, 20],
  ]) {
    const [, , breakdown] = calculateScore(
      stats({ averageRank }),
      recent,
      data,
    );
    assert.equal(
      breakdown.find((item) => item.label === "평균순위").deduction,
      expectedDeduction,
    );
  }
});

test("uses the harsher TOP3 deduction between absolute and tier-relative rules", async () => {
  const recent = Array.from({ length: 20 }, () => ({
    characterNum: 72,
    damageToPlayer: 22000,
    teamKill: 12,
    viewContribution: 35,
  }));
  const data = await artifact();
  for (const [top3, expectedDeduction] of [
    [0.45, 0],
    [0.4, 5],
    [0.35, 10],
    [0.3, 17],
    [0.299, 25],
  ]) {
    const [, , breakdown] = calculateScore(
      stats({ top3 }),
      recent,
      data,
    );
    assert.equal(
      breakdown.find((item) => item.label === "TOP3").deduction,
      expectedDeduction,
    );
  }
});


test("comments on the strongest good metric for stable scores", async () => {
  const recent = Array.from({ length: 20 }, () => ({
    characterNum: 72,
    damageToPlayer: 22000,
    teamKill: 12,
    viewContribution: 35,
  }));
  const [score, comment] = calculateScore(
    stats({ totalGames: 1000, totalWins: 150, top3: 0.4, averageRank: 3.9 }),
    recent,
    await artifact(),
  );
  assert.ok(score >= 55 && score < 95);
  assert.match(comment, /\uC88B\uC2B5\uB2C8\uB2E4/);
});

test("uses a clear praise comment for near perfect scores", async () => {
  const recent = Array.from({ length: 20 }, () => ({
    characterNum: 72,
    damageToPlayer: 26000,
    teamKill: 14,
    viewContribution: 40,
  }));
  const [score, comment] = calculateScore(
    stats({ totalGames: 1000, totalWins: 180, top3: 0.5, averageRank: 3.6 }),
    recent,
    await artifact(),
  );
  assert.ok(score >= 95);
  assert.equal(comment, "\uC815\uB9D0 \uC88B\uC740 \uD300\uC6D0\uC785\uB2C8\uB2E4!");
});

test("comments on the weakest bad metric for caution scores", async () => {
  const recent = Array.from({ length: 20 }, () => ({
    characterNum: 72,
    damageToPlayer: 1,
    teamKill: 1,
    viewContribution: 1,
  }));
  const [score, comment] = calculateScore(
    stats({ totalGames: 1000, totalWins: 0, top3: 0, averageRank: 7 }),
    recent,
    await artifact(),
  );
  assert.ok(score < 55);
  assert.match(comment, /\uB0AE\uC2B5\uB2C8\uB2E4/);
});
