#!/usr/bin/env python3
"""Fetch UNREAD mail from all 3 mailboxes as JSON on stdout (read-only PEEK —
never marks seen, never sends). Reuses ~/.mail tooling: mail.py (gmail/ceg
app-password IMAP) + oauth_m365.py (mzk XOAUTH2). Stdlib only.

Output: [{"mailbox","uid","from","to","subject","date","body"}] (body truncated).
"""
import sys, os, json, ssl, email, imaplib, argparse

MAIL_DIR = os.environ.get("MAIL_DIR", os.path.expanduser("~/.mail"))
sys.path.insert(0, MAIL_DIR)
from mail import load_env, connect, dec  # noqa: E402

BODY_LIMIT = 2000

def body_text(msg):
    body = ""
    if msg.is_multipart():
        for p in msg.walk():
            if p.get_content_type() == "text/plain":
                body = p.get_payload(decode=True).decode(p.get_content_charset() or "utf-8", "replace")
                break
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            body = payload.decode(msg.get_content_charset() or "utf-8", "replace")
    return body.strip()[:BODY_LIMIT]

def collect(M, mailbox, max_n, since=None):
    M.select("INBOX", readonly=True)
    typ, d = M.search(None, f"(SINCE {since})") if since else M.search(None, "UNSEEN")
    ids = d[0].split() if d[0] else []
    out = []
    for i in ids[-max_n:]:
        typ, data = M.fetch(i, "(BODY.PEEK[])")
        if typ != "OK" or not data or not isinstance(data[0], tuple):
            continue
        msg = email.message_from_bytes(data[0][1])
        clean = lambda s: (s or "").replace("\x00", "")  # NUL bytes break Postgres UTF8
        out.append({
            "mailbox": mailbox,
            "uid": i.decode(),
            "from": clean(dec(msg.get("From", ""))),
            "to": clean(dec(msg.get("To", ""))),
            "subject": clean(dec(msg.get("Subject", ""))),
            "date": clean(dec(msg.get("Date", ""))),
            "body": clean(body_text(msg)),
        })
    return out

def fetch_google(acct, max_n, since=None):
    env = load_env()
    M, _user = connect(acct, env)
    try:
        return collect(M, acct, max_n, since)
    finally:
        M.logout()

def fetch_mzk(max_n, since=None):
    import oauth_m365
    tok = oauth_m365.access_token()
    auth = f"user={oauth_m365.USER}\x01auth=Bearer {tok}\x01\x01"
    M = imaplib.IMAP4_SSL("outlook.office365.com", 993, ssl_context=ssl.create_default_context())
    M.authenticate("XOAUTH2", lambda x: auth.encode())
    try:
        return collect(M, "mzk", max_n, since)
    finally:
        M.logout()

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=25, help="max messages per mailbox")
    ap.add_argument("--days", type=int, default=0, help="if >0, fetch mail SINCE N days ago (read+unread) instead of UNSEEN")
    args = ap.parse_args()
    import datetime as _dt
    since = (_dt.date.today() - _dt.timedelta(days=args.days)).strftime("%d-%b-%Y") if args.days > 0 else None
    result, errors = [], []
    for acct in ("gmail", "ceg"):
        try:
            result.extend(fetch_google(acct, args.max, since))
        except Exception as ex:
            errors.append(f"{acct}: {type(ex).__name__}: {ex}")
    try:
        result.extend(fetch_mzk(args.max, since))
    except Exception as ex:
        errors.append(f"mzk: {type(ex).__name__}: {ex}")
    json.dump({"messages": result, "errors": errors}, sys.stdout, ensure_ascii=False)
