const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const projectId =
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  "fieldtrackersandbox1";

const adminApp = initializeApp({ projectId });
const db = getFirestore(adminApp);
const auth = getAuth(adminApp);

/** If instanceof breaks (duplicate firebase-functions), still rethrow real HttpsErrors. */
const HTTPS_ERROR_CODES = new Set([
  "cancelled",
  "unknown",
  "invalid-argument",
  "deadline-exceeded",
  "not-found",
  "already-exists",
  "permission-denied",
  "resource-exhausted",
  "failed-precondition",
  "aborted",
  "out-of-range",
  "unimplemented",
  "internal",
  "unavailable",
  "data-loss",
  "unauthenticated",
]);

function isLikelyHttpsError(err) {
  return (
    err instanceof HttpsError ||
    (typeof err?.code === "string" && HTTPS_ERROR_CODES.has(err.code))
  );
}

const VALID_ROLES = ["viewer", "standard", "admin"];

/** Initial password for newly created Auth users (invite). Users should change it from Profile after first sign-in. */
const DEFAULT_NEW_USER_PASSWORD = "password1";

function formatErr(err) {
  if (!err) return "unknown error";
  const info = err.errorInfo;
  if (info && (info.code || info.message)) {
    return `${info.code || "auth"}: ${info.message || ""}`;
  }
  return `${err.code || err.name || "Error"}: ${err.message || String(err)}`;
}

function normEmail(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

const CALLABLE_OPTS = {
  region: "us-central1",
  cors: true,
  invoker: "public",
};

async function requireTeamAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const callerUid = request.auth.uid;
  const snap = await db.doc(`users/${callerUid}`).get();
  if (!snap.exists || snap.data().role !== "admin") {
    throw new HttpsError("permission-denied", "Only team admins can do this.");
  }
  const teamId = snap.data().teamId;
  if (!teamId) {
    throw new HttpsError("failed-precondition", "Your account has no team assigned.");
  }
  let callerEmail = normEmail(snap.data().email);
  if (!callerEmail) {
    const u = await auth.getUser(callerUid);
    callerEmail = normEmail(u.email);
  }
  return { callerUid, teamId, callerEmail };
}

async function countAdminsInDirectory(teamId) {
  const q = await db
    .collection(`teams/${teamId}/memberDirectory`)
    .where("role", "==", "admin")
    .get();
  return q.size;
}

/**
 * Roster doc exists; optional Auth user must match team in users/{uid}.
 */
async function resolveMember(teamId, emailNorm) {
  const dirRef = db.doc(`teams/${teamId}/memberDirectory/${emailNorm}`);
  const dirSnap = await dirRef.get();
  if (!dirSnap.exists) {
    throw new HttpsError("not-found", "That email is not on your team roster.");
  }
  let uid = null;
  let authUser = null;
  try {
    authUser = await auth.getUserByEmail(emailNorm);
    uid = authUser.uid;
  } catch (e) {
    if (e.code !== "auth/user-not-found") {
      throw new HttpsError("failed-precondition", formatErr(e));
    }
  }
  if (uid) {
    const udoc = await db.doc(`users/${uid}`).get();
    if (!udoc.exists || udoc.data().teamId !== teamId) {
      throw new HttpsError(
        "permission-denied",
        "That login is not assigned to your team."
      );
    }
  }
  return { dirRef, dirSnap, uid, authUser, emailNorm };
}

/**
 * Creates or links a Firebase Auth user, writes users/{uid} and team roster.
 * New users receive DEFAULT_NEW_USER_PASSWORD; they sign in and may change it from Profile.
 */
