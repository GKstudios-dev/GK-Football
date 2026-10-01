import admin from "firebase-admin";

// Shared push helpers for sync.js and live.js.
// The calling script must run admin.initializeApp() first; nothing
// here touches Firebase at import time.
//
// "Already sent" markers live in Firestore at notified/{key} so a
// restarted job never repeats a notification. Only the Admin SDK
// touches that collection, so leave it closed in your security rules.

const sent = new Set(); // in-memory copy, avoids repeat reads

const docFor = (key) =>
  admin.firestore().doc(`notified/${key.replace(/\//g, "_")}`);

export async function wasSent(key) {
  if (sent.has(key)) return true;
  const snap = await docFor(key).get();
  if (snap.exists) sent.add(key);
  return snap.exists;
}

export async function markSent(key) {
  sent.add(key);
  await docFor(key).set({
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Sends to everyone who follows ANY of the given teams. A single
// condition message means a phone following both teams gets one push.
export async function notifyTeams(teamIds, title, body, data = {}) {
  const condition = teamIds.map((id) => `'team_${id}' in topics`).join(" || ");
  await admin.messaging().send({
    condition,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
    android: { priority: "high" },
  });
  console.log(`push: ${title} | ${body.replace(/\n/g, " / ")}`);
}
