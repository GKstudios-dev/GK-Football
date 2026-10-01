import admin from "firebase-admin";

// Article automation. Each run does this, in order:
//   1) PUBLISH: drafts in `article_drafts` that you set approved=true are
//      copied into your real `posts` collection.
//   2) MATCH ARTICLES (free): match REPORTS for games that just finished and
//      match PREVIEWS for games kicking off soon. The facts come from the
//      data your sync job already saved in Firestore (cache/*), and Gemini
//      only writes the words. No Google Search needed.
//   3) TRENDING (needs Google billing, OFF by default): Gemini searches Google
//      for a trending football topic. Turn on with AUTO_TRENDING=on.
//   4) NOTES (optional): notes you add to `article_ideas` with status "new".
// Nothing reaches the app until you approve a draft.

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});
const db = admin.firestore();

// ---------- Settings (change here if needed) ----------
const ARTICLES = "posts";
const IDEAS = "article_ideas";
const DRAFTS = "article_drafts";
const LOG = "article_log";
const AUTHOR = "Sir Gabby";
const DEFAULT_IMAGE =
  "https://gkstudios-dev.github.io/GK-Football/images/clubfootbal.webp";
// The category values your app uses. Add the others here.
const CATEGORIES = ["club"];

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const AUTO_MATCH = process.env.AUTO_MATCH !== "off";       // match reports + previews
const AUTO_TRENDING = process.env.AUTO_TRENDING === "on";  // needs billing on Google

const MATCH_PER_RUN = 2;        // match drafts per run
const MATCH_PER_DAY = 6;        // match drafts per 24 hours
const TRENDING_PER_RUN = 1;
const TRENDING_PER_DAY = 3;
const MAX_PENDING = 8;          // stop making drafts while this many wait for review
const MAX_NOTES_PER_RUN = 3;

// Which matches deserve an article: score = league weight + 2 per big team.
// Matches scoring below MIN_SCORE are skipped. Edit freely.
const MIN_SCORE = 3;
const LEAGUE_WEIGHT = {
  1: 3, 2: 3, 4: 3,          // World Cup, Champions League, Euros
  3: 2, 39: 2, 140: 2, 78: 2, 135: 2, 61: 2, // Europa, EPL, La Liga, Bundesliga, Serie A, Ligue 1
};
const PRIORITY_TEAMS = [
  541, 529, 530,             // Real Madrid, Barcelona, Atletico Madrid
  33, 40, 42, 49, 50, 47,    // Man Utd, Liverpool, Arsenal, Chelsea, Man City, Tottenham
  157, 165,                  // Bayern, Dortmund
  85,                        // PSG
  496, 505, 489, 492,        // Juventus, Inter, AC Milan, Napoli
  194, 211, 212,             // Ajax, Benfica, Porto
];

const LEAGUE_IDS = [39,140,78,135,61,88,94,40,71,2,1,4,3,848,203,144,179,253,262,307,128,235,98,41,42];
const FINISHED = ["FT", "AET", "PEN"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDate = (d) =>
  new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

// ---------- Gemini ----------
// With search on, the model can look things up on Google (needs billing).
// The reply also lists the pages it used, which we keep on the draft.
async function gemini(prompt, { search = false } = {}) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
  if (search) body.tools = [{ google_search: {} }];
  else body.generationConfig = { responseMimeType: "application/json" };

  let lastError = "";
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      lastError = `${res.status}: ${(await res.text()).slice(0, 400)}`;
      await sleep(20000 * (i + 1));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const text = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    if (!text) throw new Error("Gemini returned no text");
    const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
      .map((c) => c.web?.uri)
      .filter(Boolean)
      .slice(0, 8);
    return { text, sources };
  }
  throw new Error(`Gemini is busy or the limit is used up. Last reply: ${lastError}`);
}

function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Gemini's reply had no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

const FORMAT_RULES = `- In your own original wording. Never copy sentences from any source and never quote people.
- "body" is HTML using only <p>, <h2>, <strong>, <ul> and <li>. No <h1>, no images, no links.
- Use the focus keyword naturally in the first paragraph and a few more times.
- "snippet": the first one or two sentences as plain text, at most 200 characters.
- "metaDescription": plain text, at most 155 characters, containing the focus keyword.
- "tags": 3 to 6 short lowercase tags.
- "imageAlt": a short description of a suitable image.`;