exports.inviteTeamMember = onCall(CALLABLE_OPTS, async (request) => {
    try {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const { email, firstName, lastName, role } = request.data || {};
    const em = typeof email === "string" ? email.trim().toLowerCase() : "";
    const fn = typeof firstName === "string" ? firstName.trim() : "";
    const ln = typeof lastName === "string" ? lastName.trim() : "";
    const r = typeof role === "string" ? role : "standard";

    if (!fn || !ln || !em) {
      throw new HttpsError(
        "invalid-argument",
        "First name, last name, and email are required."
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      throw new HttpsError("invalid-argument", "Invalid email address.");
    }
    if (!VALID_ROLES.includes(r)) {
      throw new HttpsError("invalid-argument", "Invalid role.");
    }

    const callerUid = request.auth.uid;
    const callerSnap = await db.doc(`users/${callerUid}`).get();
    if (!callerSnap.exists || callerSnap.data().role !== "admin") {
      throw new HttpsError(
        "permission-denied",
        "Only team admins can invite users."
      );
    }
    const teamId = callerSnap.data().teamId;
    if (!teamId) {
      throw new HttpsError(
        "failed-precondition",
        "Your account has no team assigned."
      );
    }

    const displayName = `${fn} ${ln}`.trim();
    const finalRole = r;

    let userRecord;
    let isNewUser = false;

    try {
      userRecord = await auth.createUser({
        email: em,
        password: DEFAULT_NEW_USER_PASSWORD,
        displayName: displayName || undefined,
        emailVerified: false,
      });
      isNewUser = true;
    } catch (err) {
      if (err.code === "auth/email-already-exists") {
        try {
          userRecord = await auth.getUserByEmail(em);
        } catch (e2) {
          console.error("getUserByEmail after duplicate failed:", formatErr(e2));
          throw new HttpsError(
            "failed-precondition",
            `This email is already registered, but the server could not load that account (${formatErr(e2)}).`
          );
        }
        isNewUser = false;
      } else {
        console.error("createUser failed:", formatErr(err));
        if (
          err.code === "auth/operation-not-allowed" ||
          (err.errorInfo && err.errorInfo.code === "OPERATION_NOT_ALLOWED")
        ) {
          throw new HttpsError(
            "failed-precondition",
            "Email/Password sign-in is turned off. In Firebase Console go to Authentication → Sign-in method and enable Email/Password."
          );
        }
        if (err.code === "auth/invalid-email") {
          throw new HttpsError("invalid-argument", "That email address is not valid for Firebase Auth.");
        }
        if (err.code === "auth/weak-password") {
          throw new HttpsError(
            "failed-precondition",
            "Default new-user password was rejected by Firebase (weak-password). In Firebase Console → Authentication → Settings, relax the password policy, or change DEFAULT_NEW_USER_PASSWORD in inviteTeamMember."
          );
        }
        throw new HttpsError(
          "failed-precondition",
          `Could not create Auth user — ${formatErr(err)}. Enable Email/Password, or in Google Cloud Console → IAM grant this project's default compute service account the role "Firebase Authentication Admin" if you see PERMISSION_DENIED.`
        );
      }
    }

    const existingUserDoc = await db.doc(`users/${userRecord.uid}`).get();
    const existingTeam = existingUserDoc.exists
      ? existingUserDoc.data().teamId
      : null;
    if (existingTeam && existingTeam !== teamId) {
      throw new HttpsError(
        "failed-precondition",
        "That email belongs to a user on a different team."
      );
    }

    const batch = db.batch();
    batch.set(
      db.doc(`users/${userRecord.uid}`),
      {
        teamId,
        firstName: fn,
        lastName: ln,
        name: displayName || em,
        role: finalRole,
        email: em,
      },
      { merge: true }
    );
    batch.set(
      db.doc(`teams/${teamId}/memberDirectory/${em}`),
      {
        firstName: fn,
        lastName: ln,
        email: em,
        role: finalRole,
        uid: userRecord.uid,
        updatedAt: FieldValue.serverTimestamp(),
        invitedByUid: callerUid,
      },
      { merge: true }
    );
    try {
      await batch.commit();
    } catch (err) {
      console.error("Firestore batch.commit failed:", err);
      throw new HttpsError(
        "failed-precondition",
        `Could not save user profile (${err.code || err.message || "unknown"}). If this is PERMISSION_DENIED, the Cloud Function service account needs Firestore access in Google Cloud IAM (roles: Cloud Datastore User or Firebase Admin SDK).`
      );
    }

    return { uid: userRecord.uid, email: em, isNewUser };
    } catch (err) {
      if (isLikelyHttpsError(err)) throw err;
      console.error("inviteTeamMember fatal:", formatErr(err), err);
      throw new HttpsError(
        "failed-precondition",
        `Invite failed: ${formatErr(err)}. See Functions logs for the full stack trace.`
      );
    }
  }
);

/**
 * Admin-only: returns JSON so we can see project env, Auth Admin API, and Firestore writes
 * without relying on vague "internal" errors from inviteTeamMember.
 */
exports.inviteDiagnostics = onCall(CALLABLE_OPTS, async (request) => {
    try {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be signed in.");
      }
      const callerUid = request.auth.uid;
      const callerSnap = await db.doc(`users/${callerUid}`).get();
      if (!callerSnap.exists || callerSnap.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Admins only.");
      }
      const teamId = callerSnap.data().teamId;

      const report = {
        initializedProjectId: projectId,
        envGCLOUD_PROJECT: process.env.GCLOUD_PROJECT || null,
        envGCP_PROJECT: process.env.GCP_PROJECT || null,
        callerUid,
        userDoc: {
          exists: callerSnap.exists,
          role: callerSnap.data()?.role ?? null,
          teamId: teamId ?? null,
        },
        authGetCaller: null,
        firestoreTeamPathWrite: null,
        hint:
          "authGetCaller.ok false → grant default compute service account role Firebase Authentication Admin. firestoreTeamPathWrite ok false → grant Cloud Datastore User (or Editor) on that same account.",
      };

      try {
        const u = await auth.getUser(callerUid);
        report.authGetCaller = {
          ok: true,
          email: u.email || null,
          providerIds: (u.providerData || []).map((p) => p.providerId),
        };
      } catch (e) {
        report.authGetCaller = { ok: false, error: formatErr(e) };
      }

      if (teamId) {
        try {
          const ref = db.doc(`teams/${teamId}/_diagnostics/connectionProbe`);
          await ref.set(
            { at: FieldValue.serverTimestamp(), byUid: callerUid },
            { merge: true }
          );
          await ref.delete();
          report.firestoreTeamPathWrite = { ok: true };
        } catch (e) {
          report.firestoreTeamPathWrite = { ok: false, error: formatErr(e) };
        }
      } else {
        report.firestoreTeamPathWrite = {
          skipped: true,
          reason: "no teamId on user doc",
        };
      }

      try {
        const probeEmail = `fieldtracker-probe-${Date.now()}@example.com`;
        const rec = await auth.createUser({
          email: probeEmail,
          password: DEFAULT_NEW_USER_PASSWORD,
        });
        await auth.deleteUser(rec.uid);
        report.probeCreateDeleteAuthUser = {
          ok: true,
          note: "Same API path as Invite (new users). If this fails, invites will fail for new emails.",
        };
      } catch (e) {
        report.probeCreateDeleteAuthUser = { ok: false, error: formatErr(e) };
      }

      return report;
    } catch (err) {
      if (isLikelyHttpsError(err)) throw err;
      console.error("inviteDiagnostics fatal:", formatErr(err), err);
      throw new HttpsError(
        "failed-precondition",
        `Diagnostics failed: ${formatErr(err)}`
      );
    }
  }
);

