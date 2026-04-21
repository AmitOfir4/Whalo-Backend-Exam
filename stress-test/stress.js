/**
 * Whalo Backend — k6 Stress Test
 *
 * Scenarios (peak 130 VUs total — medium load):
 *   score_submissions    50 VUs  → POST /scores          (~  500 req/s at peak)
 *   leaderboard_reads    40 VUs  → GET  /leaderboard     (~  800 req/s at peak)
 *   top_scores_reads     25 VUs  → GET  /scores/top      (~  500 req/s at peak)
 *   log_ingestion        15 VUs  → POST /logs            (~   75 req/s at peak)
 *
 * Stages per scenario:
 *   0 → 2 min  ramp up to target VUs
 *   2 → 4 min  hold at target VUs
 *   4 → 5 min  ramp down to 0
 *
 * Run:
 *   k6 run stress-test/stress.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// ── Base URLs (override via K6_ENV vars if needed) ─────────────────────────
const PLAYER_SERVICE     = __ENV.PLAYER_URL      || 'http://localhost:3001';
const SCORE_SERVICE      = __ENV.SCORE_URL       || 'http://localhost:3002';
const LEADERBOARD_SERVICE = __ENV.LEADERBOARD_URL || 'http://localhost:3003';
const LOG_SERVICE        = __ENV.LOG_URL         || 'http://localhost:3004';

// ── Seed data ──────────────────────────────────────────────────────────────
const SEED_PLAYER_COUNT = 100;

const LOG_PRIORITIES = ['low', 'normal', 'high'];

const LOG_MESSAGES = [
  'Player completed level with high score',
  'Player died at checkpoint 3',
  'Player achieved new personal best',
  'Player unlocked rare achievement',
  'Player started new game session',
  'Player used power-up at level 7',
  'Player invited a friend to the game',
  'Player reported a bug in level 12',
];

// ── Custom metrics ─────────────────────────────────────────────────────────
const scoreSubmitDuration    = new Trend('score_submit_duration',    true);
const leaderboardDuration    = new Trend('leaderboard_read_duration', true);
const topScoresDuration      = new Trend('top_scores_duration',      true);
const logIngestDuration      = new Trend('log_ingest_duration',      true);
const errorRate              = new Rate('error_rate');

// ── Test configuration ─────────────────────────────────────────────────────
export const options =
{
  scenarios:
  {
    score_submissions:
    {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '2m', target: 50 },
        { duration: '1m', target: 0  },
      ],
      exec: 'submitScore',
      gracefulRampDown: '10s',
    },

    leaderboard_reads:
    {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 40 },
        { duration: '2m', target: 40 },
        { duration: '1m', target: 0  },
      ],
      exec: 'readLeaderboard',
      gracefulRampDown: '10s',
    },

    top_scores_reads:
    {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 25 },
        { duration: '2m', target: 25 },
        { duration: '1m', target: 0  },
      ],
      exec: 'readTopScores',
      gracefulRampDown: '10s',
    },

    log_ingestion:
    {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 15 },
        { duration: '2m', target: 15 },
        { duration: '1m', target: 0  },
      ],
      exec: 'ingestLog',
      gracefulRampDown: '10s',
    },
  },

  thresholds:
  {
    // Global HTTP thresholds
    http_req_duration: ['p(95)<2000', 'p(99)<5000'],
    http_req_failed:   ['rate<0.05'],

    // Custom per-scenario thresholds
    error_rate:               ['rate<0.05'],
    score_submit_duration:    ['p(95)<1500'],
    leaderboard_read_duration: ['p(95)<500'],
    top_scores_duration:      ['p(95)<500'],
    log_ingest_duration:      ['p(95)<1000'],
  },
};

// ── Setup: seed players once before all scenarios start ────────────────────
export function setup()
{
  const headers = { 'Content-Type': 'application/json' };
  const playerIds = [];
  const baseTs = Date.now();

  console.log(`Seeding ${SEED_PLAYER_COUNT} players…`);

  for (let i = 0; i < SEED_PLAYER_COUNT; i++)
  {
    const payload = JSON.stringify(
    {
      username: `stresstester${baseTs}${i}`,
      email: `stress${baseTs}${i}@load.test`,
    });

    const res = http.post(`${PLAYER_SERVICE}/players`, payload, { headers });

    if (res.status === 201)
    {
      const body = res.json();
      if (body && body.playerId)
      {
        playerIds.push(body.playerId);
      }
    }
    else
    {
      console.warn(`Setup: player ${i} creation failed — HTTP ${res.status}: ${res.body}`);
    }
  }

  if (playerIds.length === 0)
  {
    throw new Error('Setup failed: no players were created. Is player-service running?');
  }

  console.log(`Setup complete — ${playerIds.length}/${SEED_PLAYER_COUNT} players created.`);
  return { playerIds };
}

// ── Helpers ────────────────────────────────────────────────────────────────
function randomItem(arr)
{
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max)
{
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Scenario: POST /scores ─────────────────────────────────────────────────
export function submitScore(data)
{
  const { playerIds } = data;
  const playerId = randomItem(playerIds);
  const score    = randomInt(0, 99999);
  const headers  = { 'Content-Type': 'application/json' };

  const res = http.post(
    `${SCORE_SERVICE}/scores`,
    JSON.stringify({ playerId, score }),
    { headers, tags: { name: 'submitScore' } },
  );

  scoreSubmitDuration.add(res.timings.duration);

  const ok = check(res,
  {
    'submitScore → 202': (r) => r.status === 202,
  });

  errorRate.add(!ok);
  sleep(0.1);
}

// ── Scenario: GET /players/leaderboard ────────────────────────────────────
export function readLeaderboard(_data)
{
  const page  = randomInt(1, 5);
  const limit = randomItem([10, 25, 50]);

  const res = http.get(
    `${LEADERBOARD_SERVICE}/players/leaderboard?page=${page}&limit=${limit}`,
    { tags: { name: 'readLeaderboard' } },
  );

  leaderboardDuration.add(res.timings.duration);

  const ok = check(res,
  {
    'readLeaderboard → 200': (r) => r.status === 200,
    'leaderboard has data':  (r) =>
    {
      const body = r.json();
      return body && Array.isArray(body.data);
    },
  });

  errorRate.add(!ok);
  sleep(0.05);
}

// ── Scenario: GET /scores/top ─────────────────────────────────────────────
export function readTopScores(_data)
{
  const res = http.get(
    `${SCORE_SERVICE}/scores/top`,
    { tags: { name: 'readTopScores' } },
  );

  topScoresDuration.add(res.timings.duration);

  const ok = check(res,
  {
    'readTopScores → 200': (r) => r.status === 200,
    'top scores is array':  (r) => Array.isArray(r.json()),
  });

  errorRate.add(!ok);
  sleep(0.05);
}

// ── Scenario: POST /logs ───────────────────────────────────────────────────
export function ingestLog(data)
{
  const { playerIds } = data;
  const playerId = randomItem(playerIds);
  const priority = randomItem(LOG_PRIORITIES);
  const logData  = `${randomItem(LOG_MESSAGES)} — VU ${__VU} iter ${__ITER}`;
  const headers  = { 'Content-Type': 'application/json' };

  const res = http.post(
    `${LOG_SERVICE}/logs`,
    JSON.stringify({ playerId, logData, priority }),
    { headers, tags: { name: 'ingestLog' } },
  );

  logIngestDuration.add(res.timings.duration);

  const ok = check(res,
  {
    'ingestLog → 202': (r) => r.status === 202,
  });

  errorRate.add(!ok);
  sleep(0.2);
}
