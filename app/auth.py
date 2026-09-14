"""Authentication — the Python port of AuthProvider.tsx.

Firebase Auth is replaced by a local users table (see db.py) with PBKDF2-HMAC
password hashing from the standard library — no bcrypt, no SQLAlchemy, nothing
that needs a compiler on Windows. The session model matches the original's
requirements exactly:

  * sign-up creates the account and profile, then does NOT log the user in — the
    caller lands them back on the login form to sign in explicitly (req #3);
  * a fresh page load does not resume a session (req #4) — handled in main.py by
    keeping the session in a signed cookie that the login flow controls;

The user-facing error strings are copied verbatim from prettyError() so the
console reads identically.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
from typing import Optional

from . import db

# PBKDF2-HMAC-SHA256. 200k iterations is a sensible 2024+ floor and costs a few
# milliseconds per attempt — invisible on a login, painful to brute-force.
_ITERATIONS = 200_000
_ALGO = "sha256"

# Deliberately loose: one @, a dot in the domain, no whitespace. Firebase's
# invalid-email check was itself only a shape test.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _hash_password(password: str, salt_hex: Optional[str] = None) -> tuple[str, str]:
    salt = bytes.fromhex(salt_hex) if salt_hex else os.urandom(16)
    dk = hashlib.pbkdf2_hmac(_ALGO, password.encode("utf-8"), salt, _ITERATIONS)
    return dk.hex(), salt.hex()


def _verify_password(password: str, hash_hex: str, salt_hex: str) -> bool:
    calc, _ = _hash_password(password, salt_hex)
    return hmac.compare_digest(calc, hash_hex)


def sign_up(email: str, password: str, full_name: str) -> Optional[str]:
    """Create an account + profile. Returns None on success (caller must then
    require an explicit sign-in), or a user-facing error string on failure.

    The validation order mirrors createUserWithEmailAndPassword's error codes:
    invalid-email → weak-password → email-already-in-use.
    """
    email = email.strip()
    if not _EMAIL_RE.match(email):
        return "Please enter a valid email address."
    if len(password) < 6:
        return "Password must be at least 6 characters."
    if db.get_user_by_email(email) is not None:
        return "This email is already registered. Try signing in."

    uid = db.new_uid()
    password_hash, password_salt = _hash_password(password)
    # ensureUserDoc's fullName fallback: `fullName ?? displayName ?? local-part
    # ?? "User"`. `??` only fills a null, so a form value (even "") is kept; the
    # None case here falls back to the email local-part, then "User".
    full = full_name if full_name is not None else (email.split("@")[0] or "User")
    db.insert_user(uid, email, full, password_hash, password_salt)
    return None


def sign_in(email: str, password: str) -> tuple[Optional[str], Optional[str]]:
    """Returns (uid, None) on success or (None, error_string) on failure. A
    missing account and a wrong password give the same message, on purpose —
    the original's invalid-credential / user-not-found both mapped here."""
    email = email.strip()
    row = db.get_user_by_email(email)
    if row is None or not _verify_password(password, row["passwordHash"], row["passwordSalt"]):
        return None, "Invalid email or password."
    return row["uid"], None


def app_user(uid: str) -> Optional[dict]:
    """The AppUser shape the views expect: {uid, email, fullName}."""
    row = db.get_user_by_uid(uid)
    if row is None:
        return None
    return {"uid": row["uid"], "email": row["email"], "fullName": row["fullName"]}