const JSON_SHAPE = `{"title": "", "subtitle": "", "body": "", "snippet": "", "metaDescription": "", "focusKeyword": "", "tags": [], "imageAlt": ""}`;

// ---------- Prompts ----------
function notesPrompt(idea) {
  return `You are a football journalist writing for a football news app.
Write one article from the editor's notes below.

EDITOR'S NOTES:
${idea.topic}

CATEGORY: ${idea.category}

RULES:
- 600 to 800 words.
- Use ONLY the facts, names, scores and dates found in the notes. Never invent statistics, quotes, transfers, injuries or results. If the notes are only a general topic, write general evergreen analysis with no specific claims.
${FORMAT_RULES}

Return ONLY a JSON object with exactly these keys:
${JSON_SHAPE}`;
}

function trendingPrompt(avoidTitles) {
  const today = new Date().toISOString().slice(0, 10);
  const avoid = avoidTitles.length
    ? `\nDo NOT write about these topics, they are already covered:\n${avoidTitles.map((t) => `- ${t}`).join("\n")}\n`
    : "";
  return `You are a football journalist writing for a football news app. Today is ${today}.

STEP 1: Use Google Search to find ONE football topic that is trending right now (a big match or result, a transfer story, a manager or injury story, a tournament). Choose one that fits one of these categories: ${CATEGORIES.join(", ")}.
STEP 2: Choose the focus keyword that people are most likely to be searching for about that topic.
STEP 3: Write an original article about it.
${avoid}
RULES:
- 600 to 800 words.
- Use only facts you found in the search results. Never invent statistics, scores, quotes, transfers or injuries. If you are not sure of a fact, leave it out.
${FORMAT_RULES}

Return ONLY a JSON object with exactly these keys:
{"title": "", "subtitle": "", "body": "", "snippet": "", "metaDescription": "", "focusKeyword": "", "tags": [], "imageAlt": "", "category": ""}`;
}

function matchPrompt(kind, f, facts) {
  const home = f.teams.home.name;
  const away = f.teams.away.name;
  const keyword = kind === "report"
    ? `${home} vs ${away} match report`
    : `${home} vs ${away} preview`;
  const task = kind === "report"
    ? `Write a MATCH REPORT: tell the story of the game, the goals and who scored them, the key moments and what the result means.`
    : `Write a MATCH PREVIEW: set the scene, compare the two teams' league position and form, summarise their recent meetings, mention home advantage and absentees, and say what to watch for. Do not predict a score as if it were fact; if you mention the statistical prediction, say it comes from a statistical model.`;
  return `You are a football journalist writing for a football news app.
${task}

FACTS (this is all you know about the match):
${facts}

RULES:
- 500 to 700 words.
- Use ONLY the facts above. Never invent anything: no scores, goals, players, quotes, records, trophies, history or numbers that are not listed. If a detail is not listed, leave it out.
- Do not state exact season totals for players after this match. Phrase them as "according to the latest top scorers table".
- The focus keyword must be exactly: ${keyword}
${FORMAT_RULES}

Return ONLY a JSON object with exactly these keys:
${JSON_SHAPE}`;
}

// ---------- Reading what the sync job saved ----------
// sync.js saves lists as cache/{key}__meta and cache/{key}__0, __1, ...
async function readCache(key) {
  const meta = await db.doc(`cache/${key}__meta`).get();
  if (!meta.exists) return null;
  const chunks = meta.data().chunks ?? 0;
  const items = [];
  for (let i = 0; i < chunks; i++) {
    const part = await db.doc(`cache/${key}__${i}`).get();
    if (!part.exists) return null;
    const decoded = JSON.parse(part.data().json);
    if (Array.isArray(decoded)) items.push(...decoded);
  }
  return items;
}

const ord = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const when = (ts) =>
  new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const rec = (r) =>
  r ? `W${r.win ?? "?"} D${r.draw ?? "?"} L${r.lose ?? "?"}, goals ${r.goals?.for ?? "?"}-${r.goals?.against ?? "?"} in ${r.played ?? "?"} games` : null;