exports.adminGetRoster = onCall(CALLABLE_OPTS, async (request) => {
  try {
    const { teamId } = await requireTeamAdmin(request);
    const snap = await db.collection(`teams/${teamId}/memberDirectory`).get();
    const members = [];
    for (const d of snap.docs) {
      const x = d.data();
      const email = normEmail(x.email || d.id);
      let uid = x.uid || null;
      let disabled = false;
      let hasAuth = false;
      try {
        const u = await auth.getUserByEmail(email);
        uid = u.uid;
        hasAuth = true;
        disabled = u.disabled === true;
      } catch (e) {
        if (e.code !== "auth/user-not-found") {
          throw new HttpsError("failed-precondition", formatErr(e));
        }
      }
      members.push({
        email,
        firstName: x.firstName || "",
        lastName: x.lastName || "",
        role: VALID_ROLES.includes(x.role) ? x.role : "standard",
        uid,
        hasAuth,
        disabled,
      });
    }
    members.sort((a, b) =>
      (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName)
    );
    return { members };
  } catch (err) {
    if (isLikelyHttpsError(err)) throw err;
    throw new HttpsError("failed-precondition", formatErr(err));
  }
});

exports.adminUpdateMemberRole = onCall(CALLABLE_OPTS, async (request) => {
  try {
    const { callerUid, teamId, callerEmail } = await requireTeamAdmin(request);
    const email = normEmail(request.data?.email);
    const role = request.data?.role;
    if (!email || !VALID_ROLES.includes(role)) {
      throw new HttpsError("invalid-argument", "Valid email and role are required.");
    }
    const { dirRef, dirSnap, uid } = await resolveMember(teamId, email);
    const prev = dirSnap.data()?.role;
    if (prev === "admin" && role !== "admin") {
      const n = await countAdminsInDirectory(teamId);
      if (n <= 1) {
        throw new HttpsError(
          "failed-precondition",
          "Cannot change the last admin to a non-admin role."
        );
      }
    }
    if (email === callerEmail && role !== "admin") {
      const n = await countAdminsInDirectory(teamId);
      if (n <= 1) {
        throw new HttpsError(
          "failed-precondition",
          "You are the only admin. Promote someone else before changing your role."
        );
      }
    }
    const fn = dirSnap.data()?.firstName || "";
    const ln = dirSnap.data()?.lastName || "";
    const name = `${fn} ${ln}`.trim() || email;
    const batch = db.batch();
    batch.set(
      dirRef,
      {
        role,
        uid: uid || dirSnap.data()?.uid || null,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: callerUid,
      },
      { merge: true }
    );
    if (uid) {
      batch.set(
        db.doc(`users/${uid}`),
        { teamId, role, email, name },
        { merge: true }
      );
    }
    await batch.commit();
    return { ok: true };
  } catch (err) {
    if (isLikelyHttpsError(err)) throw err;
    throw new HttpsError("failed-precondition", formatErr(err));
  }
});

