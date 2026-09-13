import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Read from the environment rather than hardcoding the project. A Firebase web
// config is shipped to the browser and is not a secret in the cryptographic
// sense, but committing a live one means anyone can register accounts against
// this project and burn its quota — so it stays in .env.local (gitignored) and
// .env.example documents the variable names. See README for setup.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  // Failing loudly here beats an opaque "auth/invalid-api-key" three screens in.
  console.error(
    "Firebase config missing. Copy .env.example to .env.local and fill in the NEXT_PUBLIC_FIREBASE_* values."
  );
}

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
