"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export type AppUser = {
  uid: string;
  email: string;
  fullName: string;
};

type AuthState = {
  user: AppUser | null;
  loading: boolean;
  signUp: (email: string, password: string, fullName: string) => Promise<string | null>;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
};

const AuthCtx = createContext<AuthState>({
  user: null,
  loading: true,
  signUp: async () => null,
  signIn: async () => null,
  signOut: async () => {},
});

const RELOAD_FLAG = "finguard-session-init";

async function ensureUserDoc(fbUser: User, fullName?: string): Promise<AppUser> {
  const ref = doc(db, "users", fbUser.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const record = {
      email: fbUser.email ?? "",
      fullName: fullName ?? fbUser.displayName ?? fbUser.email?.split("@")[0] ?? "User",
      createdAt: serverTimestamp(),
    };
    await setDoc(ref, record);
    return { uid: fbUser.uid, email: record.email, fullName: record.fullName };
  }
  const data = snap.data();
  return {
    uid: fbUser.uid,
    email: (data.email as string) ?? fbUser.email ?? "",
    fullName: (data.fullName as string) ?? fbUser.displayName ?? "User",
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Requirement #4: don't stay logged in on reload.
      // Session persistence keeps the user only while the tab is open;
      // a page reload clears it (unlike browserLocalPersistence).
      try {
        await setPersistence(auth, browserSessionPersistence);
      } catch (err) {
        console.warn("[Auth] setPersistence failed:", err);
      }

      // If this is a fresh page load (not an in-tab navigation), sign out
      // any leftover session so the login form is required.
      const isFreshLoad = !sessionStorage.getItem(RELOAD_FLAG);
      if (isFreshLoad) {
        sessionStorage.setItem(RELOAD_FLAG, "1");
        if (auth.currentUser) {
          try {
            await fbSignOut(auth);
          } catch {}
        }
      }

      const unsub = onAuthStateChanged(auth, async (fbUser) => {
        if (cancelled) return;
        if (!fbUser) {
          setUser(null);
          setLoading(false);
          return;
        }
        try {
          const u = await ensureUserDoc(fbUser);
          setUser(u);
        } catch (err) {
          console.error("[Auth] profile load failed:", err);
          setUser({
            uid: fbUser.uid,
            email: fbUser.email ?? "",
            fullName: fbUser.displayName ?? fbUser.email?.split("@")[0] ?? "User",
          });
        } finally {
          setLoading(false);
        }
      });

      return unsub;
    }

    const p = init();
    return () => {
      cancelled = true;
      p.then((unsub) => unsub && unsub());
    };
  }, []);

  // Requirement #3: register once, then return to login page.
  // We create the account, write the profile, then sign out so the
  // user must sign in with the credentials they just created.
  async function signUp(email: string, password: string, fullName: string) {
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: fullName });
      await ensureUserDoc(cred.user, fullName);
      await fbSignOut(auth);
      setUser(null);
      return null;
    } catch (err: unknown) {
      return prettyError(err);
    }
  }

  async function signIn(email: string, password: string) {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      return null;
    } catch (err: unknown) {
      return prettyError(err);
    }
  }

  async function signOut() {
    await fbSignOut(auth);
    setUser(null);
  }

  return (
    <AuthCtx.Provider value={{ user, loading, signUp, signIn, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  return useContext(AuthCtx);
}

function prettyError(err: unknown): string {
  const raw = (err as { code?: string; message?: string } | null) ?? {};
  const code = raw.code ?? "";
  if (code.includes("email-already-in-use")) return "This email is already registered. Try signing in.";
  if (code.includes("invalid-email")) return "Please enter a valid email address.";
  if (code.includes("weak-password")) return "Password must be at least 6 characters.";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found"))
    return "Invalid email or password.";
  if (code.includes("network-request-failed")) return "Network error. Check your connection.";
  if (code.includes("configuration-not-found"))
    return "Firebase Auth is not enabled. Go to Firebase Console → Authentication → Sign-in method → enable Email/Password.";
  return raw.message ?? "Something went wrong. Please try again.";
}
