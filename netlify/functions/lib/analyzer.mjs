import {
  compareMostCharacters,
  getDakggStats,
  tierForMmr,
} from "./dakgg-stats.mjs";

const BASE_URL = "https://open-api.bser.io";
const REQUEST_INTERVAL_MS = 1100;
const REQUEST_TIMEOUT_MS = 10000;

export class AnalyzerError extends Error {}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let erScheduleTail = Promise.resolve();
let nextErRequestStartAt = 0;

async function reserveErRequestStart() {
  const reservation = erScheduleTail.then(async () => {
    const waitMs = Math.max(0, nextErRequestStartAt - Date.now());
    if (waitMs > 0) await delay(waitMs);
    nextErRequestStartAt = Date.now() + REQUEST_INTERVAL_MS;
  });
  erScheduleTail = reservation.catch(() => undefined);
  return reservation;
}

class TtlSingleFlightCache {
  constructor({ maxEntries = 1000 } = {}) {
    this.maxEntries = maxEntries;
    this.values = new Map();
    this.inFlight = new Map();
  }

  get(key) {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.values.size >= this.maxEntries && !this.values.has(key)) {
      this.values.delete(this.values.keys().next().value);
    }
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  async getOrLoad(key, { ttlMs, loader, cacheErrors = false }) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const pending = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (cacheErrors || !value?.error) return this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, pending);
    return pending;
  }
}

const uidCache = new TtlSingleFlightCache({ maxEntries: 5000 });
const gamesCache = new TtlSingleFlightCache({ maxEntries: 5000 });
const seasonStatsCache = new TtlSingleFlightCache({ maxEntries: 5000 });
const seasonIdCache = new TtlSingleFlightCache({ maxEntries: 4 });
const analysisCache = new TtlSingleFlightCache({ maxEntries: 5000 });
const ANALYSIS_CACHE_VERSION = "2026-08-09.1";
const CURRENT_SEASON_MIN_GAMES = 20;

function normalizeNicknameKey(nickname) {
  return String(nickname || "").normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
}