function topScorerLines(scorers, teamId) {
  return (scorers ?? [])
    .filter((s) => s.statistics?.[0]?.team?.id === teamId)
    .slice(0, 2)
    .map(
      (s) =>
        `${s.player?.name}: ${s.statistics[0].goals?.total ?? "?"} league goals (top scorers table)`
    );
}

// ---------- Facts: preview ----------
async function previewFacts(f) {
  const id = f.fixture.id;
  const home = f.teams.home;
  const away = f.teams.away;
  const lg = f.league;
  const lines = [];
  let extras = 0;

  lines.push(`Competition: ${lg.name}${lg.round ? ` - ${lg.round}` : ""}${lg.country ? ` (${lg.country})` : ""}`);
  lines.push(`Match: ${home.name} (home) vs ${away.name} (away)`);
  lines.push(`Kick-off: ${when(f.fixture.timestamp)}`);
  if (f.fixture.venue?.name) {
    lines.push(`Venue: ${f.fixture.venue.name}${f.fixture.venue.city ? `, ${f.fixture.venue.city}` : ""}`);
  }

  // League table
  const table = await readCache(`standings_${lg.id}_${lg.season}`);
  if (table) {
    for (const [team, side] of [[home, "home"], [away, "away"]]) {
      const r = table.find((x) => x.team?.id === team.id);
      if (!r || !r.rank) continue;
      extras++;
      const a = r.all ?? {};
      lines.push(
        `${team.name}: ${ord(r.rank)} in the table, ${r.points} points from ${a.played} games (W${a.win} D${a.draw} L${a.lose}), goals ${a.goals?.for}-${a.goals?.against}, recent form ${r.form ?? "n/a"}`
      );
      const venueRec = rec(side === "home" ? r.home : r.away);
      if (venueRec) {
        lines.push(`${team.name} ${side} record this season: ${venueRec}`);
      }
    }
  }

  // Head to head
  const low = Math.min(home.id, away.id);
  const high = Math.max(home.id, away.id);
  const h2h = await readCache(`h2h_${low}-${high}`);
  if (h2h) {
    const past = h2h
      .filter((x) => x.goals?.home != null && x.goals?.away != null)
      .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp)
      .slice(0, 5);
    if (past.length) {
      extras++;
      lines.push(`Last ${past.length} meetings (newest first):`);
      const wins = { [home.id]: 0, [away.id]: 0, draws: 0 };
      for (const x of past) {
        const gh = x.goals.home;
        const ga = x.goals.away;
        if (gh > ga) wins[x.teams.home.id]++;
        else if (ga > gh) wins[x.teams.away.id]++;
        else wins.draws++;
        lines.push(
          `- ${x.fixture.date.slice(0, 10)}: ${x.teams.home.name} ${gh}-${ga} ${x.teams.away.name} (${x.league?.name ?? "match"})`
        );
      }
      lines.push(
        `In those ${past.length} meetings: ${home.name} won ${wins[home.id]}, ${away.name} won ${wins[away.id]}, drawn ${wins.draws}`
      );
    }
  }

  // Statistical prediction
  const pred = (await readCache(`predictions_${id}`))?.[0]?.predictions?.percent;
  if (pred) {
    lines.push(
      `Statistical model prediction (not a fact): ${home.name} ${pred.home}, draw ${pred.draw}, ${away.name} ${pred.away}`
    );
  }

  // Absentees
  const injuries = await readCache(`injuries_${id}`);
  if (injuries && injuries.length) {
    for (const team of [home, away]) {
      const out = injuries
        .filter((i) => i.team?.id === team.id)
        .slice(0, 5)
        .map((i) => `${i.player?.name}${i.player?.reason ? ` (${i.player.reason})` : ""}`);
      if (out.length) lines.push(`${team.name} absentees: ${out.join(", ")}`);
    }
  }

  // Top scorers
  const scorers = await readCache(`topscorers_${lg.id}_${lg.season}`);
  for (const team of [home, away]) {
    const l = topScorerLines(scorers, team.id);
    if (l.length) lines.push(`${team.name} top scorers: ${l.join("; ")}`);
  }

  return extras > 0 ? lines.join("\n") : null; // need table or head-to-head
}

