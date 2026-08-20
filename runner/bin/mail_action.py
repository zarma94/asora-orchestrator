#!/usr/bin/env python3
"""Mail ACTIONS (forward + archive) — the WRITE side, run ONLY after the owner approves.

Two modes:
  list --mailbox mzk --days 10 --max 40
      -> {"messages":[{mailbox,uid,message_id,from,to,subject,date}], "error"?}
         (UID-stable handles for the planner; PEEK only, nothing marked/sent/moved)

  exec [--dry-run]     (plan JSON on stdin)
      plan = {"mailbox":"mzk","actions":[
                {"op":"forward","uid":"123","message_id":"<..>","to":"x@y.z"},
                {"op":"archive","uid":"124","message_id":"<..>"}]}
      -> {"results":[{op,uid,ok,detail}], "error"?}

SAFETY:
  * every action re-fetches the message by UID and VERIFIES its Message-ID equals the
    plan's before doing anything — on mismatch/absence it SKIPS (never the wrong mail).
  * archive = IMAP MOVE to the Archive/All-Mail folder (reversible), never delete/trash.
  * forward attaches the ORIGINAL as message/rfc822 (nothing altered or lost).
  * --dry-run resolves + verifies + builds the message but sends/moves NOTHING.
Stdlib only. Creds via ~/.mail (mail.py app-passwords + oauth_m365.py XOAUTH2).
"""
import sys, os, json, ssl, email, imaplib, smtplib, argparse, base64, datetime
import email.policy
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr

MAIL_DIR = os.environ.get("MAIL_DIR", os.path.expanduser("~/.mail"))
sys.path.insert(0, MAIL_DIR)
from mail import load_env, dec, ACCOUNTS  # noqa: E402

GOOGLE = ("gmail", "ceg")
ARCHIVE_FOLDER = {"mzk": "Archive", "gmail": "[Gmail]/All Mail", "ceg": "[Gmail]/All Mail"}

# --- de-dup ledger: remembers every completed action so we never send/move the same thing twice.
# Key by the STABLE Message-ID (+ recipient for forwards), not UID (UID changes when archived).
LEDGER = os.path.join(MAIL_DIR, ".mail_action_ledger.json")


def _now_iso():
    import datetime as _dt
    return _dt.datetime.now().isoformat(timespec="seconds")


def load_ledger():
    try:
        with open(LEDGER) as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_ledger(d):
    tmp = LEDGER + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, LEDGER)


def key_for(mailbox, a):
    op = a.get("op")
    mid = (a.get("message_id", "") or "").strip().lower()
    if op == "forward":
        to = parseaddr(a.get("to", ""))[1].lower()
        return f"fwd|{mailbox}|{mid}|{to}"
    if op == "archive":
        return f"arc|{mailbox}|{mid}"
    return f"{op}|{mailbox}|{mid}"


def imap_connect(mailbox, env):
    if mailbox in GOOGLE:
        uk, pk, hk = ACCOUNTS[mailbox]
        user, pw, host = env.get(uk), env.get(pk), env.get(hk)
        if not pw:
            raise RuntimeError(f"{mailbox}: no password in .env")
        M = imaplib.IMAP4_SSL(host, 993, ssl_context=ssl.create_default_context())
        M.login(user, pw)
        return M, user
    if mailbox == "mzk":
        import oauth_m365
        tok = oauth_m365.access_token()
        user = oauth_m365.USER
        auth = f"user={user}\x01auth=Bearer {tok}\x01\x01"
        M = imaplib.IMAP4_SSL("outlook.office365.com", 993, ssl_context=ssl.create_default_context())
        M.authenticate("XOAUTH2", lambda x: auth.encode())
        return M, user
    raise RuntimeError(f"unknown mailbox {mailbox}")


