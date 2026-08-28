"use client";

/**
 * Session for the investigating officer.
 *
 * Two modes, decided once at startup by `firebaseReady`:
 *
 *   • CONFIGURED — real Firebase email/password auth. Each officer gets their own
 *     `users/{uid}` document tree; the login gate is enforced in app/page.tsx.
 *   • OFFLINE    — no NEXT_PUBLIC_FIREBASE_* vars, so we hand back a synthetic
 *     local officer and skip the gate entirely. This keeps the zero-config demo
 *     alive (a fresh clone, or a judge with no accounts) instead of showing a
 *     login form that could never succeed. `user.offline` tells the rest of the
 *     app that nothing will persist.
 *
 * Errors are RETURNED as `string | null`, never thrown, so the login form can
 * render them inline. The strings come from prettyAuthError, which maps Firebase
 * codes to the setup step that fixes them.
 *
 * Unlike the FinGuard console this was ported from, persistence is Firebase's
 * default (local) rather than session-scoped, and there is no force-sign-out on
 * reload — a case file you have to re-authenticate for on every refresh would
 * defeat the point of persisting it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db, firebaseReady, prettyAuthError } from "@/lib/firebase";

export type AppUser = {
  uid: string;
  email: string;
  fullName: string;
  /** True when Firebase isn't configured — this is a local, non-persisted session. */
  offline: boolean;
};

type AuthState = {
  user: AppUser | null;
  loading: boolean;
  /** False when Firebase is unconfigured; the UI hides sign-out and warns instead. */
  persistent: boolean;
  signUp: (email: string, password: string, fullName: string) => Promise<string | null>;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
};

/** The stand-in officer used when Firebase isn't configured. */
const LOCAL_OFFICER: AppUser = {
  uid: "local-demo",
  email: "officer@i4c.gov.in",
  fullName: "Investigating Officer",
  offline: true,
};

const AuthCtx = createContext<AuthState>({
  user: null,
  loading: true,
  persistent: false,
  signUp: async () => null,
  signIn: async () => null,
  signOut: async () => {},
});

/**
 * Read the officer's profile document, creating it on first sign-in.
 *
 * `createdAt` is a plain millisecond number rather than `serverTimestamp()`.
 * Everything else in this app stores time the same way (the UI does
 * `new Date(ts).toLocaleString("en-IN")`), and one field with different
 * semantics is exactly the kind of inconsistency that bites later.
 */
async function ensureUserDoc(fbUser: User, fullName?: string): Promise<AppUser> {
  const fallbackName =
    fullName ?? fbUser.displayName ?? fbUser.email?.split("@")[0] ?? "Investigating Officer";

  if (!db) {
    return { uid: fbUser.uid, email: fbUser.email ?? "", fullName: fallbackName, offline: false };
  }

  const ref = doc(db, "users", fbUser.uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    const record = {
      email: fbUser.email ?? "",
      fullName: fallbackName,
      createdAt: Date.now(),
    };
    await setDoc(ref, record);
    return { uid: fbUser.uid, email: record.email, fullName: record.fullName, offline: false };
  }

  const data = snap.data();
  return {
    uid: fbUser.uid,
    email: (data.email as string | undefined) ?? fbUser.email ?? "",
    fullName: (data.fullName as string | undefined) ?? fallbackName,
    offline: false,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // With Firebase unconfigured there is nothing to wait for, so start already
  // resolved and signed in as the local officer — no auth spinner on boot.
  const [user, setUser] = useState<AppUser | null>(firebaseReady ? null : LOCAL_OFFICER);
  const [loading, setLoading] = useState(firebaseReady);

  useEffect(() => {
    const a = auth;
    if (!a) return; // offline mode — state above is already final

    const unsub = onAuthStateChanged(a, async (fbUser) => {
      if (!fbUser) {
        setUser(null);
        setLoading(false);
        return;
      }
      try {
        setUser(await ensureUserDoc(fbUser));
      } catch (err) {
        // A profile read can fail on a project whose Firestore rules aren't
        // published yet. Don't hold the officer out of the console for it —
        // sign them in off the auth record and let the store surface the
        // database error where it's actionable.
        console.error("[Auth] profile load failed:", err);
        setUser({
          uid: fbUser.uid,
          email: fbUser.email ?? "",
          fullName: fbUser.displayName ?? fbUser.email?.split("@")[0] ?? "Investigating Officer",
          offline: false,
        });
      } finally {
        setLoading(false);
      }
    });

    return unsub;
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, fullName: string): Promise<string | null> => {
      const a = auth;
      if (!a) return "Firebase isn't configured, so accounts can't be created.";
      try {
        // createUserWithEmailAndPassword signs the new officer in, so
        // onAuthStateChanged takes it from here — no second sign-in step.
        const cred = await createUserWithEmailAndPassword(a, email, password);
        if (fullName) await updateProfile(cred.user, { displayName: fullName });
        await ensureUserDoc(cred.user, fullName);
        return null;
      } catch (err) {
        return prettyAuthError(err);
      }
    },
    []
  );

  const signIn = useCallback(async (email: string, password: string): Promise<string | null> => {
    const a = auth;
    if (!a) return "Firebase isn't configured, so sign-in is unavailable.";
    try {
      await signInWithEmailAndPassword(a, email, password);
      return null;
    } catch (err) {
      return prettyAuthError(err);
    }
  }, []);

  const signOut = useCallback(async () => {
    const a = auth;
    if (!a) return; // no session to end in offline mode
    await fbSignOut(a);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, persistent: firebaseReady, signUp, signIn, signOut }),
    [user, loading, signUp, signIn, signOut]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthCtx);
}
