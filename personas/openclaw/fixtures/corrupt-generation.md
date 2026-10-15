# Corrupt SQLite generation

`corrupt-generation.sqlite` is an 8192-byte synthetic SQLite database with
exactly one deliberately damaged byte. Byte zero is `0x00` instead of the
header's initial `S` (`0x53`). The remaining header, schema and table pages are
unchanged. SQLite inspection must report `SQLITE_NOTADB` / "file is not a
database" when it reads the damaged header.
The file contains only the fixture marker `KOVA_CORRUPT_GENERATION`; it contains
no copied user state or OpenClaw session history.

SHA-256: `c5568ab85c1a6013d04ce246081d840c124dc52f1b70e22621451d1bc1be6256`.

The file was constructed with Python's standard-library SQLite implementation:

```python
from pathlib import Path
import sqlite3

path = Path("corrupt-generation.sqlite")
assert not path.exists()
connection = sqlite3.connect(path)
connection.executescript("""
PRAGMA page_size=4096;
PRAGMA journal_mode=DELETE;
CREATE TABLE fixture(value TEXT NOT NULL);
INSERT INTO fixture(value) VALUES ('KOVA_CORRUPT_GENERATION');
""")
connection.close()
with path.open("r+b") as output:
    output.seek(0)
    output.write(b"\x00")
path.chmod(0o600)
```

SQLite versions can stamp different producer-version bytes in the header.
The checked-in file and its recorded digest are the fixture authority; the
recipe documents the deliberate corruption. This minimal fixture does not
claim the OpenClaw agent schema. Doctor tests physical integrity before schema
admission on its corruption-recovery path.

Header corruption also preserves the fixture across OCM `--include-state`
export and import. That archive mode recognizes SQLite by its exact magic
bytes and snapshots recognized databases, rejecting damaged snapshots. A
fixture with an intact header and a damaged table page therefore cannot be
exported. This damaged header makes the corrupt generation an opaque binary
archive member; the `.sqlite` filename stays unchanged. No healthy database
is hidden from backup, and the checks still require SQLite to diagnose the
committed damaged generation and Doctor to perform the real recovery.

`support/persona/quarantine-generation.mjs` provides separate operations:

- `stage-corrupt` copies the fixture into the selected persona's
  `agents/main/agent/fixtures/corrupt-generation.sqlite`.
- `check-corrupt` verifies its digest and SQLite integrity failure, returning
  its absolute `path`.
- `stage-recovery` copies that retained fixture to `recovery-generation.sqlite`
  in the same fixture directory.
- `recover` runs `doctor --session-sqlite recover` on that second copy and
  records the returned dated filename. The persona lifecycle must stop its
  foreground Gateway before this operation.
- `check-quarantine` verifies the dated file, digest and integrity failure.
  It returns `{}`. The receipt stores a basename so exported personas remain
  inspectable after their state directory moves.

Every operation takes `--env <name>`. No operation writes the live
`openclaw-agent.sqlite`. Recovery preserves the second copy as
`recovery-generation.sqlite.corrupt-<timestamp>`; this retained corruption
artifact is distinct from OpenClaw's durable database-quarantine decisions.
Normal agent database discovery selects the reserved database filenames in
the agent directory; it does not descend into this fixture directory. The
recovery operation explicitly selects its copied `.sqlite` path.

`support/persona/write-stale-locks.mjs write|check --env <name>` produces and
checks two retired `.jsonl.lock` files under `agents/main/sessions`. They use
the historical `{pid, createdAt}` shape, a January 2000 timestamp, and PID
2147483647, which each operation verifies is absent on its host. These are
expired lock residues. They neither hold a lock nor claim that a live process
owner survives export, cloning, or restart. OpenClaw 2026.9.9 already uses a
no-op compatibility implementation for the retired session file-lock API.