exports.adminSetMemberDisabled = onCall(CALLABLE_OPTS, async (request) => {
  try {
    const { teamId, callerEmail } = await requireTeamAdmin(request);
    const email = normEmail(request.data?.email);
    const disabled = Boolean(request.data?.disabled);
    if (!email) {
      throw new HttpsError("invalid-argument", "Email is required.");
    }
    if (email === callerEmail && disabled) {
      throw new HttpsError(
        "failed-precondition",
        "You cannot deactivate your own account."
      );
    }
    const { uid, authUser, dirSnap } = await resolveMember(teamId, email);
    if (!uid || !authUser) {
      throw new HttpsError(
        "failed-precondition",
        "No Firebase login exists for that email."
      );
    }
    if (disabled && dirSnap.data()?.role === "admin") {
      const n = await countAdminsInDirectory(teamId);
      if (n <= 1) {
        throw new HttpsError(
          "failed-precondition",
          "Cannot deactivate the last admin."
        );
      }
    }
    await auth.updateUser(uid, { disabled });
    return { ok: true, disabled };
  } catch (err) {
    if (isLikelyHttpsError(err)) throw err;
    throw new HttpsError("failed-precondition", formatErr(err));
  }
});

exports.adminDeleteMember = onCall(CALLABLE_OPTS, async (request) => {
  try {
    const { teamId, callerEmail } = await requireTeamAdmin(request);
    const email = normEmail(request.data?.email);
    if (!email) {
      throw new HttpsError("invalid-argument", "Email is required.");
    }
    if (email === callerEmail) {
      throw new HttpsError(
        "failed-precondition",
        "You cannot remove your own account."
      );
    }
    const { dirRef, uid, dirSnap } = await resolveMember(teamId, email);
    if (dirSnap.data()?.role === "admin") {
      const n = await countAdminsInDirectory(teamId);
      if (n <= 1) {
        throw new HttpsError(
          "failed-precondition",
          "Cannot delete the last admin."
        );
      }
    }
    if (uid) {
      await auth.deleteUser(uid);
      try {
        await db.doc(`users/${uid}`).delete();
      } catch (_) {}
    }
    await dirRef.delete();
    return { ok: true };
  } catch (err) {
    if (isLikelyHttpsError(err)) throw err;
    throw new HttpsError("failed-precondition", formatErr(err));
  }
});

/**
 * Signed-in user: update first/last name, about me, optional profile photo URL (Firebase Storage HTTPS only).
 */
