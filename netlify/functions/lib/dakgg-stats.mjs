import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_URL =
  "https://github.com/dejava-daisky/er-dodge/releases/download/dakgg-data/dakgg_stats.json.gz";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const FALLBACK_PATH = fileURLToPath(
  new URL("../../../data/dakgg_stats.json.gz", import.meta.url),
);

let cache = null;
let cacheExpiresAt = 0;
let pendingLoad = null;
let bundledCache = null;

function parseArtifact(buffer) {
  const parsed = JSON.parse(gunzipSync(buffer).toString("utf8"));
  if (parsed?.schemaVersion !== 1 || !parsed?.tiers) {
    throw new Error("Unsupported DAK.GG statistics artifact");
  }
  return parsed;
}

async function fetchReleaseArtifact() {
  const baseUrl = process.env.DAKGG_STATS_URL || DEFAULT_URL;
  const url = new URL(baseUrl);
  url.searchParams.set("refresh", String(Math.floor(Date.now() / CACHE_TTL_MS)));
  const response = await fetch(url, {
    headers: {
      accept: "application/gzip, application/octet-stream",
      "user-agent": "ER-Dodge-Check/1.0",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`DAK.GG statistics download failed: ${response.status}`);
  }
  return parseArtifact(Buffer.from(await response.arrayBuffer()));
}

async function readBundledArtifact() {
  return parseArtifact(
    await readFile(process.env.DAKGG_STATS_FILE || FALLBACK_PATH),
  );
}

async function loadStats() {
  try {
    return await fetchReleaseArtifact();
  } catch (error) {
    console.warn("Using bundled DAK.GG statistics fallback:", error.message);
    return readBundledArtifact();
  }
}

export async function getDakggStats() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;
  if (!pendingLoad) {
    pendingLoad = loadStats()
      .then((stats) => {
        cache = stats;
        cacheExpiresAt = Date.now() + CACHE_TTL_MS;
        return stats;
      })
      .finally(() => {
        pendingLoad = null;
      });
  }
  return pendingLoad;
}

export async function getCachedDakggStats() {
  if (!bundledCache) bundledCache = await readBundledArtifact();
  return bundledCache;
}

export function resetDakggStatsCache() {
  cache = null;
  cacheExpiresAt = 0;
  pendingLoad = null;
  bundledCache = null;
}

export function tierForMmr(mmr, rank = null) {
  const numericRank =
    rank == null || rank === "" ? null : Number(rank);
  if (
    Number.isFinite(numericRank) &&
    numericRank > 0 &&
    numericRank <= 1000
  ) {
    return "in1000";
  }
  const value = Number(mmr);
  if (!Number.isFinite(value) || value < 600) return "iron";
  if (value < 1400) return "bronze";
  if (value < 2400) return "silver";
  if (value < 3600) return "gold";
  if (value < 5000) return "platinum";
  if (value < 6400) return "diamond_plus";
  if (value < 7400) return "meteorite_plus";
  return "mithril_plus";
}

export function compareMostCharacters(stats, recentGames, dakggStats, limit = 5) {
  const tierKey = tierForMmr(stats.mmr, stats.rank);
  const tier = dakggStats.tiers[tierKey];
  if (!tier) return { tierKey, tierLabel: tierKey, characters: [] };

  const recentByCharacter = new Map();
  for (const game of recentGames) {
    const characterId = Number(game.characterNum);
    if (!Number.isInteger(characterId)) continue;
    const item = recentByCharacter.get(characterId) || { games: 0, damage: 0, rank: 0 };
    item.games += 1;
    item.damage += Number(game.damageToPlayer) || 0;
    item.rank += Number(game.gameRank) || 9;
    recentByCharacter.set(characterId, item);
  }

  const characters = [...stats.characterStats]
    .sort((a, b) => Number(b.totalGames) - Number(a.totalGames))
    .slice(0, limit)
    .map((character) => {
      const characterId = Number(character.characterCode);
      const baseline = tier.characters[String(characterId)];
      if (!baseline) return null;
      const characterMeta = dakggStats.characters?.[String(characterId)] || {};
      const games = Number(character.totalGames) || 0;
      const recent = recentByCharacter.get(characterId);
      const winRate = games ? (Number(character.wins) || 0) / games : 0;
      const top3Rate = games ? (Number(character.top3) || 0) / games : 0;
      const seasonAveragePlacement = Number(character.averageRank) || null;
      const averagePlacement = recent?.games
        ? recent.rank / recent.games
        : seasonAveragePlacement;
      const averageDamage = recent?.games ? recent.damage / recent.games : null;
      return {
        characterId,
        characterName: characterMeta.name || characterMeta.key || `#${characterId}`,
        characterKey: characterMeta.key || "",
        characterImageUrl: characterMeta.imageUrl || "",
        games,
        weight: games / Number(stats.totalGames),
        baselineGames: baseline.games,
        winRate,
        baselineWinRate: baseline.winRate,
        top3Rate,
        baselineTop3Rate: baseline.top3Rate,
        averagePlacement,
        seasonAveragePlacement,
        recentPlacementGames: recent?.games || 0,
        baselineAveragePlacement: baseline.averagePlacement,
        recentDamageGames: recent?.games || 0,
        averageDamage,
        baselineAverageDamage: baseline.averageDamage,
        winRateDelta: winRate - baseline.winRate,
        top3RateDelta: top3Rate - baseline.top3Rate,
        averagePlacementDelta:
          averagePlacement === null
            ? null
            : averagePlacement - baseline.averagePlacement,
        averageDamageDelta:
          averageDamage === null
            ? null
            : averageDamage - baseline.averageDamage,
      };
    })
    .filter(Boolean);

  return {
    tierKey,
    tierLabel: tier.label,
    sourcePatch: dakggStats.currentPatch,
    sourceUpdatedAt: tier.updatedAt,
    periodDays: dakggStats.periodDays,
    characters,
  };
}

export function resetDakggStatsCacheForTests() {
  cache = null;
  cacheExpiresAt = 0;
  pendingLoad = null;
  bundledCache = null;
}