async function safeGet(path, params = {}) {
  const apiKey = process.env.ER_API_KEY;
  if (!apiKey) {
    throw new AnalyzerError("서버에 API 키가 설정되지 않았습니다.");
  }

  const url = new URL(path, BASE_URL);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });

  let response;
  try {
    await reserveErRequestStart();
    response = await fetch(url, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      throw new AnalyzerError(
        "전적 서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
    throw new AnalyzerError("전적 서버에 연결하지 못했습니다.");
  }

  if (response.status === 403 || response.status === 429) {
    throw new AnalyzerError("조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.");
  }
  if (response.status === 404) {
    throw new AnalyzerError("플레이어 또는 전적을 찾을 수 없습니다.");
  }
  if (response.status >= 500) {
    throw new AnalyzerError("전적 서버에 일시적인 문제가 발생했습니다.");
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new AnalyzerError("전적 서버가 올바르지 않은 응답을 보냈습니다.");
  }

  if (!response.ok || (data.code != null && data.code !== 200)) {
    throw new AnalyzerError("전적을 조회하지 못했습니다. 닉네임을 확인해 주세요.");
  }
  return data;
}

async function getUid(nickname) {
  return uidCache.getOrLoad(`uid:${normalizeNicknameKey(nickname)}`, {
    ttlMs: 24 * 60 * 60 * 1000,
    loader: async () => {
      const data = await safeGet("/v1/user/nickname", { query: nickname });
      const uid = data.user?.userId ?? data.user?.uid;
      if (!uid) {
        throw new AnalyzerError("해당 닉네임의 플레이어를 찾을 수 없습니다.");
      }
      return uid;
    },
  });
}

async function getGames(uid, count = 20) {
  return gamesCache.getOrLoad(`games:${uid}:${count}`, {
    ttlMs: 60 * 1000,
    loader: async () => {
      const data = await safeGet(`/v1/user/games/uid/${uid}`);
      if (!Array.isArray(data.userGames)) {
        throw new AnalyzerError("경기 기록을 불러오지 못했습니다.");
      }

      const games = [...data.userGames];
      if (games.length < 10 || games.length >= count) return games.slice(0, count);

      const nextGameId = games.at(-1)?.gameId;
      if (nextGameId == null) return games.slice(0, count);

      try {
        const nextData = await safeGet(`/v1/user/games/uid/${uid}`, {
          next: nextGameId,
        });
        if (Array.isArray(nextData.userGames)) {
          const seenIds = new Set(games.map((game) => game.gameId));
          games.push(
            ...nextData.userGames.filter((game) => !seenIds.has(game.gameId)),
          );
        }
      } catch (error) {
        console.warn("Could not load the second match-history page:", error.message);
      }

      return games.slice(0, count);
    },
  });
}

function getRankSeasonFromGames(games) {
  const game = games.find(
    (item) => Number(item.matchingMode) === 3 && Number(item.seasonId) > 0,
  );
  return game ? Number(game.seasonId) : null;
}

async function getCurrentSeasonId() {
  return seasonIdCache.getOrLoad("current-season", {
    ttlMs: 6 * 60 * 60 * 1000,
    loader: async () => {
      const data = await safeGet("/v2/data/Season");
      if (!Array.isArray(data.data)) {
        throw new AnalyzerError("현재 시즌 정보를 불러오지 못했습니다.");
      }

      const current = data.data.find((season) => Number(season.isCurrent) === 1);
      const seasonId = Number(current?.seasonID ?? current?.seasonId);
      if (!Number.isInteger(seasonId) || seasonId <= 0) {
        throw new AnalyzerError("현재 시즌 정보를 찾을 수 없습니다.");
      }

      return seasonId;
    },
  });
}

export function getPreviousRankSeasonFromGames(games, currentSeasonId) {
  const game = games.find(
    (item) =>
      Number(item.matchingMode) === 3 &&
      Number(item.seasonId) > 0 &&
      Number(item.seasonId) < Number(currentSeasonId),
  );
  return game ? Number(game.seasonId) : null;
}

async function getSeasonStats(uid, seasonId) {
  return seasonStatsCache.getOrLoad(`season-stats:${uid}:${seasonId}`, {
    ttlMs: 2 * 60 * 1000,
    loader: async () => {
      const data = await safeGet(`/v2/user/stats/uid/${uid}/${seasonId}/3`);
      if (!Array.isArray(data.userStats) || !data.userStats.length) {
        throw new AnalyzerError("해당 시즌의 랭크 통계를 찾을 수 없습니다.");
      }
      return data.userStats[0];
    },
  });
}

function recentRankGames(games, seasonId, count = 20) {
  return games
    .filter(
      (game) =>
        Number(game.matchingMode) === 3 &&
        Number(game.seasonId) === Number(seasonId),
    )
    .slice(0, count);
}

function formatIngameSeason(seasonId) {
  const internalId = Number(seasonId);
  if (!Number.isInteger(internalId)) return "시즌 정보 없음";

  // Open API counts nine legacy seasons before the current in-game numbering.
  const internalSeason = Math.floor(internalId / 2) + 1;
  const ingameSeason = internalSeason - 9;
  if (ingameSeason <= 0) return `레거시 시즌 (ID ${internalId})`;
  return `${internalId % 2 === 0 ? "프리시즌" : "시즌"} ${ingameSeason}`;
}

function scoutingActivity(game) {
  return [
    "useSecurityConsole",
    "addSurveillanceCamera",
    "addTelephotoCamera",
    "removeSurveillanceCamera",
    "removeTelephotoCamera",
  ].reduce((sum, field) => sum + (Number(game[field]) || 0), 0);
}

function validateStats(stats) {
  if (!Number.isFinite(Number(stats?.totalGames)) || Number(stats.totalGames) <= 0) {
    throw new AnalyzerError("분석할 수 있는 랭크 전적이 없습니다.");
  }
  if (!Array.isArray(stats.characterStats) || !stats.characterStats.length) {
    throw new AnalyzerError("캐릭터 통계가 없어 분석할 수 없습니다.");
  }
}

function legacyCalculateScore(stats, recentGames) {
  validateStats(stats);

  const totalGames = Number(stats.totalGames);
  const averageRank = Number(stats.averageRank);
  const winRate = Number(stats.totalWins) / totalGames;
  const top3 = Number(stats.top3) || 0;
  const mostUsed = Math.max(
    ...stats.characterStats.map((character) => Number(character.totalGames) || 0),
  );
  const mostUsedRatio = mostUsed / totalGames;
  const breakdown = new Map();

  const rankScore =
    averageRank <= 3.3 ? 15 : averageRank <= 3.8 ? 12 : averageRank <= 4.3 ? 8 : averageRank <= 4.8 ? 4 : 0;
  const rankRule =
    rankScore === 15
      ? "3.3위 이하"
      : rankScore === 12
        ? "3.8위 이하"
        : rankScore === 8
          ? "4.3위 이하"
          : rankScore === 4
            ? "4.8위 이하"
            : "4.8위 초과";
  breakdown.set("평균 순위", [rankScore, 15, `${averageRank.toFixed(2)}위 · ${rankRule}`]);

  const winScore =
    winRate >= 0.22 ? 15 : winRate >= 0.18 ? 12 : winRate >= 0.14 ? 8 : winRate >= 0.1 ? 4 : 0;
  const winRule =
    winScore === 15
      ? "22% 이상"
      : winScore === 12
        ? "18% 이상"
        : winScore === 8
          ? "14% 이상"
          : winScore === 4
            ? "10% 이상"
            : "10% 미만";
  breakdown.set("승률", [winScore, 15, `${(winRate * 100).toFixed(1)}% · ${winRule}`]);

  const top3Score =
    top3 >= 0.6 ? 15 : top3 >= 0.5 ? 12 : top3 >= 0.4 ? 8 : top3 >= 0.3 ? 4 : 0;
  const top3Rule =
    top3Score === 15
      ? "60% 이상"
      : top3Score === 12
        ? "50% 이상"
        : top3Score === 8
          ? "40% 이상"
          : top3Score === 4
            ? "30% 이상"
            : "30% 미만";
  breakdown.set("상위권 진입", [
    top3Score,
    15,
    `TOP 3 ${(top3 * 100).toFixed(1)}% · ${top3Rule}`,
  ]);

  let focusScore = 3;
  if (totalGames >= 50) {
    focusScore =
      mostUsedRatio >= 0.25 && mostUsedRatio <= 0.45
        ? 10
        : mostUsedRatio > 0.45 && mostUsedRatio <= 0.6
          ? 8
          : mostUsedRatio > 0.6
            ? 5
            : mostUsedRatio >= 0.15
              ? 7
              : 4;
  }
  const focusDetail =
    totalGames < 50
      ? `${totalGames}판 · 50판 미만 표본`
      : mostUsedRatio > 0.6
        ? `${(mostUsedRatio * 100).toFixed(1)}% · 원챔 성향`
        : mostUsedRatio < 0.15
          ? `${(mostUsedRatio * 100).toFixed(1)}% · 이것저것 성향`
          : mostUsedRatio <= 0.25
            ? `${(mostUsedRatio * 100).toFixed(1)}% · 15~25% 구간`
            : mostUsedRatio <= 0.45
              ? `${(mostUsedRatio * 100).toFixed(1)}% · 권장 집중 구간`
              : `${(mostUsedRatio * 100).toFixed(1)}% · 45~60% 구간`;
  breakdown.set("캐릭터 집중도", [focusScore, 10, focusDetail]);

  let averageRecentRank = null;
  let averageRecentDamage = null;
  let formScore = 0;
  let recentRankScore = 0;
  let recentDamageScore = 0;
  if (recentGames.length) {
    averageRecentRank =
      recentGames.reduce((sum, game) => sum + (Number(game.gameRank) || 9), 0) /
      recentGames.length;
    averageRecentDamage =
      recentGames.reduce((sum, game) => sum + (Number(game.damageToPlayer) || 0), 0) /
      recentGames.length;

    recentRankScore =
      averageRecentRank <= 3.3
        ? 20
        : averageRecentRank <= 4
          ? 15
          : averageRecentRank <= 4.7
            ? 9
            : averageRecentRank <= 5.3
              ? 4
              : 0;
    recentDamageScore =
      averageRecentDamage >= 13000
        ? 20
        : averageRecentDamage >= 11000
          ? 15
          : averageRecentDamage >= 9000
            ? 10
            : averageRecentDamage >= 7500
              ? 5
              : 0;
    formScore = recentRankScore + recentDamageScore;
  }
  const formDetail = recentGames.length
    ? `평균 ${averageRecentRank.toFixed(2)}위 +${recentRankScore}/20 · 피해량 ${Math.round(averageRecentDamage).toLocaleString("ko-KR")} +${recentDamageScore}/20`
    : "현재 시즌 최근 랭크 기록 없음";
  breakdown.set("최근 폼", [formScore, 40, formDetail]);

  let scoutingScore = 0;
  if (recentGames.length) {
    const averageScouting =
      recentGames.reduce((sum, game) => sum + scoutingActivity(game), 0) /
      recentGames.length;
    scoutingScore =
      averageScouting >= 6 ? 5 : averageScouting >= 4 ? 4 : averageScouting >= 2.5 ? 3 : averageScouting >= 1 ? 1 : 0;
  }
  const scoutingDetail = recentGames.length
    ? `경기당 평균 ${(
        recentGames.reduce((sum, game) => sum + scoutingActivity(game), 0) /
        recentGames.length
      ).toFixed(2)}회 · ${scoutingScore}점 구간`
    : "현재 시즌 최근 랭크 기록 없음";
  breakdown.set("시야·정찰 활동", [scoutingScore, 5, scoutingDetail]);

  let penalties = 0;
  const penaltyReasons = [];
  if (totalGames >= 50) {
    if (winRate < 0.08) {
      penalties += 12;
      penaltyReasons.push("승률 8% 미만 -12");
    } else if (winRate < 0.1) {
      penalties += 7;
      penaltyReasons.push("승률 10% 미만 -7");
    }
  }
  if (recentGames.length) {
    if (recentGames.length >= 10) {
      if (averageRecentRank > 5.8) {
        penalties += 10;
        penaltyReasons.push(`최근 평균 ${averageRecentRank.toFixed(2)}위 -10`);
      } else if (averageRecentRank > 5.3) {
        penalties += 5;
        penaltyReasons.push(`최근 평균 ${averageRecentRank.toFixed(2)}위 -5`);
      }
      if (averageRecentDamage < 7000) {
        penalties += 8;
        penaltyReasons.push(
          `최근 피해량 ${Math.round(averageRecentDamage).toLocaleString("ko-KR")} -8`,
        );
      } else if (averageRecentDamage < 8000) {
        penalties += 4;
        penaltyReasons.push(
          `최근 피해량 ${Math.round(averageRecentDamage).toLocaleString("ko-KR")} -4`,
        );
      }
    }
    if (averageRank > 5.2 && averageRecentRank > 5.8) {
      penalties += 8;
      penaltyReasons.push("시즌·최근 평균 순위 동시 저조 -8");
    }
    if (
      recentGames.length >= 20 &&
      recentGames.slice(0, 20).filter((game) => (Number(game.gameRank) || 9) <= 3).length < 4
    ) {
      penalties += 5;
      const recentTop3Count = recentGames
        .slice(0, 20)
        .filter((game) => (Number(game.gameRank) || 9) <= 3).length;
      penaltyReasons.push(`최근 20경기 TOP 3 ${recentTop3Count}회 -5`);
    }
  }

  const performanceDeduction = [...breakdown.values()].reduce(
    (sum, [value, maximum]) => sum + (maximum - value),
    0,
  );
  const baseScore = Math.max(0, 100 - performanceDeduction);
  const rawPenalties = penalties;
  penalties = Math.min(penalties, 25);
  const score = Math.max(0, 100 - performanceDeduction - penalties);
  if (penalties) {
    breakdown.set("추가 감점", [
      -penalties,
      25,
      `${penaltyReasons.join(" · ")}${rawPenalties > 25 ? " · 최대 -25 적용" : ""}${baseScore < penalties ? " · 최종 점수 0점 하한 적용" : ""}`,
    ]);
  }

  let weakest = null;
  let weakestRatio = Infinity;
  for (const [label, [value, maximum]] of breakdown) {
    const ratio = value / maximum;
    if (ratio < weakestRatio) {
      weakest = label;
      weakestRatio = ratio;
    }
  }

  const comments = {
    "평균 순위": "평균 순위가 아쉽습니다.",
    "승률": "승률이 낮습니다.",
    "상위권 진입": "상위권 진입 비율이 낮습니다.",
    "캐릭터 집중도": "캐릭터 사용 성향이 점수에 반영됐습니다.",
    "최근 폼": "최근 경기력이 불안합니다.",
    "시야·정찰 활동": "최근 시야·정찰 활동이 부족합니다.",
    "추가 감점": "추가 확인이 필요한 지표가 감점에 반영됐습니다.",
  };
  const scoreBreakdown = [...breakdown].map(([label, [value, maximum, detail]]) => ({
    label,
    score: value,
    maxScore: maximum,
    isPenalty: label === "추가 감점",
    detail,
  }));
  let comment = score >= 35 ? "전반적인 지표가 안정적입니다." : comments[weakest];
  if (score < 35 && weakest === "캐릭터 집중도") {
    if (totalGames < 50) {
      comment = "표본이 적어 캐릭터 성향을 판단하기 어렵습니다.";
    } else if (mostUsedRatio > 0.6) {
      comment = "한 캐릭터를 고집하는 원챔 성향입니다.";
    } else if (mostUsedRatio < 0.15) {
      comment = "여러 캐릭터를 이것저것 사용하는 성향입니다.";
    }
  }
  return [score, comment, scoreBreakdown];
}

const TIER_GROUPS = {
  iron: "iron_bronze",
  bronze: "iron_bronze",
  silver: "silver_gold",
  gold: "silver_gold",
  platinum: "platinum",
  platinum_plus: "platinum",
  diamond_plus: "diamond_plus",
  meteorite_plus: "meteorite_plus",
  mithril_plus: "mithril_plus",
  in1000: "mithril_plus",
};
const PERFORMANCE_THRESHOLDS = {
  iron_bronze: [1, 0.98, 0.94, 0.88],
  silver_gold: [1, 0.97, 0.92, 0.86],
  platinum: [1, 0.95, 0.89, 0.83],
  diamond_plus: [1, 0.93, 0.86, 0.8],
  meteorite_plus: [1, 0.92, 0.84, 0.78],
  mithril_plus: [1, 0.9, 0.82, 0.76],
};
const VISION_THRESHOLDS = {
  iron_bronze: [1, 0.94, 0.86, 0.75],
  silver_gold: [1, 0.98, 0.92, 0.84],
  platinum: [1, 0.96, 0.9, 0.82],
  diamond_plus: [1, 0.94, 0.87, 0.79],
  meteorite_plus: [1, 0.92, 0.85, 0.77],
  mithril_plus: [1, 0.9, 0.82, 0.74],
};
function tierAverage(tier, field) {
  let weightedSum = 0;
  let gameSum = 0;
  for (const baseline of Object.values(tier.characters)) {
    const games = Number(baseline.games);
    const value = Number(baseline[field]);
    if (Number.isFinite(games) && games > 0 && Number.isFinite(value)) {
      weightedSum += games * value;
      gameSum += games;
    }
  }
  return gameSum ? weightedSum / gameSum : null;
}

function optionalNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function recentFieldAverage(recentGames, field, { allowZero = false } = {}) {
  const values = recentGames
    .map((game) => optionalNumber(game[field]))
    .filter((value) => value != null);
  if (!values.length || (!allowZero && Math.max(...values) <= 0)) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deductionBand(value, thresholds, deductions, lowerIsBetter = false) {
  if (!Number.isFinite(value)) return [0, "감점 제외"];
  const labels = ["감점 없음", "약한 감점", "중간 감점", "큰 감점"];
  for (let index = 0; index < thresholds.length; index += 1) {
    const passed = lowerIsBetter
      ? value <= thresholds[index]
      : value >= thresholds[index];
    if (passed) return [deductions[index], labels[index]];
  }
  return [deductions[4], "심한 감점"];
}

function placementDeduction(averageRank) {
  if (!Number.isFinite(averageRank)) return [0, "감점 제외"];
  if (averageRank <= 3.7) return [0, "감점 없음"];
  if (averageRank <= 3.9) return [5, "약한 감점"];
  if (averageRank <= 4.3) return [10, "중간 감점"];
  if (averageRank < 4.7) return [15, "큰 감점"];
  return [20, "심한 감점"];
}

function top3Deduction(top3, tierTop3) {
  if (!Number.isFinite(top3)) return [0, "TOP3 결측 · 감점 제외"];
  const [absoluteDeduction, absoluteBand] = deductionBand(
    top3,
    [0.45, 0.4, 0.35, 0.3],
    [0, 5, 10, 17, 25],
  );
  if (!Number.isFinite(tierTop3)) {
    return [
      absoluteDeduction,
      `내 TOP3 ${(top3 * 100).toFixed(1)}% · 절대 ${absoluteBand} · 티어 평균 결측`,
    ];
  }
  const delta = top3 - tierTop3;
  const [relativeDeduction, relativeBand] = deductionBand(
    delta,
    [-0.03, -0.06, -0.1, -0.15],
    [0, 5, 10, 17, 25],
  );
  const deduction = Math.max(absoluteDeduction, relativeDeduction);
  const source =
    absoluteDeduction >= relativeDeduction ? "절대 기준" : "티어 대비";
  return [
    deduction,
    `내 TOP3 ${(top3 * 100).toFixed(1)}% · 티어 평균 ${(tierTop3 * 100).toFixed(1)}% ` +
      `· ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%p · 절대 ${absoluteBand} / ` +
      `티어 대비 ${relativeBand} · ${source} -${deduction}`,
  ];
}

function characterPerformanceDeduction(
  recentGames,
  seasonCharacterStats,
  tier,
  group,
  characterMetadata,
) {
  if (!recentGames.length) {
    return [0, "최근 캐릭터 표본 없음 · 감점 제외", false];
  }
  const grouped = new Map();
  for (const game of recentGames) {
    const characterId = Number(game.characterNum);
    if (!Number.isInteger(characterId)) continue;
    const games = grouped.get(characterId) || [];
    games.push(game);
    grouped.set(characterId, games);
  }
  const seasonGamesByCharacter = new Map(
    seasonCharacterStats
      .map((character) => [
        Number(character.characterCode),
        Number(character.totalGames),
      ])
      .filter(
        ([characterId, games]) =>
          Number.isInteger(characterId) &&
          Number.isFinite(games),
      ),
  );

  let weightedDeduction = 0;
  let eligibleGames = 0;
  const evaluated = [];
  const entries = [...grouped.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );
  for (const [characterId, games] of entries) {
    if (
      games.length < 3 ||
      (seasonGamesByCharacter.get(characterId) || 0) < 10
    ) {
      continue;
    }
    const baseline = tier.characters[String(characterId)];
    if (!baseline) continue;
    const actualDamage = recentFieldAverage(games, "damageToPlayer");
    const expectedDamage = Number(baseline.averageDamage);
    if (
      !Number.isFinite(actualDamage) ||
      !Number.isFinite(expectedDamage) ||
      expectedDamage <= 0
    ) {
      continue;
    }
    const damageRatio = actualDamage / expectedDamage;
    const actualTeamKills = recentFieldAverage(games, "teamKill", {
      allowZero: true,
    });
    const expectedTeamKills = Number(baseline.averageTeamKills);
    const performanceRatio =
      Number.isFinite(actualTeamKills) &&
      Number.isFinite(expectedTeamKills) &&
      expectedTeamKills > 0
        ? damageRatio * 0.7 + (actualTeamKills / expectedTeamKills) * 0.3
        : damageRatio;
    const [rawDeduction, band] = deductionBand(
      performanceRatio,
      PERFORMANCE_THRESHOLDS[group],
      [0, 5, 10, 17, 23],
    );
    const weight = games.length / recentGames.length;
    weightedDeduction += rawDeduction * weight;
    eligibleGames += games.length;
    const characterName =
      characterMetadata?.[String(characterId)]?.name || `#${characterId}`;
    evaluated.push(
      `${characterName} ${games.length}판 ${(performanceRatio * 100).toFixed(1)}% ` +
        `(${band}, -${rawDeduction}×${(weight * 100).toFixed(0)}%)`,
    );
  }
  if (!evaluated.length) {
    return [
      0,
      "시즌 10판 이상·최근 랭크 3판 이상 캐릭터 표본 없음 · 감점 제외",
      false,
    ];
  }
  const deduction = Math.min(23, Math.round(weightedDeduction * 10) / 10);
  const coverage = eligibleGames / recentGames.length;
  return [
    deduction,
    `유효 ${eligibleGames}/${recentGames.length}판 (${(coverage * 100).toFixed(1)}%) ` +
      `· 판수 가중 -${deduction} · ${evaluated.join(" / ")}`,
    true,
  ];
}

export function calculateScore(stats, recentGames, dakggStats) {
  validateStats(stats);
  const totalGames = Number(stats.totalGames);
  const tierKey = tierForMmr(stats.mmr, stats.rank);
  const tier = dakggStats?.tiers?.[tierKey];
  if (!tier) {
    return [100, "비교 데이터가 없어 닷지 판정을 보류합니다.", [], true];
  }
  const group = TIER_GROUPS[tierKey];
  const breakdown = [];

  let [deduction, performanceDetail, performanceEvaluated] =
    characterPerformanceDeduction(
    recentGames,
    stats.characterStats,
    tier,
    group,
    dakggStats.characters,
  );
  breakdown.push([
    "캐릭터 성과",
    25,
    deduction,
    performanceDetail,
  ]);

  const totalWins = optionalNumber(stats.totalWins);
  const winRate = totalWins == null ? null : totalWins / totalGames;
  const winEvaluated = Number.isFinite(winRate);
  let band;
  [deduction, band] = deductionBand(
    winRate,
    [0.15, 0.12, 0.10, 0.08],
    [0, 4, 9, 15, 20],
  );
  breakdown.push([
    "승률",
    20,
    deduction,
    Number.isFinite(winRate)
      ? `내 시즌 승률 ${(winRate * 100).toFixed(1)}% · 절대 기준 · ${band}`
      : "승률 결측 · 감점 제외",
  ]);

  const tierTop3 = tierAverage(tier, "top3Rate");
  const top3 = optionalNumber(stats.top3);
  const top3Evaluated = Number.isFinite(top3);
  let top3Detail;
  [deduction, top3Detail] = top3Deduction(top3, tierTop3);
  breakdown.push([
    "TOP3",
    25,
    deduction,
    top3Detail,
  ]);

  const tierVision = tierAverage(tier, "averageViewContribution");
  const actualVision = recentFieldAverage(recentGames, "viewContribution");
  const visionRatio =
    Number.isFinite(actualVision) && Number.isFinite(tierVision) && tierVision > 0
      ? actualVision / tierVision
      : null;
  const visionEvaluated = Number.isFinite(visionRatio);
  [deduction, band] = deductionBand(
    visionRatio,
    VISION_THRESHOLDS[group],
    [0, 2, 4, 7, 10],
  );
  breakdown.push([
    "시야점수",
    10,
    deduction,
    Number.isFinite(visionRatio)
      ? `내 시야 ${actualVision.toFixed(2)} · 티어 평균 ${tierVision.toFixed(2)} · ${(visionRatio * 100).toFixed(1)}% · ${band}`
      : "시야점수 결측 또는 0점 오류 의심 · 감점 제외",
  ]);

  const parsedAverageRank = optionalNumber(stats.averageRank);
  const averageRank =
    parsedAverageRank != null && parsedAverageRank > 0
      ? parsedAverageRank
      : null;
  const placementEvaluated = Number.isFinite(averageRank);
  [deduction, band] = placementDeduction(averageRank);
  breakdown.push([
    "평균순위",
    20,
    deduction,
    Number.isFinite(averageRank)
      ? `시즌 평균 ${averageRank.toFixed(2)}위 · ${band}`
      : "평균순위 결측 · 감점 제외",
  ]);

  const totalDeduction = breakdown.reduce((sum, item) => sum + item[2], 0);
  const score = Math.round(Math.max(0, 100 - totalDeduction) * 10) / 10;
  const evaluatedCount = [
    performanceEvaluated,
    winEvaluated,
    top3Evaluated,
    visionEvaluated,
    placementEvaluated,
  ].filter(Boolean).length;
  const protectedVerdict = totalGames < 20 || evaluatedCount < 4;
  const labels = breakdown.map((item) => item[0]);
  const reasonMessages = {
    [labels[0]]: "주력 캐릭터 성과가 같은 티어 평균보다 낮습니다.",
    [labels[1]]: "시즌 승률이 기준 승률보다 낮습니다.",
    [labels[2]]: "TOP3 비율이 같은 티어 평균 또는 안정권 기준보다 낮습니다.",
    [labels[3]]: "최근 시야점수가 같은 티어 평균보다 낮습니다.",
    [labels[4]]: "시즌 평균순위가 안정권 기준보다 낮습니다.",
  };
  const positiveMessages = {
    [labels[0]]: "주력 캐릭터 성과가 같은 티어 평균보다 좋습니다.",
    [labels[1]]: "시즌 승률이 기준 승률보다 좋습니다.",
    [labels[2]]: "TOP3 비율이 같은 티어 평균 또는 안정권 기준보다 좋습니다.",
    [labels[3]]: "최근 시야점수가 같은 티어 평균보다 좋습니다.",
    [labels[4]]: "시즌 평균순위가 안정권 기준보다 좋습니다.",
  };
  let comment;
  if (totalGames < 20) {
    comment = "전체 랭크 20판 미만으로 주의 판정에서 제외합니다.";
  } else if (evaluatedCount < 4) {
    comment = "비교 가능한 데이터가 부족해 주의 판정에서 제외합니다.";
  } else if (score < 55) {
    const weakest = [...breakdown].sort((a, b) => b[2] - a[2])[0];
    comment = reasonMessages[weakest[0]] || "확인이 필요한 지표가 기준보다 낮습니다.";
  } else if (score >= 95) {
    comment = "정말 좋은 팀원입니다!";
  } else {
    const best = [...breakdown].sort((a, b) => {
      const aRatio = a[1] ? (a[1] - a[2]) / a[1] : -1;
      const bRatio = b[1] ? (b[1] - b[2]) / b[1] : -1;
      if (bRatio !== aRatio) return bRatio - aRatio;
      return b[1] - b[2] - (a[1] - a[2]);
    })[0];
    comment = positiveMessages[best[0]] || "안정적인 지표가 확인됩니다.";
  }
  return [
    score,
    comment,
    breakdown.map(([label, maximum, itemDeduction, detail]) => ({
      label,
      score: Math.round((maximum - itemDeduction) * 10) / 10,
      maxScore: maximum,
      deduction: itemDeduction,
      isPenalty: false,
      detail,
    })),
    protectedVerdict,
  ];
}

function generateWarnings(stats, recentGames) {
  validateStats(stats);
  const warnings = [];
  const totalGames = Number(stats.totalGames);
  const totalWins = optionalNumber(stats.totalWins);
  const winRate = totalWins == null ? null : totalWins / totalGames;
  const top3 = optionalNumber(stats.top3);
  const top5 = optionalNumber(stats.top5);
  const top7 = optionalNumber(stats.top7);

  if (totalGames >= 50 && winRate != null && winRate < 0.08) {
    warnings.push("낮은 승률");
  }
  if (
    totalGames >= 50 &&
    top3 != null &&
    top5 != null &&
    top7 != null &&
    top7 - top5 >= 0.25 &&
    top3 <= 0.3
  ) {
    warnings.push("중반 탈락 빈번");
  }
  if (recentGames.length) {
    const averageRank =
      recentGames.reduce((sum, game) => sum + (Number(game.gameRank) || 9), 0) /
      recentGames.length;
    const averageDamage = recentFieldAverage(recentGames, "damageToPlayer");
    if (averageRank > 6) warnings.push("최근 평균 순위 저조");
    if (Number.isFinite(averageDamage) && averageDamage < 7000) {
      warnings.push("최근 피해량 부족");
    }
    if (
      averageRank > 6 &&
      Number.isFinite(averageDamage) &&
      averageDamage < 7000
    ) {
      warnings.push("최근 경기력 급락");
    }
  }

  const mostUsed = Math.max(
    ...stats.characterStats.map((character) => Number(character.totalGames) || 0),
  );
  if (totalGames < 20) warnings.push("20판 미만 · 닷지 판정 제외");
  else if (mostUsed < 10) warnings.push("뚜렷한 주력 캐릭터 없음");
  return warnings;
}

function grade(score) {
  if (score >= 55) return "좋음";
  return "주의";
}

function round(value, digits = 0) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function buildNoRecentRankResult(nickname, baseMetrics) {
  return {
    nickname,
    score: null,
    grade: "분석 보류",
    analysisStatus: "no_recent_rank",
    dodgeProtected: true,
    comment: "최근 20게임 안에 랭크게임이 확인되지 않습니다.",
    warnings: ["최근에는 일반게임을 이용한 것으로 보입니다."],
    scoreBreakdown: [],
    comparison: null,
    metrics: {
      ...baseMetrics,
      recentGames: 0,
      recentAverageRank: null,
      recentAverageDamage: null,
      recentAverageScouting: null,
    },
  };
}

export function cleanNickname(value) {
  if (typeof value !== "string") return [null, "닉네임은 문자열이어야 합니다."];
  const nickname = value.trim();
  if (!nickname) return [null, "닉네임을 입력해 주세요."];
  if ([...nickname].length > 30) return [null, "닉네임은 30자 이내로 입력해 주세요."];
  return [nickname, null];
}

export async function evaluatePlayer(nickname) {
  const uid = await getUid(nickname);
  const games = await getGames(uid);
  const currentSeasonId = await getCurrentSeasonId();
  const latestRankSeason = getRankSeasonFromGames(games);
  let season = latestRankSeason ?? currentSeasonId;
  let stats = await getSeasonStats(uid, season);
  let recent = recentRankGames(games, season);
  const currentSeasonGames = season === currentSeasonId
    ? Number(stats.totalGames) || 0
    : recentRankGames(games, currentSeasonId).length;
  let seasonBasis = "current";

  if (
    season !== currentSeasonId ||
    Number(stats.totalGames) < CURRENT_SEASON_MIN_GAMES
  ) {
    const previousSeasonId = season !== currentSeasonId
      ? season
      : getPreviousRankSeasonFromGames(games, currentSeasonId);
    if (previousSeasonId && previousSeasonId !== season) {
      try {
        const previousStats = await getSeasonStats(uid, previousSeasonId);
        const previousRecent = recentRankGames(games, previousSeasonId);
        if (previousRecent.length) {
          season = previousSeasonId;
          stats = previousStats;
          recent = previousRecent;
        }
      } catch (error) {
        console.warn("Previous-season analysis is unavailable:", error.message);
      }
    }
    if (season !== currentSeasonId) seasonBasis = "previous";
  }

  const totalGames = Number(stats.totalGames);
  const totalWins = optionalNumber(stats.totalWins);
  const averageRank = optionalNumber(stats.averageRank);
  const top3 = optionalNumber(stats.top3);
  const mostUsedGames = Math.max(
    ...stats.characterStats.map((character) => Number(character.totalGames) || 0),
  );
  const baseMetrics = {
    seasonId: season,
    seasonLabel: formatIngameSeason(season),
    seasonBasis,
    currentSeasonId,
    currentSeasonLabel: formatIngameSeason(currentSeasonId),
    currentSeasonGames,
    currentSeasonMinimumGames: CURRENT_SEASON_MIN_GAMES,
    totalGames,
    winRate: totalWins == null
      ? null
      : round((totalWins / totalGames) * 100, 1),
    averageRank: averageRank != null && averageRank > 0
      ? round(averageRank, 2)
      : null,
    top3Rate: top3 == null ? null : round(top3 * 100, 1),
    mainCharacterRate: round((mostUsedGames / totalGames) * 100, 1),
    fetchedGames: games.length,
  };

  if (!recent.length) {
    return buildNoRecentRankResult(nickname, baseMetrics);
  }

  const dakggStats = await getDakggStats();
  const [score, comment, scoreBreakdown, dodgeProtected] = calculateScore(
    stats,
    recent,
    dakggStats,
  );
  let comparison = null;
  try {
    comparison = compareMostCharacters(
      stats,
      recent,
      dakggStats,
    );
  } catch (error) {
    console.warn("DAK.GG comparison is unavailable:", error.message);
  }

  return {
    nickname,
    score,
    grade: dodgeProtected ? "NOT DODGE" : grade(score),
    analysisStatus: "scored",
    dodgeProtected,
    comment,
    warnings: generateWarnings(stats, recent),
    scoreBreakdown,
    comparison,
    metrics: {
      ...baseMetrics,
      recentGames: recent.length,
      recentAverageRank: recent.length
        ? round(recent.reduce((sum, game) => sum + (Number(game.gameRank) || 9), 0) / recent.length, 2)
        : null,
      recentAverageDamage: recent.length
        ? Number.isFinite(recentFieldAverage(recent, "damageToPlayer"))
          ? round(recentFieldAverage(recent, "damageToPlayer"))
          : null
        : null,
      recentAverageScouting: Number.isFinite(
        recentFieldAverage(recent, "viewContribution"),
      )
        ? round(recentFieldAverage(recent, "viewContribution"), 2)
        : null,
    },
  };
}

export async function analyzeNickname(nickname) {
  return analysisCache.getOrLoad(`analysis:${ANALYSIS_CACHE_VERSION}:${normalizeNicknameKey(nickname)}`, {
    ttlMs: 60 * 1000,
    loader: async () => {
      try {
        return await evaluatePlayer(nickname);
      } catch (error) {
        if (!(error instanceof AnalyzerError)) console.error(error);
        return {
          nickname,
          error:
            error instanceof AnalyzerError
              ? error.message
              : "분석 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.",
        };
      }
    },
  });
}
