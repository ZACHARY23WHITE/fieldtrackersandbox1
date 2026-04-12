#!/usr/bin/env node
/**
 * Copy Firestore data from a source Firebase project (e.g. production) to a
 * destination project (e.g. this sandbox).
 *
 * What gets copied
 * ----------------
 * - Top-level `users` and `teams` collections, including all subcollections
 *   (moistureReadings, cleggReadings, memberDirectory, drafts, etc.).
 *
 * What does NOT get copied
 * ------------------------
 * - Firebase Authentication accounts (emails/passwords/UIds are a separate system).
 * - Cloud Storage files (e.g. profile photos under profilePhotos/).
 *
 * If you copy `users/{uid}` documents but do not import Auth users with the *same*
 * UIDs into the sandbox, those Firestore user docs will not match any login in
 * the sandbox app. Typical approaches:
 *
 * 1) Copy only `teams` (use --teams-only), then invite users again in sandbox;
 *    your historical readings stay under the same teamId paths.
 * 2) Export Auth from prod and import into sandbox so UIDs line up with
 *    `users/{uid}` (see https://firebase.google.com/docs/cli/auth-export ).
 *
 * Setup
 * -----
 * In Google Cloud Console for EACH project, create a service account (or use an
 * existing one) with:
 *   - Source: roles/datastore.user (or Cloud Datastore User) — read Firestore
 *   - Dest:   same role — write Firestore
 * Download JSON keys. Do not commit them.
 *
 * Usage (from the `functions/` directory, after npm install):
 *
 *   SOURCE_SERVICE_ACCOUNT_PATH=../keys/prod-sa.json \
 *   DEST_SERVICE_ACCOUNT_PATH=../keys/sandbox-sa.json \
 *   SOURCE_PROJECT_ID=your-production-project-id \
 *   DEST_PROJECT_ID=fieldtrackersandbox1 \
 *   node scripts/copyFirestoreBetweenProjects.js --dry-run
 *
 * Remove --dry-run to perform the copy.
 *
 *   node scripts/copyFirestoreBetweenProjects.js --teams-only
 * skips the `users` collection (only `teams` and subcollections).
 */

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function loadServiceAccount(keyPath) {
  const resolved = path.resolve(process.cwd(), keyPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Service account file not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(v).trim();
}

const dryRun = process.argv.includes("--dry-run");
const teamsOnly = process.argv.includes("--teams-only");

const SOURCE_KEY = requireEnv("SOURCE_SERVICE_ACCOUNT_PATH");
const DEST_KEY = requireEnv("DEST_SERVICE_ACCOUNT_PATH");
const SOURCE_PROJECT_ID = requireEnv("SOURCE_PROJECT_ID");
const DEST_PROJECT_ID = requireEnv("DEST_PROJECT_ID");

const sourceApp = admin.initializeApp(
  {
    credential: admin.credential.cert(loadServiceAccount(SOURCE_KEY)),
    projectId: SOURCE_PROJECT_ID,
  },
  "firestore-source"
);

const destApp = admin.initializeApp(
  {
    credential: admin.credential.cert(loadServiceAccount(DEST_KEY)),
    projectId: DEST_PROJECT_ID,
  },
  "firestore-dest"
);

const srcDb = admin.firestore(sourceApp);
const dstDb = admin.firestore(destApp);

/**
 * Deep-clone plain data so Firestore Timestamps / GeoPoints stay as Admin types.
 * (get() already returns compatible types for set().)
 */
async function copyDocTree(srcDocRef, dstDocRef) {
  const snap = await srcDocRef.get();
  if (snap.exists) {
    const data = snap.data();
    if (dryRun) {
      console.log(`[dry-run] would set ${dstDocRef.path} (${Object.keys(data).length} fields)`);
    } else {
      await dstDocRef.set(data);
    }
  }

  const subcols = await srcDocRef.listCollections();
  for (const subCol of subcols) {
    const subSnap = await subCol.get();
    for (const subDoc of subSnap.docs) {
      await copyDocTree(
        subDoc.ref,
        dstDocRef.collection(subCol.id).doc(subDoc.id)
      );
    }
  }
}

async function copyTopLevelCollection(collectionId) {
  const snap = await srcDb.collection(collectionId).get();
  console.log(
    `Collection "${collectionId}": ${snap.size} top-level document(s) to traverse`
  );
  for (const doc of snap.docs) {
    await copyDocTree(doc.ref, dstDb.collection(collectionId).doc(doc.id));
  }
}

async function main() {
  console.log(
    `Firestore copy: ${SOURCE_PROJECT_ID} -> ${DEST_PROJECT_ID}${
      dryRun ? " (DRY RUN)" : ""
    }${teamsOnly ? " [teams only]" : ""}`
  );

  if (!teamsOnly) {
    await copyTopLevelCollection("users");
  }
  await copyTopLevelCollection("teams");

  console.log(dryRun ? "Dry run finished." : "Copy finished.");
  await Promise.all([sourceApp.delete(), destApp.delete()]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
