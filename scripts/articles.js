import admin from "firebase-admin";

// Article automation. Each run does this, in order:
//   1) PUBLISH: drafts in `article_drafts` that you set approved=true are
//      copied into your real `posts` collection.
//   2) MATCH ARTICLES (free): match REPORTS for games that just finished and
//      match PREVIEWS for games kicking off soon. The facts come from the
//      data your sync job already saved in Firestore (cache/*), and Gemini
//      only writes the words. No Google Search needed.
//   3) TRENDING: a football topic that is trending right now. Free mode reads
//      Google Trends plus its news headlines; "search" mode (needs Google
//      billing) lets Gemini search Google. Set TRENDING=off/trends/search.
//   4) EVERGREEN: Gemini picks a timeless football topic (rules, tactics,
//      rivalries, history, legends) and writes a general article.
//   5) NOTES: your own keywords/notes in `article_ideas` with status "new".
// Drafts are saved in `posts` with status "draft", so they appear in your
// dashboard like drafts you wrote yourself. Publish them from the dashboard.

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
// The category values your app uses.
const CATEGORIES = ["club", "national", "transfers"];
const CATEGORY_HELP =
  `"club" (club football news and analysis), "national" (national team news), "transfers" (transfers and gossip)`;
// Competitions that count as national-team news.
const NATIONAL_LEAGUES = [1, 4]; // World Cup, European Championship

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
// Used automatically when the main model says it is overloaded.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite";
const AUTO_MATCH = process.env.AUTO_MATCH !== "off";       // match reports + previews
// TRENDING: "trends" (free, default) = Google Trends + its headlines,
// "search" = Gemini searches Google (needs billing), "off" = none.
const TRENDING = process.env.TRENDING || "trends";
const EVERGREEN = process.env.EVERGREEN !== "off";         // timeless explainers
const TRENDS_GEOS = ["GB", "US", "GH", "NG"];              // countries to read trends from

const MATCH_PER_RUN = 2;        // match drafts per run
const MATCH_PER_DAY = 6;        // match drafts per 24 hours
const TRENDING_PER_RUN = 1;
const TRENDING_PER_DAY = 5;
const EVERGREEN_PER_RUN = 1;
const EVERGREEN_PER_DAY = 3;
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
async function geminiOnce(prompt, { search = false } = {}, model = MODEL) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
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

async function gemini(prompt, opts = {}) {
  try {
    return await geminiOnce(prompt, opts);
  } catch (e) {
    const busy = String(e.message).startsWith("Gemini is busy");
    if (opts.search || !busy || FALLBACK_MODEL === MODEL) throw e;
    console.log(`${MODEL} is busy, trying ${FALLBACK_MODEL}`);
    return geminiOnce(prompt, opts, FALLBACK_MODEL);
  }
}

function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Gemini's reply had no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

const FORMAT_RULES = `- In your own original wording. Never copy sentences from any source and never quote people.
- "body" is HTML using only <p>, <h2>, <strong>, <ul> and <li>. No <h1>, no images, no links.
- READABILITY: write SHORT paragraphs. Every <p> has 1 to 3 sentences and about 40 words at most, never more. Sentences average about 20 words or fewer, in plain simple words. Break each <h2> section into several short paragraphs so it is easy to read on a phone.
- KEYWORD DENSITY: the exact focus keyword phrase must appear in the body text about once every 50 to 60 words (a density of roughly 1.5% to 2.2%, never above 2.5%), whatever the article's length. Do NOT change how long the article is to reach this; keep the length asked for above. Use it in the first paragraph, in some <h2> headings, and spread evenly through the article, written naturally. Do not count the title.
- "snippet": the first one or two sentences as plain text, at most 200 characters.
- "metaDescription": plain text, at most 155 characters, containing the focus keyword.
- "tags": 3 to 6 short lowercase tags.
- "imageAlt": a short description of a suitable image.
- "mainSubject": the ONE person, club, national team or stadium the article is mostly about, as a real name that photographers would label (for example "Cristiano Ronaldo" or "Manchester City"). All the article's photos will be photos of this subject, so name it precisely.`;

const JSON_SHAPE = `{"title": "", "subtitle": "", "body": "", "snippet": "", "metaDescription": "", "focusKeyword": "", "tags": [], "imageAlt": "", "mainSubject": ""}`;

