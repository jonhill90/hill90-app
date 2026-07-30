# Knowledge entries are permanent, and that is a correctness problem

**Status:** recorded, not fixed. The decision about what to build is Jon's, because it
touches retention and audit. Recorded 2026-07-30.

## The finding

**There is no way to delete a knowledge entry through the application, at any privilege
level.** Not as a user, not as an admin, not as an internal service.

Established by reading the code, not inferred:

| Fact | Where |
|---|---|
| The AKM exposes only two write routes: `POST /entries/{agent_id}` and `POST /journal/{agent_id}` | `services/knowledge/app/routes/internal_admin.py:188,214` |
| No `DELETE` route exists anywhere in the AKM | same file — `@router.delete` appears zero times |
| The api's knowledge router has no delete either | `services/api/src/routes/knowledge.ts` — `router.delete` appears zero times |
| Deleting an *agent* removes its row and its S3 avatar, and nothing else | `services/api/src/routes/agents.ts:1005-1046` |
| `knowledge_entries` has **no foreign keys**, so nothing cascades from anywhere | verified against the live platform database: `pg_constraint` returns no rows of type `f` for that table |

So an entry, once written, stays until someone runs SQL against production.

## Why this is a data-integrity issue and not a missing feature

The AKM exists so that **agents** can write what they learn. An agent is a process that
can be wrong — about a fact, a file path, a person's name, an instruction it
misunderstood. The knowledge base is the memory it will read back and act on later.

**A wrong fact written by an agent cannot be corrected or removed through the product.**
It will be read back, and acted on, indefinitely. That is not an inconvenience for an
operator; it is a store that accumulates errors monotonically and has no repair path.

Three concrete consequences:

- **No correction.** `POST` on an existing path may overwrite content, but there is no
  way to remove an entry that should never have existed — a wrong path, a wrong agent, a
  duplicate.
- **No redaction.** If an agent writes something that should not be retained — a
  credential it saw, personal data, a customer name — the only remedy is SQL. There is
  no product-level answer to "delete this".
- **No cleanup after a mistake.** Which is how this was found: removing **two** test rows
  I had created minutes earlier required a hand-written `DELETE` against the production
  database plus explicit authorisation from the reviewer. Two rows, and the only available
  tool was raw SQL on production.

That last one is the smallest possible version of the problem, and it still needed an
out-of-band intervention. A real case — an agent that has written fifty entries from a
bad premise — has the same shape and fifty times the exposure.

## What was actually done in the meantime

The two test rows were removed with a single scoped `DELETE` inside a transaction that
refused to commit unless exactly zero rows remained:

```sql
BEGIN;
DELETE FROM knowledge_entries
 WHERE agent_id = 'rotation-proof-030307' AND path = 'rot-030421.md';
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM knowledge_entries;
  IF n <> 0 THEN RAISE EXCEPTION 'expected 0 rows remaining, found %', n; END IF;
END $$;
COMMIT;
```

Recorded because it is the current procedure, and because a procedure that consists of
"write careful SQL against production" should be visibly unsatisfactory rather than
quietly normal.

## Why this is not being built tonight

It is not a `DELETE` route. The questions it opens are Jon's:

- **Hard delete or soft?** A knowledge base an agent reads back has different needs from
  an audit log. Soft delete keeps history and needs every read path to respect it —
  `knowledge_store` and the search path both.
- **Who may delete?** The app's own answer would presumably be the `admin` client role,
  but an agent correcting its own mistake is a different actor from an operator redacting
  something, and they may not want the same permission.
- **Does deletion need an audit trail?** `auditLog` already records agent create and
  delete (`agents.ts:42`). A deletion in the knowledge base is exactly the event someone
  would later want evidence of.
- **What about the file on disk?** `knowledge_store.create_entry` writes to `data_dir` as
  well as the database. A delete that clears the row and leaves the file is a new
  inconsistency, not a fix.
- **Retention.** If entries can be removed, "how long do we keep knowledge" becomes a
  question with an answer, and it currently does not have one.

Any of those decided wrongly makes the store less trustworthy than it is now. That is why
this document stops here.

## An adjacent finding, same service

`FrontmatterError` is raised for invalid entry content, and `create_entry` catches only
`ValueError`:

```python
except ValueError as e:
    raise HTTPException(status_code=400, detail=str(e))
```

`FrontmatterError` subclasses `Exception`, not `ValueError`
(`services/knowledge/app/services/frontmatter.py:8`), so it escapes unhandled and FastAPI
returns its default plain-text `500 Internal Server Error`. A validation failure is
reported as a server fault, and the message naming the actual problem stays in the AKM's
own log.

This is a one-line fix — catch `FrontmatterError` explicitly, or have it subclass
`ValueError` — and it is worth doing, because it is the difference between a caller
seeing `required frontmatter field missing: type` and seeing `Internal Server Error`.
Not done here to keep this document a record rather than a change.

## See also

- `services/knowledge/app/routes/internal_admin.py` — the two write routes, and nothing else
- `services/api/src/services/akm-proxy.ts` — now surfaces the AKM's own error rather than
  a JSON parser's complaint about it, which is what made the 500 above legible at all
