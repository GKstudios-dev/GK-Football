import admin from "firebase-admin";

// Article automation. Each run does three things:
//   1) PUBLISH: drafts in `article_drafts` that you set approved=true are
//      copied into your real `posts` collection.
//   2) TRENDING: Gemini uses Google Search to find a football topic that is
//      trending right now, picks a keyword, and saves an article DRAFT.
//   3) NOTES (optional): any note you add to `article_ideas` with
//      status "new" becomes a draft too.
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
const AUTHOR = "Sir Gabby";
const DEFAULT_IMAGE =
  "https://gkstudios-dev.github.io/GK-Football/images/clubfootbal.webp";
// The category values your app uses. Add the others here.
const CATEGORIES = ["club"];

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const AUTO_TRENDING = process.env.AUTO_TRENDING !== "off"; // set to "off" to stop auto drafts
const TRENDING_PER_RUN = 1;     // new trending drafts per run
const TRENDING_PER_DAY = 3;     // daily cap
const MAX_PENDING = 6;          // stop making drafts while this many wait for review
const MAX_NOTES_PER_RUN = 3;    // drafts from your own notes per run

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Gemini ----------
// With search on, the model can look things up on Google. The reply
// also lists the pages it used, which we keep on the draft for you.
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

const FORMAT_RULES = `- 600 to 800 words, clear, engaging, in your own original wording. Never copy sentences from any source and never quote people.
- "body" is HTML using only <p>, <h2>, <strong>, <ul> and <li>. No <h1>, no images, no links.
- Use the focus keyword naturally in the first paragraph and a few more times.
- "snippet": the first one or two sentences as plain text, at most 200 characters.
- "metaDescription": plain text, at most 155 characters, containing the focus keyword.
- "tags": 3 to 6 short lowercase tags.
- "imageAlt": a short description of a suitable image.`;

function notesPrompt(idea) {
  return `You are a football journalist writing for a football news app.
Write one article from the editor's notes below.

EDITOR'S NOTES:
${idea.topic}

CATEGORY: ${idea.category}

RULES:
- Use ONLY the facts, names, scores and dates found in the notes. Never invent statistics, quotes, transfers, injuries or results. If the notes are only a general topic, write general evergreen analysis with no specific claims.
${FORMAT_RULES}

Return ONLY a JSON object with exactly these keys:
{"title": "", "subtitle": "", "body": "", "snippet": "", "metaDescription": "", "focusKeyword": "", "tags": [], "imageAlt": ""}`;
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
- Use only facts you found in the search results. Never invent statistics, scores, quotes, transfers or injuries. If you are not sure of a fact, leave it out.
${FORMAT_RULES}

Return ONLY a JSON object with exactly these keys:
{"title": "", "subtitle": "", "body": "", "snippet": "", "metaDescription": "", "focusKeyword": "", "tags": [], "imageAlt": "", "category": ""}`;
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
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ---------- 1) Publish approved drafts ----------
async function publishApproved() {
  const snap = await db.collection(DRAFTS).where("approved", "==", true).get();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.published === true) continue;
    try {
      const {
        approved, published, source, sources, ideaId, createdAt, articleId,
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

// ---------- 2) Trending drafts ----------
async function makeTrendingDrafts() {
  if (!AUTO_TRENDING) return;

  const since = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 3600 * 1000);
  const last24h = await db.collection(DRAFTS).where("createdAt", ">=", since).get();
  const madeToday = last24h.docs.filter((d) => d.data().source === "trending").length;

  const waiting = await db.collection(DRAFTS).where("approved", "==", false).get();
  const pending = waiting.docs.filter((d) => d.data().published !== true).length;

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

// ---------- 3) Drafts from your own notes (optional) ----------
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
await makeTrendingDrafts();
await makeNoteDrafts();
console.log("Articles job done");
process.exit(0);