// ---------- Images (free-licensed, with credit) ----------
// Every photo in an article is a photo of the article's MAIN SUBJECT (for
// example Cristiano Ronaldo): one featured image and up to two more inside
// the body. A photo is only accepted if the subject's name appears in the
// photo's own title, categories or description, so a photo of somebody else
// is never used. Photos come from Wikimedia Commons (and, for timeless
// articles only, Openverse). Only licences that allow this use are accepted
// (CC BY, CC BY-SA, CC0, public domain) and every photo is credited.
//
// era "current": news and match articles. Only photos taken in the last two
//   years are used (the photo's own date must be known), so an old picture is
//   never used for a current story.
// era "any": timeless articles. Any date is fine, newest preferred.
const WIKI_UA = "FootballPostArticleBot/1.0 (GitHub Actions article job)";
const FREE_LICENSE = /^(cc[ -]?by|cc0|public domain|pd)/i;
const BAD_LICENSE = /\b(nc|nd)\b|fair use|non-?commercial|no derivatives/i;
const MAX_PHOTO_AGE_YEARS = 2;
const esc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const yearOf = (text) => {
  const m = /(?:19|20)\d{2}/.exec(text ?? "");
  return m ? Number(m[0]) : null;
};
const norm = (x) =>
  String(x ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// True when every word of the subject's name appears in the text.
const mentions = (text, subject) => {
  const hay = norm(text);
  const words = norm(subject).split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return words.length > 0 && words.every((w) => hay.includes(w));
};

// Wikimedia Commons: usable photos of `subject`, in relevance order.
async function commonsCandidates(term, subject) {
  try {
    const url =
      "https://commons.wikimedia.org/w/api.php?" +
      new URLSearchParams({
        action: "query",
        format: "json",
        generator: "search",
        gsrnamespace: "6",
        gsrsearch: `${term} filetype:bitmap`,
        gsrlimit: "40",
        prop: "imageinfo",
        iiprop: "url|size|mime|extmetadata",
        iiurlwidth: "1200",
      });
    const res = await fetch(url, { headers: { "User-Agent": WIKI_UA } });
    if (!res.ok) {
      console.log(`image search "${term}": HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const pages = Object.values(data.query?.pages ?? {}).sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0)
    );
    const out = [];
    for (const p of pages) {
      const info = p.imageinfo?.[0];
      if (!info || !/^image\/(jpeg|png|webp)$/.test(info.mime)) continue;
      if (info.width < 900 || info.width < info.height) continue;
      const meta = info.extmetadata ?? {};
      const license = (meta.LicenseShortName?.value ?? "").trim();
      if (!license || !FREE_LICENSE.test(license) || BAD_LICENSE.test(license)) continue;
      // The photo must really be of the subject.
      const about = [
        p.title,
        meta.ObjectName?.value,
        meta.Categories?.value,
        meta.ImageDescription?.value,
      ].map((v) => decode(String(v ?? ""))).join(" ");
      if (!mentions(about, subject)) continue;
      const artist = decode(meta.Artist?.value ?? "") || "Unknown author";
      const page = info.descriptionurl;
      out.push({
        url: info.thumburl || info.url,
        page,
        year: yearOf(decode(meta.DateTimeOriginal?.value ?? "")),
        credit: `${artist}, ${license} (Wikimedia Commons)`,
        creditHtml: `<a href="${page}">${esc(artist)}</a>, ${esc(license)} (Wikimedia Commons)`,
      });
    }
    return out;
  } catch (e) {
    console.log(`image search "${term}" failed: ${e.message}`);
    return [];
  }
}

// Openverse (free-licensed photos from Flickr and others). It does not say
// when a photo was taken, so it is only used for timeless articles.
async function openversePhotos(subject, exclude) {
  const out = [];
  try {
    const url =
      "https://api.openverse.org/v1/images/?" +
      new URLSearchParams({
        q: subject,
        license_type: "commercial",
        category: "photograph",
        page_size: "20",
      });
    const res = await fetch(url, { headers: { "User-Agent": WIKI_UA } });
    if (!res.ok) {
      console.log(`openverse "${subject}": HTTP ${res.status}`);
      return out;
    }
    const data = await res.json();
    for (const r of data.results ?? []) {
      const lic = String(r.license ?? "").toLowerCase();
      if (!["by", "by-sa", "cc0", "pdm"].includes(lic)) continue;
      const imageUrl = r.thumbnail || r.url;
      if (!imageUrl || exclude.has(imageUrl)) continue;
      if (r.width && r.width < 900) continue;
      const about = `${r.title ?? ""} ${(r.tags ?? []).map((t) => t.name).join(" ")}`;
      if (!mentions(about, subject)) continue;
      const licName =
        lic === "cc0" ? "CC0" : lic === "pdm" ? "Public domain"
          : `CC ${lic.toUpperCase()}${r.license_version ? ` ${r.license_version}` : ""}`;
      const creator = r.creator || "Unknown author";
      const where = r.source || "Openverse";
      const page = r.foreign_landing_url || r.url;
      out.push({
        url: imageUrl,
        page,
        credit: `${creator}, ${licName} (${where})`,
        creditHtml: `<a href="${page}">${esc(creator)}</a>, ${esc(licName)} (${esc(where)})`,
      });
    }
  } catch (e) {
    console.log(`openverse "${subject}" failed: ${e.message}`);
  }
  return out;
}

// Up to `count` DIFFERENT photos of `subject`. Fewer (or none) is fine:
// a missing photo is better than a photo of somebody else.
async function findImages(subject, { era = "any", count = 3 } = {}) {
  const thisYear = new Date().getUTCFullYear();
  // For current stories, try the current and previous year in the search
  // first: file names on Commons often carry the year.
  const terms =
    era === "current"
      ? [`${subject} ${thisYear}`, `${subject} ${thisYear - 1}`, subject]
      : [subject];

  const photos = [];
  const used = new Set();
  const take = (list) => {
    for (const c of list) {
      if (photos.length >= count) return;
      if (used.has(c.url)) continue;
      used.add(c.url);
      photos.push({ ...c, alt: subject });
    }
  };

  for (const term of terms) {
    if (photos.length >= count) break;
    const list = (await commonsCandidates(term, subject)).slice(0, 15);
    const pool =
      era === "current"
        ? list.filter((c) => c.year && c.year >= thisYear - MAX_PHOTO_AGE_YEARS)
        : [...list].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    take(pool);
  }
  if (era !== "current" && photos.length < count) {
    take(await openversePhotos(subject, used));
  }
  console.log(`images for "${subject}" (${era}): found ${photos.length} of ${count}`);
  return photos;
}

// Puts credited photos inside the article body: one after the third
// paragraph and one about two-thirds of the way down.
function addBodyImages(html, photos) {
  if (!photos.length) return html;
  const parts = html.split("</p>");
  const n = parts.length - 1; // number of paragraphs
  if (n < 1) return html;
  const block = (p) =>
    `<p><img src="${p.url}" alt="${esc(p.alt)}"></p><p><small><em>Photo: ${p.creditHtml}</em></small></p>`;
  const spots = new Map();
  const first = Math.min(2, n - 1);
  spots.set(first, photos[0]);
  if (photos[1]) {
    const second = Math.min(Math.max(first + 2, Math.floor(n * 0.65)), n - 1);
    if (second > first) spots.set(second, photos[1]);
  }
  let out = "";
  for (let i = 0; i < n; i++) {
    out += parts[i] + "</p>";
    if (spots.has(i)) out += block(spots.get(i));
  }
  return out + parts[n];
}

// ---------- Prompts ----------
function notesPrompt(idea) {
  const keywordOnly = !idea.topic && idea.keyword;
  const material = keywordOnly
    ? `The editor gave only a keyword: "${idea.keyword}". Write a general, evergreen article about it.`
    : `EDITOR'S NOTES:\n${idea.topic}`;
  const factRule = keywordOnly
    ? `- Be specific, not vague: give concrete examples with real player names, club names, managers, trophies and seasons (for example, name the key players of a great era and the famous moments they were part of). Use ONLY examples and details you are completely certain are true and well documented; if you are not sure of a name, year, score or who did what, leave that detail out instead of guessing. Do NOT include current-season statistics, recent results, transfers or injuries. Never invent quotes.`
    : `- Use ONLY the facts, names, scores and dates found in the notes. Never invent statistics, quotes, transfers, injuries or results. If the notes are only a general topic, write general evergreen analysis with no specific claims.`;
  const keywordRule = idea.keyword
    ? `\n- The focus keyword must be exactly: ${idea.keyword}`
    : "";
  return `You are a football journalist writing for a football news app.
Write one article from the material below.

${material}

CATEGORY: ${idea.category}

RULES:
- 600 to 800 words.
${factRule}${keywordRule}
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

STEP 1: Use Google Search to find ONE football topic that is trending right now (a big match or result, a transfer story, a manager or injury story, a tournament). Choose one that fits one of these categories: ${CATEGORY_HELP}.
STEP 2: Choose the focus keyword that people are most likely to be searching for about that topic.
STEP 3: Write an original article about it.
${avoid}
RULES:
- 600 to 800 words.
- Use only facts you found in the search results. Never invent statistics, scores, quotes, transfers or injuries. If you are not sure of a fact, leave it out.
${FORMAT_RULES}

Return ONLY a JSON object with exactly these keys:
{"title": "", "subtitle": "", "body": "", "snippet": "", "metaDescription": "", "focusKeyword": "", "tags": [], "imageAlt": "", "mainSubject": "", "category": ""}`;
}

function evergreenPrompt(avoidTitles) {
  const avoid = avoidTitles.length
    ? `\nDo NOT write about these topics, they are already covered:\n${avoidTitles.map((t) => `- ${t}`).join("\n")}\n`
    : "";
  return `You are a football journalist writing for a football news app.

STEP 1: Choose ONE evergreen football topic that readers search for year after year, for example: how a rule works, a tactic or formation explained, a playing position explained, a famous rivalry, a club's history, a legendary player's career, a famous tournament, or a beginner's guide. Choose one that fits one of these categories: ${CATEGORY_HELP}.
STEP 2: Choose the focus keyword people would search for about that topic.
STEP 3: Write a general, evergreen article about it.
${avoid}
RULES:
- 800 to 1,000 words.
- Be specific, not vague: give concrete examples with real player names, club names, managers, trophies and seasons (for example, name the key players of a great era and the famous moments they were part of). Use ONLY examples and details you are completely certain are true and well documented; if you are not sure of a name, year, score or who did what, leave that detail out instead of guessing. Do NOT include current-season statistics, recent results, transfers or injuries. Never invent quotes.
${FORMAT_RULES}

Return ONLY a JSON object with exactly these keys:
{"title": "", "subtitle": "", "body": "", "snippet": "", "metaDescription": "", "focusKeyword": "", "tags": [], "imageAlt": "", "mainSubject": "", "category": ""}`;
}

// Reads the text of the news pages linked to a trend, so the article can
// explain what is really happening (the headlines alone are too thin).
async function sourceNotes(news) {
  const out = [];
  for (const n of news.slice(0, 3)) {
    if (!n.url) continue;
    try {
      const res = await fetch(n.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; FootballPostBot/1.0)" },
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) continue;
      const html = (await res.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
      const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((m) => decode(m[1]))
        .filter((x) => x.length > 60);
      const text = paras.join(" ").slice(0, 3500);
      if (text.length > 300) out.push(text);
    } catch (e) {
      // page blocked or slow: skip it, the headlines still work
    }
  }
  return out;
}

function trendsPrompt(t) {
  const news = t.news
    .slice(0, 5)
    .map((n) => `- ${n.title}${n.snippet ? ` | ${n.snippet}` : ""}`)
    .join("\n");
  const today = new Date().toISOString().slice(0, 10);
  const notes = (t.notes ?? []).length
    ? `\nSOURCE NOTES (background text from news pages about the story):\n${t.notes.map((x, i) => `[${i + 1}] ${x}`).join("\n")}\n`
    : "";
  return `You are a football journalist writing for a football news app. Today is ${today}.
A search term is trending right now: "${t.term}".
These news headlines are linked to it:
${news}
${notes}
This is all you know about the story. Write an original, detailed article about it.

RULES:
- First decide whether this is clearly about football (soccer) as a sport: a match, club, player, manager, transfer, competition or national team. If it is NOT (for example health, charity, other sports or general news), return ONLY {"isFootball": false} and nothing else.
- 400 to 600 words.
- Answer who, what, when, where and why. Be specific: use the names, numbers, scores and dates found in the headlines and source notes. If they explain WHY something is happening, explain it clearly. If the date or time of the event is given, state it in the first paragraph; if it is not given, do not guess it.
- Use ONLY the facts in the headlines and source notes, plus well-established background you are completely sure of. Never invent scores, quotes, transfers, injuries, numbers or dates. If something is not known, leave it out and write a shorter article rather than guess.
- Rewrite everything completely in your own words. Never copy sentences from the notes and never quote people.
- The focus keyword must be exactly: ${t.term}
- Choose one of these categories: ${CATEGORY_HELP}
${FORMAT_RULES}

Return ONLY a JSON object with exactly these keys:
{"title": "", "subtitle": "", "body": "", "snippet": "", "metaDescription": "", "focusKeyword": "", "tags": [], "imageAlt": "", "mainSubject": "", "category": ""}`;
}

function matchPrompt(kind, f, facts) {
  const home = f.teams.home.name;
  const away = f.teams.away.name;
  const keyword = kind === "report"
    ? `${home} vs ${away} match report`
    : `${home} vs ${away} preview`;
  const length = kind === "report"
    ? "- 500 to 700 words when the facts are rich (goals, line-ups, player stats); 350 to 500 words when they are thin. Never pad with filler or invent details to reach the length."
    : "- 500 to 700 words.";
  const task = kind === "report"
    ? `Write a detailed MATCH REPORT. Open with the date, the competition and the venue. Then tell the story of the game: name every goalscorer with the minute and who assisted, mention the cards, the formations and starting players (with shirt numbers where listed), the standout performers using the ratings, goals, assists, shots and key passes given, and the key numbers (possession, shots, corners). Be specific, with player names and figures, and use as many of the listed facts as read well.`
    : `Write a MATCH PREVIEW. State the date and kick-off time in the first paragraph. Set the scene, compare the two teams' league position and form, summarise their recent meetings, mention home advantage and absentees, and say what to watch for. Do not predict a score as if it were fact; if you mention the statistical prediction, say it comes from a statistical model.`;
  return `You are a football journalist writing for a football news app.
${task}

FACTS (this is all you know about the match):
${facts}

RULES:
${length}
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
const day = (ts) =>
  new Date(ts * 1000).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
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
  lines.push(`Date: ${day(f.fixture.timestamp)}`);
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
  lines.push(`Date played: ${day(f.fixture.timestamp)} (kick-off ${when(f.fixture.timestamp)})`);
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
    const yellows = events.filter((e) => e.type === "Card" && e.detail === "Yellow Card");
    if (yellows.length) {
      lines.push(
        `Yellow cards: ${yellows.map((e) => `${e.player?.name} (${e.team?.name}) ${e.time?.elapsed}'`).join(", ")}`
      );
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
    const elevens = (detail.lineups ?? [])
      .map((l) => {
        const names = (l.startXI ?? []).map(
          (x) => `${x.player?.name} (#${x.player?.number}${x.player?.pos ? `, ${x.player.pos}` : ""})`
        );
        return names.length
          ? `${l.team?.name} starting XI${l.coach?.name ? ` (coach ${l.coach.name})` : ""}: ${names.join(", ")}`
          : null;
      })
      .filter(Boolean);
    if (elevens.length) {
      lines.push("Position codes: G goalkeeper, D defender, M midfielder, F forward");
      lines.push(...elevens);
    }
  } else if (f.goals.home + f.goals.away > 0) {
    // No event detail saved: a report with no scorers would be thin.
    return null;
  }

  // Standout performers, from the saved player statistics
  const pdata = await readCache(`players_${id}`);
  if (pdata) {
    const all = [];
    for (const t of pdata) {
      for (const pl of t.players ?? []) {
        const st = pl.statistics?.[0];
        const rating = parseFloat(st?.games?.rating);
        if (Number.isFinite(rating)) {
          all.push({ name: pl.player?.name, team: t.team?.name, rating, st });
        }
      }
    }
    all.sort((x, y) => y.rating - x.rating);
    const top = all.slice(0, 4).map(
      (p) =>
        `${p.name} (${p.team}) rating ${p.rating.toFixed(1)}, ${p.st.goals?.total ?? 0} goals, ${p.st.goals?.assists ?? 0} assists, ${p.st.shots?.total ?? 0} shots, ${p.st.passes?.key ?? 0} key passes`
    );
    if (top.length) lines.push(`Highest-rated players (match data ratings): ${top.join("; ")}`);
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

// ---------- Keyword density ----------
// Density = how often the exact keyword phrase appears in the article body,
// as a percentage of all words. Target 1.5% to 2.2%, never above 2.5%.
const KD_MAX = 2.5;
const plainText = (html) =>
  html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function keywordStats(body, keyword) {
  const text = plainText(body);
  const words = text ? text.split(" ").length : 0;
  const pattern = keyword
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  const count = (text.match(new RegExp(pattern, "gi")) ?? []).length;
  return { words, count, density: words ? (count / words) * 100 : 0 };
}

function densityPrompt(a, lo, hi) {
  return `Below is a football article body (HTML) and its focus keyword.
Rewrite the body so the exact phrase "${a.focusKeyword}" appears between ${lo} and ${hi} times in the body text (case does not matter), spread evenly: in the first paragraph, in some <h2> headings, and through the rest. Keep it natural.

RULES:
- Keep the same facts, structure and roughly the same length. Do not add any new facts, numbers or quotes.
- Keep the paragraphs short: 1 to 3 sentences each.
- Keep using only <p>, <h2>, <strong>, <ul> and <li>.

FOCUS KEYWORD: ${a.focusKeyword}

BODY:
${a.body}

Return ONLY a JSON object: {"body": ""}`;
}

// Checks the body's keyword density and, if it is outside the target,
// asks Gemini (up to twice) to adjust the wording. Records the result.
async function fixDensity(a) {
  const long = a.focusKeyword.trim().split(/\s+/).length > 3;
  // Very long keyword phrases read badly when repeated, so allow a lower floor.
  const min = long ? 1.0 : 1.5;
  const aimLo = long ? 1.2 : 1.6;
  const aimHi = long ? 1.8 : 2.2;

  for (let i = 0; i < 2; i++) {
    const st = keywordStats(a.body, a.focusKeyword);
    if (st.density >= min && st.density <= KD_MAX) break;
    const lo = Math.max(1, Math.ceil((st.words * aimLo) / 100));
    const hi = Math.max(lo, Math.floor((st.words * aimHi) / 100));
    console.log(
      `keyword density ${st.density.toFixed(2)}% (${st.count}x in ${st.words} words), rewriting to ${lo}-${hi}x`
    );
    try {
      const { text } = await gemini(densityPrompt(a, lo, hi));
      const r = parseJson(text);
      if (typeof r.body === "string" && r.body.length > 200) a.body = r.body;
    } catch (e) {
      console.log(`density rewrite failed: ${e.message}`);
      break;
    }
  }
  const fin = keywordStats(a.body, a.focusKeyword);
  a.keywordDensity = Number(fin.density.toFixed(2));
  console.log(`keyword density final: ${a.keywordDensity}% (${fin.count}x in ${fin.words} words)`);
  return a;
}

// ---------- Saving a draft ----------
async function saveDraft(a, extra) {
  for (const k of ["title", "body", "snippet", "metaDescription", "focusKeyword"]) {
    if (typeof a[k] !== "string" || !a[k].trim()) {
      throw new Error(`Gemini's result is missing "${k}"`);
    }
  }
  a = await fixDensity(a);

  const category = CATEGORIES.includes(extra.category)
    ? extra.category
    : CATEGORIES[0];

  // Photos: a featured image plus two inside the body. Your own image
  // (from a note) replaces the featured one. Each photo is a free-licensed
  // photo of a subject in the article, with its credit. Current stories only
  // get recent photos; if none is found the default image is used.
  let image = extra.image || null;
  let imageCredit = "";
  let imageSource = "";
  let bodyHtml = a.body;
  const subject = String(
    a.mainSubject || a.imageSearches?.[0] || a.imageSearch || ""
  ).trim();
  const photos = subject
    ? await findImages(subject, { era: extra.era ?? "any", count: image ? 2 : 3 })
    : [];
  if (!image && photos.length) {
    const featured = photos.shift();
    image = featured.url;
    imageCredit = featured.credit;
    imageSource = featured.page;
    bodyHtml = `<p><small>Photo: ${featured.creditHtml}</small></p>` + bodyHtml;
  }
  bodyHtml = addBodyImages(bodyHtml, photos.slice(0, 2));

  // The draft is saved in `posts` exactly like a draft written in your
  // dashboard (status "draft"), so it shows up there. Its document ID is
  // readable, and a reversed-time number makes the NEWEST draft sort first.
  // The leading "-" also puts these before the random IDs.
  const reversed = String(9999999999 - Math.floor(Date.now() / 1000)).padStart(10, "0");
  const ref = db.collection(ARTICLES).doc(`-${reversed}-${slug(a.title).replace(/^-+|-+$/g, "")}`);
  await ref.set({
    author: extra.author || AUTHOR,
    body: bodyHtml,
    category,
    commentCount: 0,
    date: new Date().toISOString(),
    focusKeyword: a.focusKeyword.trim(),
    image: image || DEFAULT_IMAGE,
    imageAlt: extra.imageAlt || a.imageAlt || "",
    likedBy: [],
    likes: 0,
    metaDescription: a.metaDescription.trim(),
    snippet: a.snippet.trim(),
    status: "draft",
    subtitle: typeof a.subtitle === "string" ? a.subtitle : "",
    tags: Array.isArray(a.tags) ? a.tags.map(String) : [],
    title: a.title.trim(),
    // Page blocks. Each kind of article sets its own; flip any of them in
    // the dashboard before you publish.
    ...{
      latestStories: true,
      recommended: false,
      trending: false,
      ...(extra.flags ?? {}),
    },
    // Everything the script adds, kept together in one field.
    aiMeta: {
      source: extra.source,
      sources: extra.sources ?? [],
      keywordDensity: a.keywordDensity ?? null,
      imageCredit,
      imageSource,
      ideaId: extra.ideaId ?? null,
      fixtureId: extra.fixtureId ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  });
  return ref;
}

// How many script drafts of the given kinds were made in the last 24 hours,
// and how many script drafts are still waiting in the dashboard (status
// "draft"). Drafts you wrote yourself are not counted.
async function draftCounts(sources) {
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 3600 * 1000);
  const made = await db.collection(ARTICLES).where("aiMeta.createdAt", ">=", since).get();
  const madeToday = made.docs.filter((d) => sources.includes(d.data().aiMeta?.source)).length;

  const drafts = await db.collection(ARTICLES).where("status", "==", "draft").get();
  const mine = drafts.docs.filter((d) => d.data().aiMeta);
  const pending = mine.length;
  if (pending >= MAX_PENDING) {
    console.log(`waiting for review (${pending}): ${mine.map((d) => d.data().title).join(" | ")}`);
  }
  return { madeToday, pending };
}

// Published drafts stay in article_drafts (the article itself is in posts).
// This removes them after a while so the collection stays tidy.
const KEEP_PUBLISHED_DAYS = 7; // set to 0 to never delete
async function cleanupPublishedDrafts() {
  if (!KEEP_PUBLISHED_DAYS) return;
  const snap = await db.collection(DRAFTS).where("published", "==", true).get();
  const cutoff = Date.now() - KEEP_PUBLISHED_DAYS * 86400000;
  for (const d of snap.docs) {
    const at = d.data().createdAt?.toMillis?.() ?? 0;
    if (at && at < cutoff) {
      await d.ref.delete();
      console.log(`removed old published draft "${d.data().title ?? d.id}"`);
    }
  }
}

// ---------- 1) Publish approved drafts ----------
async function publishApproved() {
  const snap = await db.collection(DRAFTS).where("approved", "==", true).get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.published === true) continue;
    try {
      const {
        approved, published, source, sources, ideaId, fixtureId, keywordDensity, createdAt, articleId,
        ...article
      } = d;
      const ref = await db.collection(ARTICLES).add({
        ...article,
        status: "published",
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
        category: NATIONAL_LEAGUES.includes(f.league.id) ? "national" : "club",
        era: "current",
        imageAlt: a.imageAlt || `${f.teams.home.name} vs ${f.teams.away.name}`,
        source: kind === "report" ? "match_report" : "match_preview",
        fixtureId: id,
      });
      await db.doc(`${LOG}/${key}`).set({
        draftId: ref.id,
        at: admin.firestore.FieldValue.serverTimestamp(),
      });
      made++;
      console.log(`match ${kind} draft: "${a.title}" (${ARTICLES}/${ref.id})`);
    } catch (e) {
      failures++;
      console.log(`match ${key} failed: ${e.message}`);
    }
  }
}

// ---------- 3) Trending drafts ----------
const decode = (x) =>
  x
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, "")
    .trim();
