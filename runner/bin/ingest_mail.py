#!/usr/bin/env python3
"""Ingest source-adapter: Gmail / IMAP -> inbox (Phase 2a).

Read-only. Reuses the existing ~/.mail tooling (mail.py: gmail/ceg app-password
IMAP) — no new credentials. For each configured account it PEEKs recent messages
(never marks seen, never deletes, never sends), pulls DOCUMENT attachments, and
drops them into INGEST_INBOX/mail/<account>/ where the governed `ingest` job
picks them up (routed -> ingest-doc -> stored trust:unverified). Stdlib only.

Dedup (two layers, both from the manifest INGEST_DIR/mail_processed.jsonl):
  1. message key  = sha256(account | message-id | filename | size)  — re-run guard
  2. content sha  = sha256(payload)  — catches the SAME file re-sent/forwarded in
     other messages (paperless-ngx / wildduck pattern: dedup on content, not metadata)

Attachments are UNTRUSTED sender data: filenames are hard-sanitised (no path
traversal, no NUL), oversize/wrong-type parts are skipped, content is only
written to disk (never executed) and enters the brain as trust:unverified.

Output (stdout, JSON):
  {"saved":[{account,message_id,filename,path,bytes}], "skipped_dupes":n,
   "skipped_type":n, "skipped_size":n, "accounts":[...], "errors":[...]}
"""
import sys, os, json, re, hashlib, argparse, datetime as dt

MAIL_DIR = os.environ.get("MAIL_DIR", os.path.expanduser("~/.mail"))
sys.path.insert(0, MAIL_DIR)
from mail import load_env, connect, dec  # noqa: E402  (reuse existing IMAP layer)

INBOX = os.environ.get("INGEST_INBOX", "/opt/orchestrator/inbox")
INGEST_DIR = os.environ.get("INGEST_DIR", "/opt/orchestrator/ingest")
MANIFEST = os.path.join(INGEST_DIR, "mail_processed.jsonl")

# Document formats worth ingesting (mirrors src/ingest.js TEXT_EXT + EXTRACT_EXT).
# Inline images / calendar parts are intentionally excluded — they are noise, not docs.
DOC_EXT = {
    ".md", ".txt", ".csv", ".tsv", ".json", ".log", ".html", ".htm", ".xml",
    ".yaml", ".yml", ".pdf", ".docx", ".pptx", ".xlsx", ".doc", ".rtf",
    ".epub", ".eml", ".msg",
}

DEF_ACCOUNTS = os.environ.get("INGEST_MAIL_ACCOUNTS", "gmail,ceg")
DEF_DAYS = int(os.environ.get("INGEST_MAIL_DAYS", "7"))
DEF_MAX = int(os.environ.get("INGEST_MAIL_MAX", "100"))          # msgs scanned / account
MAX_BYTES = int(os.environ.get("INGEST_MAIL_MAX_BYTES", str(25 * 1024 * 1024)))
# Optional allow-list of From substrings (case-insensitive). Empty = all senders.
SENDERS = [s.strip().lower() for s in os.environ.get("INGEST_MAIL_SENDERS", "").split(",") if s.strip()]

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(name: str) -> str:
    """Collapse an untrusted attachment filename to a flat, safe basename."""
    name = (name or "attachment").replace("\x00", "")
    name = os.path.basename(name)             # strip any path components
    name = _SAFE.sub("_", name).strip("._") or "attachment"
    return name[:120]


def load_manifest():
    """Return (message_keys, content_shas) already processed."""
    keys, shas = set(), set()
    try:
        with open(MANIFEST) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                    if o.get("key"):
                        keys.add(o["key"])
                    if o.get("sha"):
                        shas.add(o["sha"])
                except Exception:
                    pass
    except FileNotFoundError:
        pass
    return keys, shas


def append_manifest(entries):
    if not entries:
        return
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    with open(MANIFEST, "a") as fh:
        for e in entries:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")


