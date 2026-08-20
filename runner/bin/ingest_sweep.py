#!/usr/bin/env python3
"""Backfill/refresh sweeper: SOURCE dirs -> inbox, in batches (Phase 2c installer).

Walks INGEST_SOURCE_DIRS (colon-separated roots, e.g. a client's documents tree),
COPIES supported documents into INGEST_INBOX/sweep/ where the governed `ingest`
pipeline picks them up (route -> store trust:unverified). NEVER mutates, moves or
deletes anything under the source roots.

Change tracking ("always the latest data"): the manifest (INGEST_DIR/sweep_manifest.jsonl)
keys each copy by (path | mtime | size). When a source file changes, its key changes ->
it is swept again and the brain reconciles it as an UPDATE (latest-wins; verified facts
still protected by the DISPUTED gate). A content sha layer skips byte-identical
duplicates that merely moved/renamed.

Batched: at most --batch files per run (default 20) so a huge corpus drains over
scheduled runs at a controlled LLM cost instead of one giant burst.

Skips: hidden files/dirs, _archive, _done, _unrouted, node_modules, .git, unsupported
extensions, files > INGEST_SWEEP_MAX_BYTES (default 50 MB), files modified < 60s ago
(mid-write guard for synced folders).

Output (stdout JSON): {"copied":[...], "copied_count":n, "remaining":n,
 "skipped_dupes":n, "skipped_size":n, "sources":[...], "dry_run":bool, "errors":[...]}
`remaining` counts eligible-but-not-copied files so a caller can keep re-running
until the corpus is drained.
"""
import sys, os, json, re, hashlib, argparse, time, shutil

INBOX = os.environ.get("INGEST_INBOX", "/opt/orchestrator/inbox")
INGEST_DIR = os.environ.get("INGEST_DIR", "/opt/orchestrator/ingest")
MANIFEST = os.path.join(INGEST_DIR, "sweep_manifest.jsonl")
MAX_BYTES = int(os.environ.get("INGEST_SWEEP_MAX_BYTES", str(50 * 1024 * 1024)))
STABLE_S = 60  # source file must be this old (seconds) — mid-sync write guard

# Mirrors src/ingest.js TEXT_EXT + EXTRACT_EXT.
DOC_EXT = {
    ".md", ".txt", ".csv", ".tsv", ".json", ".log", ".html", ".htm", ".xml",
    ".yaml", ".yml", ".pdf", ".docx", ".pptx", ".xlsx", ".doc", ".rtf",
    ".epub", ".eml", ".msg",
}
SKIP_DIRS = {"_archive", "_done", "_unrouted", "node_modules", "__pycache__", ".git"}

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(name: str) -> str:
    name = os.path.basename((name or "file").replace("\x00", ""))
    return (_SAFE.sub("_", name).strip("._") or "file")[:120]


def load_manifest():
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


def walk_sources(roots):
    """Yield candidate file paths (supported ext, stable, size-capped) in sorted order."""
    now = time.time()
    for root in roots:
        root = root.rstrip("/")
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS)
            for f in sorted(filenames):
                if f.startswith("."):
                    continue
                if os.path.splitext(f)[1].lower() not in DOC_EXT:
                    continue
                p = os.path.join(dirpath, f)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                if st.st_size > MAX_BYTES or st.st_size == 0:
                    continue
                if now - st.st_mtime < STABLE_S:
                    continue
                yield p, st


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", default=os.environ.get("INGEST_SOURCE_DIRS", ""),
                    help="colon-separated source roots (read-only)")
    ap.add_argument("--batch", type=int, default=int(os.environ.get("INGEST_SWEEP_BATCH", "20")))
    ap.add_argument("--dry-run", action="store_true", help="report what would copy; write nothing")
    args = ap.parse_args()

    roots = [r for r in args.sources.split(":") if r.strip()]
    if not roots:
        json.dump({"copied": [], "copied_count": 0, "remaining": 0, "skipped_dupes": 0,
                   "skipped_size": 0, "sources": [], "dry_run": args.dry_run,
                   "errors": ["no INGEST_SOURCE_DIRS configured — sweep disabled"]}, sys.stdout)
        return

    seen_keys, seen_shas = load_manifest()
    copied, dupes, remaining, errors = [], 0, 0, []
    out_dir = os.path.join(INBOX, "sweep")

    for p, st in walk_sources(roots):
        key = hashlib.sha256(f"{p}|{int(st.st_mtime)}|{st.st_size}".encode()).hexdigest()
        if key in seen_keys:
            continue  # unchanged since last sweep
        if len(copied) >= args.batch:
            remaining += 1
            continue  # over batch — counted so the caller knows to run again
        try:
            with open(p, "rb") as fh:
                payload = fh.read()
            sha = hashlib.sha256(payload).hexdigest()
            if sha in seen_shas:
                # byte-identical content already swept (rename/copy elsewhere) —
                # record the new key so this path stops re-checking, copy nothing.
                dupes += 1
                seen_keys.add(key)
                copied_entry = {"key": key, "sha": sha, "file": p, "note": "dupe-content"}
                if not args.dry_run:
                    append_manifest([copied_entry])
                continue
            seen_keys.add(key)
            seen_shas.add(sha)
            dest_name = f"{key[:10]}__{safe_name(os.path.basename(p))}"
            dest = os.path.join(out_dir, dest_name)
            if not args.dry_run:
                os.makedirs(out_dir, exist_ok=True)
                shutil.copyfile(p, dest)  # copy only — source tree is never touched
                old = time.time() - 90
                os.utime(dest, (old, old))  # pre-age past the inbox stability guard
            copied.append({"key": key, "sha": sha, "file": p, "dest": dest, "bytes": st.st_size})
        except Exception as ex:
            errors.append(f"{p}: {type(ex).__name__}: {ex}")

    if not args.dry_run:
        append_manifest(copied)

    json.dump({"copied": copied, "copied_count": len(copied), "remaining": remaining,
               "skipped_dupes": dupes, "skipped_size": 0, "sources": roots,
               "dry_run": args.dry_run, "errors": errors}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