const tagText = (x, name) => {
  const m = x.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};
const slug = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);

const FOOTBALL_WORDS = /\b(football|soccer|premier league|champions league|europa league|conference league|la liga|serie a|bundesliga|ligue 1|world cup|euros|euro 2028|fa cup|carabao cup|efl|transfer window|striker|goalkeeper|midfielder|arsenal|chelsea|liverpool|tottenham|spurs|manchester united|man utd|manchester city|man city|newcastle|west ham|aston villa|everton|brighton|barcelona|real madrid|atletico madrid|bayern|dortmund|psg|paris saint-germain|juventus|inter milan|ac milan|napoli|ajax|benfica|porto|celtic|rangers|super eagles|black stars|three lions|afcon)\b/i;
const NOT_FOOTBALL = /\b(nfl|nba|mlb|nhl|super bowl|cricket|rugby|wwe|ufc|afl|quarterback|touchdown|college football|ncaa|nascar|formula 1|f1|cancer|awareness|treatment|therapy|wellness|disease|diet|nutrition|fitness|workout|weight loss|charity|foundation)\b/i;

// Reads Google's free "trending searches" feed and keeps the football ones.
async function fetchTrends() {
  const found = [];
  for (const geo of TRENDS_GEOS) {
    try {
      const res = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) {
        console.log(`trends ${geo}: HTTP ${res.status}`);
        continue;
      }
      const xml = await res.text();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const block = m[1];
        const term = tagText(block, "title");
        const news = [...block.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g)]
          .map((n) => ({
            title: tagText(n[1], "ht:news_item_title"),
            snippet: tagText(n[1], "ht:news_item_snippet"),
            url: tagText(n[1], "ht:news_item_url"),
          }))
          .filter((n) => n.title);
        const text = `${term} ${news.map((n) => `${n.title} ${n.snippet}`).join(" ")}`;
        if (!term || NOT_FOOTBALL.test(text) || !FOOTBALL_WORDS.test(text)) continue;
        if (!found.some((x) => x.term.toLowerCase() === term.toLowerCase())) {
          found.push({ term, news, geo });
        }
      }
    } catch (e) {
      console.log(`trends ${geo} failed: ${e.message}`);
    }
  }
  return found;
}