def iter_attachments(msg):
    """Yield (filename, payload_bytes) for real attachments only."""
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        fname = part.get_filename()
        disp = (part.get("Content-Disposition") or "").lower()
        if not fname and "attachment" not in disp:
            continue
        fname = dec(fname) if fname else "attachment"
        try:
            payload = part.get_payload(decode=True)
        except Exception:
            payload = None
        if payload:
            yield fname, payload


def collect_account(acct, env, days, max_n, seen_keys, seen_shas, dry):
    import email
    M, user = connect(acct, env)
    saved, dupes, skip_type, skip_size = [], 0, 0, 0
    try:
        M.select("INBOX", readonly=True)
        since = (dt.date.today() - dt.timedelta(days=days)).strftime("%d-%b-%Y")
        typ, data = M.search(None, f"(SINCE {since})")
        ids = data[0].split() if data and data[0] else []
        for i in ids[-max_n:]:
            typ, d = M.fetch(i, "(BODY.PEEK[])")   # PEEK: never sets \Seen
            if typ != "OK" or not d or not isinstance(d[0], tuple):
                continue
            msg = email.message_from_bytes(d[0][1])
            frm = dec(msg.get("From", ""))
            if SENDERS and not any(s in frm.lower() for s in SENDERS):
                continue
            mid = (msg.get("Message-ID") or f"uid:{i.decode()}").strip()
            for fname, payload in iter_attachments(msg):
                ext = os.path.splitext(fname)[1].lower()
                if ext not in DOC_EXT:
                    skip_type += 1
                    continue
                if len(payload) > MAX_BYTES:
                    skip_size += 1
                    continue
                sname = safe_name(fname)
                key = hashlib.sha256(f"{acct}|{mid}|{sname}|{len(payload)}".encode()).hexdigest()
                sha = hashlib.sha256(payload).hexdigest()
                if key in seen_keys or sha in seen_shas:
                    dupes += 1
                    continue
                seen_keys.add(key)
                seen_shas.add(sha)
                out_dir = os.path.join(INBOX, "mail", acct)
                # short hash prefix keeps distinct same-name attachments from colliding
                out_path = os.path.join(out_dir, f"{key[:10]}__{sname}")
                if not dry:
                    os.makedirs(out_dir, exist_ok=True)
                    with open(out_path, "wb") as fh:
                        fh.write(payload)
                saved.append({
                    "account": acct, "message_id": mid, "from": frm[:120],
                    "filename": sname, "path": out_path, "bytes": len(payload),
                    "key": key, "sha": sha,
                })
    finally:
        try:
            M.logout()
        except Exception:
            pass
    return saved, dupes, skip_type, skip_size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--accounts", default=DEF_ACCOUNTS, help="comma list (mail.py ACCOUNTS)")
    ap.add_argument("--days", type=int, default=DEF_DAYS)
    ap.add_argument("--max", type=int, default=DEF_MAX, help="max messages scanned per account")
    ap.add_argument("--dry-run", action="store_true", help="scan + report, write nothing")
    args = ap.parse_args()

    env = load_env()
    seen_keys, seen_shas = load_manifest()
    all_saved, dupes, skip_type, skip_size, errors = [], 0, 0, 0, []
    accounts = [a.strip() for a in args.accounts.split(",") if a.strip()]
    for acct in accounts:
        try:
            s, du, st, ss = collect_account(acct, env, args.days, args.max, seen_keys, seen_shas, args.dry_run)
            all_saved.extend(s); dupes += du; skip_type += st; skip_size += ss
        except Exception as ex:
            errors.append(f"{acct}: {type(ex).__name__}: {ex}")

    if not args.dry_run:
        append_manifest(all_saved)

    json.dump({
        "saved": all_saved, "saved_count": len(all_saved),
        "skipped_dupes": dupes, "skipped_type": skip_type, "skipped_size": skip_size,
        "accounts": accounts, "days": args.days, "dry_run": args.dry_run, "errors": errors,
    }, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
