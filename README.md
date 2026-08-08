# ER Dodge Check - Netlify

This directory is a Netlify-specific copy of the original Flask project.

## Deploy

1. Push the `PROD` directory to a Git repository, or select `PROD` as the Netlify base directory.
2. Add `ER_API_KEY` in Netlify: **Site configuration > Environment variables**.
3. Deploy. No build command is required.

Netlify configuration:

- Publish directory: `public`
- Functions directory: `netlify/functions`
- API key: server-side environment variable `ER_API_KEY`

Patch data is bundled from `data/character_patches.json`. Update that file and redeploy when patch data changes.

## DAK.GG statistics

`scripts/collect_dakgg_stats.py` collects the public statistics used by the
DAK.GG Eternal Return statistics page into a local SQLite database and a
compressed runtime artifact:

- `data/dakgg_stats.sqlite3`: local inspection database, ignored by Git
- `data/dakgg_stats.json.gz`: Netlify runtime data and bundled fallback

The database contains:

- tier snapshot metadata
- tier and character aggregates
- tier, character, and weapon aggregates
- win rate, TOP 3 rate, average placement, and average player damage

Run a manual refresh from the `PROD` directory:

```bash
python scripts/collect_dakgg_stats.py
```

`.github/workflows/refresh-dakgg-stats.yml` refreshes the data every six hours
and replaces `dakgg_stats.json.gz` on the `dakgg-data` GitHub Release. It does
not commit data to the repository, so scheduled refreshes do not trigger
Netlify production deploys.

Collection is deferred until `DAKGG_COLLECT_AFTER` (currently 2026-08-14
00:00 Asia/Seoul). After that time, the Release is replaced only after every
tier snapshot has been collected successfully. If DAK.GG has not published a
tier yet, the upload steps are skipped and the last successful Release remains
active. The checked-in `data/dakgg_stats.json.gz` is the bundled cache used if
the Release cannot be downloaded.

The Netlify runtime downloads:

`https://github.com/dejava-daisky/er-dodge/releases/download/dakgg-data/dakgg_stats.json.gz`

Set `DAKGG_STATS_URL` to override that URL. The function caches successful
downloads for six hours and falls back to the bundled artifact when the
release is unavailable.

Player MMR is mapped to the current official RP ranges before selecting the
DAK.GG tier dataset. The personal report compares up to five most-played
characters on win rate, TOP 3 rate, average placement, and recent average
player damage. The same tier data supplies the baselines used by the
deduction score.

## Deduction score

The analyzer starts at 100 and deducts from five areas:

- character performance: 25 points, maximum deduction 23
- win rate: 20 points, maximum deduction 20
- TOP 3 rate: 25 points, maximum deduction 25
- vision contribution: 10 points, maximum deduction 10
- average placement: 20 points, maximum deduction 20

Character performance groups the recent ranked records by character. A
character is evaluated only with at least five recent games. Its damage and
team-kill performance is compared with the same tier and character baseline,
then its deduction is multiplied by its share of the recent ranked sample.
The combined character deduction is capped at 23.

Scores below 55 receive the dodge recommendation. Accounts below 20 ranked
games and reports with fewer than four usable scoring areas are protected as
NOT DODGE. Missing, non-finite, and suspicious all-zero recent values are
excluded instead of being treated as zero performance.