async function recentTitles() {
  const titles = [];
  try {
    const posts = await db.collection(ARTICLES).orderBy("date", "desc").limit(50).get();
    for (const d of posts.docs) {
      const t = d.data().title;
      if (t) titles.push(t);
    }
  } catch (e) {
    console.log(`could not read recent posts: ${e.message}`);
  }
  return titles;
}

async function makeTrendingDrafts() {
  if (TRENDING === "off") return;
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

  // Paid mode: Gemini searches Google itself (needs billing on Google).
  if (TRENDING === "search") {
    const avoid = await recentTitles();
    for (let i = 0; i < howMany; i++) {
      try {
        const { text, sources } = await gemini(trendingPrompt(avoid), { search: true });
        const a = parseJson(text);
        const ref = await saveDraft(a, {
          category: a.category,
          source: "trending",
          flags: { trending: true },
          era: "current",
          sources,
        });
        avoid.push(a.title);
        console.log(`trending draft: "${a.title}" (${ARTICLES}/${ref.id})`);
      } catch (e) {
        console.log(`trending draft failed: ${e.message}`);
      }
    }
    return;
  }

  // Free mode: Google Trends list + its headlines, no Gemini search.
  const trends = await fetchTrends();
  console.log(`trending: ${trends.length} football topics found in Google Trends`);
  let made = 0;
  let failures = 0;
  for (const t of trends) {
    if (made >= howMany || failures >= 2) break;
    const key = `trend_${slug(t.term)}`;
    const seen = await db.doc(`${LOG}/${key}`).get();
    if (seen.exists) {
      const at = seen.data().at?.toMillis?.() ?? 0;
      if (Date.now() - at < 5 * 86400000) continue; // covered in the last 5 days
    }
    try {
      t.notes = await sourceNotes(t.news);
      const { text } = await gemini(trendsPrompt(t));
      const a = parseJson(text);
      if (a.isFootball === false) {
        console.log(`trending "${t.term}": not football, skipped`);
        await db.doc(`${LOG}/${key}`).set({
          skipped: true,
          at: admin.firestore.FieldValue.serverTimestamp(),
        });
        continue;
      }
      const ref = await saveDraft(a, {
        category: a.category,
        source: "trending",
        flags: { trending: true },
        era: "current",
        sources: t.news.map((n) => n.url).filter(Boolean).slice(0, 6),
      });
      await db.doc(`${LOG}/${key}`).set({
        draftId: ref.id,
        at: admin.firestore.FieldValue.serverTimestamp(),
      });
      made++;
      console.log(`trending draft: "${a.title}" (${ARTICLES}/${ref.id})`);
    } catch (e) {
      failures++;
      console.log(`trending "${t.term}" failed: ${e.message}`);
    }
  }
}