// ---------- Facts: report ----------
async function reportFacts(f) {
  const id = f.fixture.id;
  const home = f.teams.home;
  const away = f.teams.away;
  const lg = f.league;
  const lines = [];

  lines.push(`Competition: ${lg.name}${lg.round ? ` - ${lg.round}` : ""}${lg.country ? ` (${lg.country})` : ""}`);
  lines.push(`Final score: ${home.name} ${f.goals.home}-${f.goals.away} ${away.name} (${home.name} at home)`);
  if (f.score?.halftime?.home != null) {
    lines.push(`Half-time: ${f.score.halftime.home}-${f.score.halftime.away}`);
  }
  if (f.fixture.status.short === "AET") lines.push("The match went to extra time.");
  if (f.fixture.status.short === "PEN" && f.score?.penalty) {
    lines.push(`Decided on penalties: ${f.score.penalty.home}-${f.score.penalty.away}`);
  }
  if (f.fixture.venue?.name) {
    lines.push(`Venue: ${f.fixture.venue.name}${f.fixture.venue.city ? `, ${f.fixture.venue.city}` : ""}`);
  }

  const detail = (await readCache(`fixture_${id}`))?.[0];
  const goalScorerNames = [];
  if (detail) {
    const events = detail.events ?? [];
    const goals = events.filter((e) => e.type === "Goal" && e.detail !== "Missed Penalty");
    if (goals.length) {
      lines.push("Goals:");
      for (const e of goals) {
        const tag = e.detail === "Own Goal" ? " (own goal)" : e.detail === "Penalty" ? " (penalty)" : "";
        const assist = e.assist?.name ? `, assist ${e.assist.name}` : "";
        lines.push(
          `- ${e.time?.elapsed}' ${e.player?.name} for ${e.team?.name}${tag}${assist}`
        );
        if (e.player?.name && e.detail !== "Own Goal") goalScorerNames.push(e.player.id);
      }
    }
    const reds = events.filter((e) => e.type === "Card" && e.detail === "Red Card");
    for (const e of reds) {
      lines.push(`Red card: ${e.player?.name} (${e.team?.name}) ${e.time?.elapsed}'`);
    }
    const stat = (teamId, type) =>
      detail.statistics
        ?.find((s) => s.team?.id === teamId)
        ?.statistics?.find((x) => x.type === type)?.value;
    for (const [label, type] of [
      ["Possession", "Ball Possession"],
      ["Total shots", "Total Shots"],
      ["Shots on target", "Shots on Goal"],
      ["Corners", "Corner Kicks"],
    ]) {
      const h = stat(home.id, type);
      const a = stat(away.id, type);
      if (h != null && a != null) lines.push(`${label}: ${home.name} ${h}, ${away.name} ${a}`);
    }
    const formations = (detail.lineups ?? [])
      .map((l) => (l.formation ? `${l.team?.name} ${l.formation}` : null))
      .filter(Boolean);
    if (formations.length) lines.push(`Formations: ${formations.join(", ")}`);
  } else if (f.goals.home + f.goals.away > 0) {
    // No event detail saved: a report with no scorers would be thin.
    return null;
  }

  // Top scorers table for the goal scorers
  const scorers = await readCache(`topscorers_${lg.id}_${lg.season}`);
  if (scorers && goalScorerNames.length) {
    const hits = scorers
      .filter((s) => goalScorerNames.includes(s.player?.id))
      .map(
        (s) =>
          `${s.player?.name}: ${s.statistics?.[0]?.goals?.total ?? "?"} league goals (top scorers table, updated daily)`
      );
    if (hits.length) lines.push(`Top scorers table: ${hits.join("; ")}`);
  }

  return lines.join("\n");
}

