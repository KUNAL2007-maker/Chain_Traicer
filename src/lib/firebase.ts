// Firebase client bootstrap — the ONLY place the SDK is initialised.
//
// Client SDK only: there is no firebase-admin anywhere in this project. Every
// read and write is scoped to `users/{uid}/…` and enforced by a single Firestore
// security rule (see firestore.rules), which is why no service-account private
// key is needed — one less secret to leak into a deployment environment.
//
// Firebase is OPTIONAL at runtime. With the NEXT_PUBLIC_FIREBASE_* vars unset —
// a fresh clone, or a judge running the demo with no accounts — `firebaseReady`
// is false and the console falls back to the in-memory store and a local demo
// officer. That keeps the zero-config demo working instead of stranding everyone
// on a login form that can never succeed. Anything that touches `auth`/`db`
// must therefore null-check them.

import { initializeApp, getApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, initializeFirestore, type Firestore } from "firebase/firestore";

// A Firebase web config is shipped to the browser and is not a secret in the
// cryptographic sense, but a committed live one lets anyone register accounts
// against the project and burn its quota — so it stays in .env.local
// (gitignored) and .env.example documents only the variable names.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

/**
 * True when there is enough config to actually reach a Firebase project.
 *
 * NOTE for deployment: these are `NEXT_PUBLIC_*`, so Next inlines them at BUILD
 * time. On Render they must exist in the environment *before the first build*,
 * and changing one needs a rebuild — a restart will keep serving the old values.
 */
export const firebaseReady: boolean = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId
);

let app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _db: Firestore | null = null;

if (firebaseReady) {
  app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  _auth = getAuth(app);
  // initializeFirestore (not getFirestore) so `ignoreUndefinedProperties` is on:
  // several domain fields are legitimately undefined (CaseMeta.amount_lost_inr,
  // LegalNotice.amountInr, WalletTransfer.block …) and Firestore rejects an
  // undefined value outright. sanitize() in firestore-safe.ts strips them at the
  // call site; this is the net underneath it.
  //
  // It throws if Firestore was already started for this app — which happens on
  // hot reload and on a second import — so fall back to the existing instance.
  try {
    _db = initializeFirestore(app, { ignoreUndefinedProperties: true });
  } catch {
    _db = getFirestore(app);
  }
} else if (typeof window !== "undefined") {
  // Log once in the browser, not during the build, and phrase it as a state
  // rather than an error — running without Firebase is a supported mode.
  console.info(
    "[CryptoTrace] Firebase not configured — running in offline demo mode " +
      "(cases live in memory and clear on refresh). To enable persistence, copy " +
      ".env.example to .env.local and fill in the NEXT_PUBLIC_FIREBASE_* values."
  );
}

export const auth = _auth;
export const db = _db;

// ── Error prettifiers ───────────────────────────────────────────────────────
// Firebase codes are precise but unreadable. Mapping the common ones to *setup
// instructions* ("enable Email/Password in the console") turns a dead end into
// the next action, which matters most on a first deploy.

export function prettyAuthError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? "";
  const message = (err as { message?: string } | null)?.message;

  if (code.includes("email-already-in-use"))
    return "This email is already registered. Try signing in instead.";
  if (code.includes("invalid-email")) return "Please enter a valid email address.";
  if (code.includes("weak-password")) return "Password must be at least 6 characters.";
  if (
    code.includes("invalid-credential") ||
    code.includes("wrong-password") ||
    code.includes("user-not-found")
  )
    return "Invalid email or password.";
  if (code.includes("too-many-requests"))
    return "Too many failed attempts. Wait a minute and try again.";
  if (code.includes("network-request-failed"))
    return "Network error. Check your connection and try again.";
  if (code.includes("operation-not-allowed") || code.includes("configuration-not-found"))
    return "Email/password sign-in is not enabled. In the Firebase console open Authentication → Sign-in method and enable Email/Password.";
  if (code.includes("invalid-api-key") || code.includes("api-key-not-valid"))
    return "The Firebase API key is wrong. Re-copy NEXT_PUBLIC_FIREBASE_API_KEY from Project settings → Your apps.";
  if (code.includes("unauthorized-domain"))
    return "This domain is not authorised for sign-in. Add it under Authentication → Settings → Authorized domains.";
  return message ?? "Something went wrong. Please try again.";
}

export function prettyFirestoreError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? "";
  const message = (err as { message?: string } | null)?.message;

  if (code.includes("permission-denied"))
    return "Database access denied. Publish the rules from firestore.rules in the Firebase console (Firestore → Rules).";
  if (code.includes("unavailable"))
    return "Can't reach the database right now. Your work is kept locally and will sync when the connection returns.";
  if (code.includes("failed-precondition"))
    return "Firestore isn't set up for this project yet. In the Firebase console open Firestore Database → Create database (Native mode).";
  if (code.includes("not-found"))
    return "Firestore database not found. Create it in the Firebase console (Firestore Database → Create database).";
  if (code.includes("resource-exhausted"))
    return "Firestore quota exhausted for today. Check usage in the Firebase console.";
  if (code.includes("unauthenticated")) return "Your session expired. Please sign in again.";
  return message ?? "Database error. Please try again.";
}