def smtp_send(mailbox, env, msg):
    if mailbox in GOOGLE:
        uk, pk, _ = ACCOUNTS[mailbox]
        user, pw = env.get(uk), env.get(pk)
        s = smtplib.SMTP("smtp.gmail.com", 587, timeout=60)
        try:
            s.ehlo(); s.starttls(context=ssl.create_default_context()); s.ehlo()
            s.login(user, pw)
            s.send_message(msg)
        finally:
            try: s.quit()
            except Exception: pass
        return user
    if mailbox == "mzk":
        import oauth_m365
        tok = oauth_m365.access_token()
        user = oauth_m365.USER
        auth = base64.b64encode(f"user={user}\x01auth=Bearer {tok}\x01\x01".encode()).decode()
        s = smtplib.SMTP("smtp.office365.com", 587, timeout=60)
        try:
            s.ehlo(); s.starttls(context=ssl.create_default_context()); s.ehlo()
            code, resp = s.docmd("AUTH", "XOAUTH2 " + auth)
            if code != 235:
                raise RuntimeError(f"SMTP AUTH failed {code}: {resp.decode(errors='replace')[:120]}")
            s.send_message(msg)
        finally:
            try: s.quit()
            except Exception: pass
        return user
    raise RuntimeError(f"unknown mailbox {mailbox}")


def clean(s):
    return (s or "").replace("\x00", "")


def mode_list(mailbox, days, maxn):
    env = load_env()
    M, _user = imap_connect(mailbox, env)
    try:
        M.select("INBOX", readonly=True)
        since = (datetime.date.today() - datetime.timedelta(days=days)).strftime("%d-%b-%Y")
        typ, d = M.uid("SEARCH", None, f"(SINCE {since})")
        uids = d[0].split() if d and d[0] else []
        out = []
        for u in uids[-maxn:]:
            typ, data = M.uid("FETCH", u, "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])")
            if typ != "OK" or not data or not isinstance(data[0], tuple):
                continue
            msg = email.message_from_bytes(data[0][1])
            out.append({
                "mailbox": mailbox,
                "uid": u.decode(),
                "message_id": clean(msg.get("Message-ID", "")).strip(),
                "from": clean(dec(msg.get("From", ""))),
                "to": clean(dec(msg.get("To", ""))),
                "subject": clean(dec(msg.get("Subject", ""))),
                "date": clean(dec(msg.get("Date", ""))),
            })
        return {"messages": out}
    finally:
        try: M.logout()
        except Exception: pass


def _msgid_at(M, uid):
    typ, data = M.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
    if typ != "OK" or not data or not isinstance(data[0], tuple):
        return None
    m = email.message_from_bytes(data[0][1])
    return (m.get("Message-ID", "") or "").strip()


def _raw_at(M, uid):
    typ, data = M.uid("FETCH", uid, "(BODY.PEEK[])")
    if typ != "OK" or not data or not isinstance(data[0], tuple):
        return None
    return data[0][1]


def build_forward(user, to_addr, raw_original):
    orig = email.message_from_bytes(raw_original, policy=email.policy.default)
    subj = clean(dec(str(orig.get("Subject", ""))))
    o_from = clean(dec(str(orig.get("From", ""))))
    o_date = clean(dec(str(orig.get("Date", ""))))
    o_to = clean(dec(str(orig.get("To", ""))))
    fwd = EmailMessage()
    fwd["From"] = user
    fwd["To"] = to_addr
    fwd["Subject"] = "Fwd: " + subj
    fwd["Date"] = formatdate(localtime=True)
    fwd["Message-ID"] = make_msgid()
    fwd.set_content(
        "---------- Forwarded message ----------\n"
        f"From: {o_from}\nDate: {o_date}\nSubject: {subj}\nTo: {o_to}\n\n"
        "(original message attached)\n"
    )
    fwd.add_attachment(orig, subtype="rfc822",
                       filename=((subj[:50] or "message") + ".eml"))
    return fwd


def imap_move(M, mailbox, uid):
    dest = ARCHIVE_FOLDER.get(mailbox, "Archive")
    try:
        typ, _ = M.uid("MOVE", uid, dest)
        if typ == "OK":
            return True
    except Exception:
        pass
    typ, _ = M.uid("COPY", uid, dest)
    if typ != "OK":
        return False
    M.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
    M.expunge()
    return True