// ---------- 3b) Evergreen drafts ----------
async function makeEvergreenDrafts() {
  if (!EVERGREEN) return;
  const { madeToday, pending } = await draftCounts(["evergreen"]);
  if (pending >= MAX_PENDING) {
    console.log(`evergreen: ${pending} drafts are waiting for review, skipping`);
    return;
  }
  const howMany = Math.min(EVERGREEN_PER_RUN, EVERGREEN_PER_DAY - madeToday);
  if (howMany <= 0) {
    console.log("evergreen: daily limit reached");
    return;
  }
  const avoid = await recentTitles();
  for (let i = 0; i < howMany; i++) {
    try {
      const { text } = await gemini(evergreenPrompt(avoid));
      const a = parseJson(text);
      const ref = await saveDraft(a, {
        category: a.category,
        source: "evergreen",
        flags: { recommended: true },
        era: "any",
      });
      avoid.push(a.title);
      console.log(`evergreen draft: "${a.title}" (${ARTICLES}/${ref.id})`);
    } catch (e) {
      console.log(`evergreen draft failed: ${e.message}`);
    }
  }
}

// ---------- 4) Drafts from your own keywords and notes ----------
async function makeNoteDrafts() {
  const snap = await db
    .collection(IDEAS)
    .where("status", "==", "new")
    .limit(MAX_NOTES_PER_RUN)
    .get();

  for (const doc of snap.docs) {
    const idea = doc.data();
    try {
      if (!idea.topic && !idea.keyword) {
        throw new Error("a note needs a keyword or a topic");
      }
      const note = { ...idea, category: idea.category || CATEGORIES[0] };
      const { text } = await gemini(notesPrompt(note));
      const a = parseJson(text);
      const ref = await saveDraft(a, {
        category: note.category,
        author: idea.author,
        era: idea.topic ? "current" : "any",
        flags: Object.fromEntries(
          ["latestStories", "trending", "recommended"]
            .filter((k) => typeof idea[k] === "boolean")
            .map((k) => [k, idea[k]])
        ),
        image: idea.image,
        imageAlt: idea.imageAlt,
        source: "note",
        ideaId: doc.id,
      });
      await doc.ref.update({ status: "done", draftId: ref.id });
      console.log(`note draft: "${a.title}" (${ARTICLES}/${ref.id})`);
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
await cleanupPublishedDrafts();
await makeMatchDrafts();
await makeTrendingDrafts();
await makeEvergreenDrafts();
await makeNoteDrafts();
console.log("Articles job done");
process.exit(0);