// ---------- Saving a draft ----------
async function saveDraft(a, extra) {
  for (const k of ["title", "body", "snippet", "metaDescription", "focusKeyword"]) {
    if (typeof a[k] !== "string" || !a[k].trim()) {
      throw new Error(`Gemini's result is missing "${k}"`);
    }
  }
  const category = CATEGORIES.includes(extra.category)
    ? extra.category
    : CATEGORIES[0];
  return db.collection(DRAFTS).add({
    author: extra.author || AUTHOR,
    title: a.title.trim(),
    subtitle: typeof a.subtitle === "string" ? a.subtitle : "",
    body: a.body,
    snippet: a.snippet.trim(),
    metaDescription: a.metaDescription.trim(),
    focusKeyword: a.focusKeyword.trim(),
    category,
    tags: Array.isArray(a.tags) ? a.tags.map(String) : [],
    image: extra.image || DEFAULT_IMAGE,
    imageAlt: extra.imageAlt || a.imageAlt || "",
    // Edit these on the draft before approving if you want them on.
    footballNow: false,
    latest: true,
    trending: false,
    recommended: false,
    // Workflow fields (not copied into posts)
    approved: false,
    published: false,
    source: extra.source,
    sources: extra.sources ?? [],
    ideaId: extra.ideaId ?? null,
    fixtureId: extra.fixtureId ?? null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// How many drafts of the given kinds were made in the last 24 hours,
// and how many drafts are waiting for review.
async function draftCounts(sources) {
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 3600 * 1000);
  const last24h = await db.collection(DRAFTS).where("createdAt", ">=", since).get();
  const madeToday = last24h.docs.filter((d) => sources.includes(d.data().source)).length;
  const waiting = await db.collection(DRAFTS).where("approved", "==", false).get();
  const pending = waiting.docs.filter((d) => d.data().published !== true).length;
  return { madeToday, pending };
}

// ---------- 1) Publish approved drafts ----------
async function publishApproved() {
  const snap = await db.collection(DRAFTS).where("approved", "==", true).get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.published === true) continue;
    try {
      const {
        approved, published, source, sources, ideaId, fixtureId, createdAt, articleId,
        ...article
      } = d;
      const ref = await db.collection(ARTICLES).add({
        ...article,
        date: new Date().toISOString(),
        // readAt is left out on purpose: the app records it when an
        // article is read, and a brand-new post hasn't been read yet.
        likes: 0,
        likedBy: [],
        commentCount: 0,
      });
      await doc.ref.update({ published: true, articleId: ref.id });
      console.log(`published "${article.title}" -> ${ARTICLES}/${ref.id}`);
    } catch (e) {
      console.log(`publish ${doc.id} failed: ${e.message}`);
    }
  }
}

// ---------- 2) Match reports and previews ----------
function matchScore(f) {
  const w = LEAGUE_WEIGHT[f.league.id] ?? 1;
  const big = [f.teams.home.id, f.teams.away.id].filter((t) =>
    PRIORITY_TEAMS.includes(t)
  ).length;
  return w + 2 * big;
}