def mode_exec(plan, dry):
    mailbox = plan.get("mailbox")
    actions = plan.get("actions", []) or []
    if not mailbox or not actions:
        return {"results": [], "error": "empty plan"}
    env = load_env()
    M, user = imap_connect(mailbox, env)
    results = []
    ledger = load_ledger()
    try:
        M.select("INBOX")  # read-write (MOVE needs it); all reads use PEEK
        for a in actions:
            op = a.get("op")
            uid = str(a.get("uid", ""))
            expect = (a.get("message_id", "") or "").strip()
            key = key_for(mailbox, a)
            if key in ledger:  # DE-DUP: already done earlier → never send/move again
                pr = ledger[key]
                did = ("forwarded to " + pr.get("to", "")) if op == "forward" else "archived"
                results.append({"op": op, "uid": uid, "ok": True, "dup": True,
                                "detail": f"{'DRY: ' if dry else ''}already {did} on {pr.get('ts', '?')[:16]} — skipped, not re-sent"})
                continue
            try:
                actual = _msgid_at(M, uid)
                if actual is None:
                    results.append({"op": op, "uid": uid, "ok": False, "detail": "SKIP: message not found (moved/deleted)"})
                    continue
                if expect and actual and expect != actual:
                    results.append({"op": op, "uid": uid, "ok": False, "detail": "SKIP: id mismatch — mailbox shifted, not touching it"})
                    continue
                if op == "forward":
                    to_addr = parseaddr(a.get("to", ""))[1]
                    if not to_addr:
                        results.append({"op": op, "uid": uid, "ok": False, "detail": "SKIP: no recipient"})
                        continue
                    raw = _raw_at(M, uid)
                    if not raw:
                        results.append({"op": op, "uid": uid, "ok": False, "detail": "SKIP: could not fetch original"})
                        continue
                    msg = build_forward(user, to_addr, raw)
                    if dry:
                        results.append({"op": op, "uid": uid, "ok": True, "detail": f"DRY: would forward to {to_addr}"})
                    else:
                        smtp_send(mailbox, env, msg)
                        ledger[key] = {"ts": _now_iso(), "to": to_addr}; save_ledger(ledger)
                        results.append({"op": op, "uid": uid, "ok": True, "detail": f"forwarded to {to_addr}"})
                elif op == "archive":
                    if dry:
                        results.append({"op": op, "uid": uid, "ok": True, "detail": "DRY: would archive"})
                    else:
                        ok = imap_move(M, mailbox, uid)
                        if ok:
                            ledger[key] = {"ts": _now_iso()}; save_ledger(ledger)
                        results.append({"op": op, "uid": uid, "ok": ok, "detail": "archived" if ok else "move failed"})
                else:
                    results.append({"op": op, "uid": uid, "ok": False, "detail": f"unknown op {op}"})
            except Exception as ex:
                results.append({"op": op, "uid": uid, "ok": False, "detail": f"{type(ex).__name__}: {ex}"})
        return {"results": results}
    finally:
        try: M.logout()
        except Exception: pass


def mode_check(plan):
    """Ledger-only (no network): which actions were already done? For an honest plan card."""
    mailbox = plan.get("mailbox")
    ledger = load_ledger()
    out = []
    for a in plan.get("actions", []) or []:
        pr = ledger.get(key_for(mailbox, a))
        out.append({"op": a.get("op"), "uid": str(a.get("uid", "")), "message_id": a.get("message_id", ""),
                    "to": a.get("to", ""), "dup": bool(pr), "since": (pr or {}).get("ts", "")})
    return {"checked": out}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    pl = sub.add_parser("list")
    pl.add_argument("--mailbox", required=True)
    pl.add_argument("--days", type=int, default=10)
    pl.add_argument("--max", type=int, default=40)
    pe = sub.add_parser("exec")
    pe.add_argument("--dry-run", action="store_true")
    sub.add_parser("check")
    args = ap.parse_args()
    try:
        if args.mode == "list":
            out = mode_list(args.mailbox, args.days, args.max)
        elif args.mode == "check":
            out = mode_check(json.load(sys.stdin))
        else:
            plan = json.load(sys.stdin)
            out = mode_exec(plan, args.dry_run)
    except Exception as ex:
        out = {"error": f"{type(ex).__name__}: {ex}"}
    json.dump(out, sys.stdout, ensure_ascii=False)