exports.updateOwnProfile = onCall(CALLABLE_OPTS, async (request) => {
  try {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }
    const uid = request.auth.uid;
    const { firstName, lastName, aboutMe, photoURL, clearPhoto } = request.data || {};
    const fn = typeof firstName === "string" ? firstName.trim().slice(0, 80) : "";
    const ln = typeof lastName === "string" ? lastName.trim().slice(0, 80) : "";
    if (!fn || !ln) {
      throw new HttpsError(
        "invalid-argument",
        "First name and last name are required."
      );
    }
    let bio = typeof aboutMe === "string" ? aboutMe.trim() : "";
    if (bio.length > 255) bio = bio.slice(0, 255);

    const userRef = db.doc(`users/${uid}`);
    const usnap = await userRef.get();
    if (!usnap.exists) {
      throw new HttpsError("failed-precondition", "User profile not found.");
    }
    const teamId = usnap.data().teamId;
    const emailNorm = normEmail(usnap.data().email);
    const tokenEmail = normEmail(request.auth.token.email);
    const emailKey = emailNorm || tokenEmail;
    if (!teamId || !emailKey) {
      throw new HttpsError(
        "failed-precondition",
        "Missing team or email on profile."
      );
    }

    const name = `${fn} ${ln}`.trim();
    const batch = db.batch();
    const userPatch = {
      firstName: fn,
      lastName: ln,
      name,
      aboutMe: bio,
      profileUpdatedAt: FieldValue.serverTimestamp(),
    };

    if (clearPhoto === true) {
      userPatch.photoURL = FieldValue.delete();
    } else if (photoURL != null && String(photoURL).trim() !== "") {
      const p = String(photoURL).trim();
      if (p.length > 2048) {
        throw new HttpsError("invalid-argument", "Invalid photo URL.");
      }
      if (
        !/^https:\/\//.test(p) ||
        (!p.includes("firebasestorage.googleapis.com") &&
          !p.includes("googleapis.com"))
      ) {
        throw new HttpsError(
          "invalid-argument",
          "Photo must be an HTTPS URL from Firebase Storage."
        );
      }
      userPatch.photoURL = p;
    }

    batch.set(userRef, userPatch, { merge: true });
    batch.set(
      db.doc(`teams/${teamId}/memberDirectory/${emailKey}`),
      {
        firstName: fn,
        lastName: ln,
        email: emailKey,
        uid,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await batch.commit();

    try {
      const authPatch = { displayName: name };
      if (clearPhoto === true) {
        authPatch.photoURL = null;
      } else if (userPatch.photoURL && typeof userPatch.photoURL === "string") {
        authPatch.photoURL = userPatch.photoURL;
      }
      await auth.updateUser(uid, authPatch);
    } catch (e) {
      console.warn("auth.updateUser profile:", formatErr(e));
    }

    return { ok: true };
  } catch (err) {
    if (isLikelyHttpsError(err)) throw err;
    throw new HttpsError("failed-precondition", formatErr(err));
  }
});

/**
 * After verifyBeforeUpdateEmail completes, Auth email is updated; this migrates Firestore users doc + roster id.
 */
exports.syncEmailFromAuth = onCall(CALLABLE_OPTS, async (request) => {
  try {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }
    const uid = request.auth.uid;
    const authUser = await auth.getUser(uid);
    const newEmail = normEmail(authUser.email);
    if (!newEmail) {
      throw new HttpsError(
        "failed-precondition",
        "Your account has no email address."
      );
    }
    const userRef = db.doc(`users/${uid}`);
    const snap = await userRef.get();
    if (!snap.exists) {
      throw new HttpsError("failed-precondition", "User document missing.");
    }
    const teamId = snap.data().teamId;
    if (!teamId) {
      throw new HttpsError("failed-precondition", "No team assigned.");
    }
    const oldEmail = normEmail(snap.data().email || "");
    if (newEmail === oldEmail) {
      return { ok: true, migrated: false, email: newEmail };
    }

    const dirCol = db.collection(`teams/${teamId}/memberDirectory`);
    const newRef = dirCol.doc(newEmail);
    const newSnap = await newRef.get();
    if (newSnap.exists) {
      const existingUid = newSnap.data()?.uid;
      if (existingUid != null && String(existingUid) !== String(uid)) {
        throw new HttpsError(
          "already-exists",
          "That email is already used by another team member."
        );
      }
    }

    const oldRef = oldEmail ? dirCol.doc(oldEmail) : null;
    const oldSnap = oldRef ? await oldRef.get() : null;
    const rosterData = oldSnap && oldSnap.exists
      ? { ...oldSnap.data() }
      : {
          firstName: snap.data().firstName || "",
          lastName: snap.data().lastName || "",
          role: VALID_ROLES.includes(snap.data().role)
            ? snap.data().role
            : "standard",
        };
    rosterData.email = newEmail;
    rosterData.uid = uid;
    rosterData.updatedAt = FieldValue.serverTimestamp();

    const batch = db.batch();
    batch.set(newRef, rosterData, { merge: true });
    if (
      oldRef &&
      oldSnap &&
      oldSnap.exists &&
      oldRef.path !== newRef.path
    ) {
      batch.delete(oldRef);
    }
    batch.set(userRef, { email: newEmail }, { merge: true });
    await batch.commit();
    return { ok: true, migrated: true, email: newEmail };
  } catch (err) {
    if (isLikelyHttpsError(err)) throw err;
    throw new HttpsError("failed-precondition", formatErr(err));
  }
});