async function makeMatchDrafts() {
  if (!AUTO_MATCH) return;
  const { madeToday, pending } = await draftCounts(["match_report", "match_preview"]);
  if (pending >= MAX_PENDING) {
    console.log(`match: ${pending} drafts are waiting for review, skipping`);
    return;
  }
  const howMany = Math.min(MATCH_PER_RUN, MATCH_PER_DAY - madeToday);
  if (howMany <= 0) {
    console.log("match: daily limit reached");
    return;
  }

  const all = [];
  for (const off of [-1, 0, 1]) {
    const items = await readCache(`fixtures_${isoDate(off)}`);
    if (items) all.push(...items);
  }
  const fixtures = all.filter((f) => LEAGUE_IDS.includes(f.league?.id));
  const now = Date.now() / 1000;
  const bestFirst = (a, b) => matchScore(b) - matchScore(a);

  const reports = fixtures
    .filter(
      (f) =>
        FINISHED.includes(f.fixture.status.short) &&
        f.fixture.timestamp < now &&
        now - f.fixture.timestamp < 36 * 3600 &&
        f.goals?.home != null
    )
    .filter((f) => matchScore(f) >= MIN_SCORE)
    .sort(bestFirst);
  const previews = fixtures
    .filter(
      (f) =>
        ["NS", "TBD"].includes(f.fixture.status.short) &&
        f.fixture.timestamp - now > 1800 &&
        f.fixture.timestamp - now < 30 * 3600
    )
    .filter((f) => matchScore(f) >= MIN_SCORE)
    .sort(bestFirst);

  const jobs = [
    ...reports.map((f) => ["report", f]),
    ...previews.map((f) => ["preview", f]),
  ];
  console.log(`match: ${reports.length} finished and ${previews.length} upcoming worth covering`);

  let made = 0;
  let checked = 0;
  let failures = 0;
  for (const [kind, f] of jobs) {
    if (made >= howMany || checked >= 40 || failures >= 2) break;
    checked++;
    const id = f.fixture.id;
    const key = `${kind}_${id}`;
    if ((await db.doc(`${LOG}/${key}`).get()).exists) continue;

    try {
      const facts = kind === "report" ? await reportFacts(f) : await previewFacts(f);
      if (!facts) {
        console.log(`match ${key}: not enough data yet, skipping for now`);
        continue;
      }
      const { text } = await gemini(matchPrompt(kind, f, facts));
      const a = parseJson(text);
      const ref = await saveDraft(a, {
        category: CATEGORIES[0],
        imageAlt: a.imageAlt || `${f.teams.home.name} vs ${f.teams.away.name}`,
        source: kind === "report" ? "match_report" : "match_preview",
        fixtureId: id,
      });
      await db.doc(`${LOG}/${key}`).set({
        draftId: ref.id,
        at: admin.firestore.FieldValue.serverTimestamp(),
      });
      made++;
      console.log(`match ${kind} draft: "${a.title}" (${DRAFTS}/${ref.id})`);
    } catch (e) {
      failures++;
      console.log(`match ${key} failed: ${e.message}`);
    }
  }
}

// ---------- 3) Trending drafts (needs billing) ----------
async function makeTrendingDrafts() {
  if (!AUTO_TRENDING) return;
  const { madeToday, pending } = await draftCounts(["trending"]);
  if (pending >= MAX_PENDING) {
    console.log(`trending: ${pending} drafts are waiting for review, skipping`);
    return;
  }
  const howMany = Math.min(TRENDING_PER_RUN, TRENDING_PER_DAY - madeToday);
  if (howMany <= 0) {
    console.log("trending: daily limit reached");
    return;
  }

  const recent = await db
    .collection(DRAFTS)
    .orderBy("createdAt", "desc")
    .limit(15)
    .get();
  const avoid = recent.docs.map((d) => d.data().title).filter(Boolean);

  for (let i = 0; i < howMany; i++) {
    try {
      const { text, sources } = await gemini(trendingPrompt(avoid), { search: true });
      const a = parseJson(text);
      const ref = await saveDraft(a, {
        category: a.category,
        source: "trending",
        sources,
      });
      avoid.push(a.title);
      console.log(`trending draft: "${a.title}" (${DRAFTS}/${ref.id})`);
    } catch (e) {
      console.log(`trending draft failed: ${e.message}`);
    }
  }
}

// ---------- 4) Drafts from your own notes (optional) ----------
async function makeNoteDrafts() {
  const snap = await db
    .collection(IDEAS)
    .where("status", "==", "new")
    .limit(MAX_NOTES_PER_RUN)
    .get();

  for (const doc of snap.docs) {
    const idea = doc.data();
    try {
      if (!idea.topic || !idea.category) {
        throw new Error("a note needs both a topic and a category");
      }
      const { text } = await gemini(notesPrompt(idea));
      const a = parseJson(text);
      const ref = await saveDraft(a, {
        category: idea.category,
        author: idea.author,
        image: idea.image,
        imageAlt: idea.imageAlt,
        source: "note",
        ideaId: doc.id,
      });
      await doc.ref.update({ status: "done", draftId: ref.id });
      console.log(`note draft: "${a.title}" (${DRAFTS}/${ref.id})`);
    } catch (e) {
      console.log(`note ${doc.id} failed: ${e.message}`);
      await doc.ref.update({
        status: "error",
        error: String(e.message).slice(0, 300),
      });
    }
  }
}

await publishApproved();
await makeMatchDrafts();
await makeTrendingDrafts();
await makeNoteDrafts();
console.log("Articles job done");
process.exit(0);
