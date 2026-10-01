import admin from "firebase-admin";
import { notifyTeams, wasSent, markSent } from "./notify.js";

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});
const db = admin.firestore();
const MODE = process.env.MODE || "frequent";

const LEAGUE_IDS = [39,140,78,135,61,88,94,40,71,2,1,4,3,848,203,144,179,253,262,307,128,235,98,41,42];
const FINISHED = ["FT", "AET", "PEN"];
const CHUNK = 100;

const AF = "https://v3.football.api-sports.io";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

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

async function save(key, items, finalized = false) {
  const chunks = Math.max(1, Math.ceil(items.length / CHUNK));
  const batch = db.batch();
  for (let i = 0; i < chunks; i++) {
    batch.set(db.doc(`cache/${key}__${i}`), {
      json: JSON.stringify(items.slice(i * CHUNK, (i + 1) * CHUNK)),
    });
  }
  batch.set(db.doc(`cache/${key}__meta`), {
    chunks, count: items.length, finalized,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();
}
async function isFinal(key) {
  const s = await db.doc(`cache/${key}__meta`).get();
  return s.exists && s.data().finalized === true;
}
async function safe(label, fn) {
  try { await fn(); } catch (e) { console.log(`skip ${label}: ${e.message}`); }
}

if (MODE === "frequent") {
  // 1) Fixtures by date (3 days back, 3 days ahead)
  const byDate = {};
  for (let d = -3; d <= 3; d++) {
    const date = iso(d);
    await safe(`fixtures ${date}`, async () => {
      byDate[date] = await afList(`fixtures?date=${date}`);
      await save(`fixtures_${date}`, byDate[date]);
    });
  }

  // 2) Details for yesterday/today/tomorrow in your leagues
  const near = [iso(-1), iso(0), iso(1)]
    .flatMap((d) => byDate[d] ?? [])
    .filter((f) => LEAGUE_IDS.includes(f.league.id));
  const teams = new Set();
  const pairs = new Set();

  for (const f of near) {
    const id = f.fixture.id;
    const done = FINISHED.includes(f.fixture.status.short);
    if (!done) {
      const h = f.teams.home.id, a = f.teams.away.id;
      teams.add(h); teams.add(a);
      pairs.add([h, a].sort((x, y) => x - y).join("-"));

      // Lineup notification: once, when lineups are published and the
      // match is due to kick off within the next 90 minutes.
      const minsToKick = (f.fixture.timestamp * 1000 - Date.now()) / 60000;
      if (minsToKick > 0 && minsToKick <= 90 && !(await wasSent(`lineup:${id}`))) {
        await safe(`lineups ${id}`, async () => {
          const l = await afList(`fixtures/lineups?fixture=${id}`);
          if (l.length >= 2) {
            await notifyTeams(
              [h, a],
              "Lineups are in",
              `${f.teams.home.name} vs ${f.teams.away.name}`,
              { type: "lineup", fixtureId: id }
            );
            await markSent(`lineup:${id}`);
          }
        });
      }
    }
    if (done && (await isFinal(`fixture_${id}`))) continue;
    await safe(`fixture ${id}`, async () =>
      save(`fixture_${id}`, await afList(`fixtures?id=${id}`), done));
    await safe(`players ${id}`, async () =>
      save(`players_${id}`, await afList(`fixtures/players?fixture=${id}`), done));
    if (!done) {
      await safe(`predictions ${id}`, async () =>
        save(`predictions_${id}`, await afList(`predictions?fixture=${id}`)));
      await safe(`injuries ${id}`, async () =>
        save(`injuries_${id}`, await afList(`injuries?fixture=${id}`)));
    }
  }

  // 3) Head-to-head for upcoming matches
  for (const pair of pairs) {
    await safe(`h2h ${pair}`, async () =>
      save(`h2h_${pair}`, await afList(`fixtures/headtohead?h2h=${pair}`)));
  }

  // 4) Each team's last fixture (for probable lineups)
  for (const t of teams) {
    await safe(`last ${t}`, async () => {
      const r = await afList(`fixtures?team=${t}&last=1`);
      await save(`lastfixture_${t}`, r);
      const lid = r[0]?.fixture?.id;
      if (lid && !(await isFinal(`fixture_${lid}`))) {
        await save(`fixture_${lid}`, await afList(`fixtures?id=${lid}`), true);
      }
    });
  }
}

if (MODE === "daily") {
  const now = new Date();
  const season = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  for (const l of LEAGUE_IDS) {
    await safe(`league fixtures ${l}`, async () =>
      save(`leaguefixtures_${l}_${season}`,
        await afList(`fixtures?league=${l}&season=${season}`)));
    await safe(`standings ${l}`, async () => {
      const r = await afList(`standings?league=${l}&season=${season}`);
      if (r.length) {
        await save(`standings_${l}_${season}`, (r[0].league?.standings ?? []).flat());
      }
    });
    await safe(`topscorers ${l}`, async () =>
      save(`topscorers_${l}_${season}`,
        await afList(`players/topscorers?league=${l}&season=${season}`)));
  }
}
console.log(`Done (${MODE})`);
