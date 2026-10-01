import admin from "firebase-admin";

// Live momentum recorder.
// Runs as a loop: every INTERVAL it looks at the matches being played
// right now (in your leagues), reads each one's running statistics, and
// appends one snapshot to Firestore at momentum/{fixtureId}. The app
// subtracts one snapshot from the next to draw the Match Momentum bars.
// Nothing here touches the cache/* documents the other sync job writes.

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});
const db = admin.firestore();

// Same leagues as sync.js
const LEAGUE_IDS = [39,140,78,135,61,88,94,40,71,2,1,4,3,848,203,144,179,253,262,307,128,235,98,41,42];

const INTERVAL_MS = (Number(process.env.LIVE_INTERVAL_SEC) || 120) * 1000;
const MAX_RUN_MS = (Number(process.env.LIVE_MAX_MINUTES) || 330) * 60 * 1000;
// Stop after this many checks in a row with no live match; the next
// scheduled run starts the loop again.
const IDLE_EXIT_TICKS = Number(process.env.LIVE_IDLE_TICKS) || 1;

const AF = "https://v3.football.api-sports.io";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function af(path) {
  for (let i = 0; i < 3; i++) {
    await sleep(250);
    const res = await fetch(`${AF}/${path}`, {
      headers: { "x-apisports-key": process.env.API_KEY },
    });
    if (res.status === 429) { await sleep(15000); continue; }
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.json();
  }
  throw new Error(`Rate limited: ${path}`);
}

// API-Football reports blocked requests inside a 200 response
async function afList(path) {
  const data = await af(path);
  const e = data.errors;
  if (e && (Array.isArray(e) ? e.length : Object.keys(e).length)) {
    throw new Error(JSON.stringify(e));
  }
  return data.response ?? [];
}

function statValue(list, type) {
  const row = (list ?? []).find((s) => s.type === type);
  return row ? row.value : null;
}

function num(v) {
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace("%", ""));
  return Number.isFinite(n) ? n : 0;
}

// One reading of the match's running totals, or null if the API has
// no statistics for it yet.
async function snapshotFor(f) {
  const id = f.fixture.id;
  const minute = f.fixture.status?.elapsed ?? 0;
  if (!minute) return null;

  const blocks = await afList(`fixtures/statistics?fixture=${id}`);
  if (blocks.length < 2) return null;
  const home = blocks.find((b) => b.team?.id === f.teams.home.id) ?? blocks[0];
  const away = blocks.find((b) => b.team?.id === f.teams.away.id) ?? blocks[1];
  const h = home.statistics;
  const a = away.statistics;

  // Without possession the interval maths in the app would swing
  // wildly, so wait for a tick that has it.
  if (statValue(h, "Ball Possession") == null &&
      statValue(a, "Ball Possession") == null) {
    return null;
  }

  return {
    minute,
    homePoss: num(statValue(h, "Ball Possession")),
    awayPoss: num(statValue(a, "Ball Possession")),
    homeShots: num(statValue(h, "Total Shots")),
    awayShots: num(statValue(a, "Total Shots")),
    homeSot: num(statValue(h, "Shots on Goal")),
    awaySot: num(statValue(a, "Shots on Goal")),
    homeCorners: num(statValue(h, "Corner Kicks")),
    awayCorners: num(statValue(a, "Corner Kicks")),
    homeXg: num(statValue(h, "expected_goals")),
    awayXg: num(statValue(a, "expected_goals")),
    t: Date.now(),
  };
}

const lastWritten = new Map();

// Returns how many tracked matches were live this round.
async function tick() {
  const live = (await afList("fixtures?live=all")).filter((f) =>
    LEAGUE_IDS.includes(f.league.id)
  );

  for (const f of live) {
    const id = f.fixture.id;
    try {
      const snap = await snapshotFor(f);
      if (!snap) continue;

      // Skip if nothing changed since the last write (e.g. half-time)
      const { t, ...rest } = snap;
      const key = JSON.stringify(rest);
      if (lastWritten.get(id) === key) continue;

      await db.doc(`momentum/${id}`).set(
        {
          fixtureId: id,
          homeId: f.teams.home.id,
          awayId: f.teams.away.id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          snapshots: admin.firestore.FieldValue.arrayUnion(snap),
        },
        { merge: true }
      );
      lastWritten.set(id, key);
      console.log(`saved ${id} @ ${snap.minute}'`);
    } catch (e) {
      console.log(`skip ${id}: ${e.message}`);
    }
  }
  return live.length;
}

const startedAt = Date.now();
let idle = 0;

while (Date.now() - startedAt < MAX_RUN_MS) {
  const tickStart = Date.now();
  let liveCount = -1; // -1 = the check itself failed, keep going
  try {
    liveCount = await tick();
  } catch (e) {
    console.log(`tick failed: ${e.message}`);
  }

  if (liveCount === 0) {
    idle++;
    if (idle >= IDLE_EXIT_TICKS) {
      console.log("No live matches, stopping.");
      break;
    }
  } else if (liveCount > 0) {
    idle = 0;
  }

  const wait = INTERVAL_MS - (Date.now() - tickStart);
  if (wait > 0) await sleep(wait);
}

console.log("Live loop finished");
process.exit(0);
