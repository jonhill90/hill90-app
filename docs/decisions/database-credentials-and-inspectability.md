# Why the database password sits in a URL, and what to do about it

**Status:** decided — keep `DATABASE_URL`, add a safe way to answer the question that
caused the leak. Recorded 2026-07-30.

## What happened

Twice in one session, a fragment of a live Postgres password reached a transcript. Both
times the person was doing something entirely reasonable: checking **which database a
running container is actually pointing at**. The natural command for that is

```bash
docker inspect app-api --format '{{range .Config.Env}}{{println .}}{{end}}' | grep DATABASE_URL
```

and `DATABASE_URL` is `postgresql://user:password@host:5432/db`. The password is not
incidental to the answer — it is *inside* the answer. You cannot read the host without
reading the credential.

**That is a property of the shape, not of the person inspecting.** Anyone verifying a
cutover will run that command, and the shape will leak every time.

## The framing that matters, and the one that does not

The tempting conclusion is "don't put passwords in URLs". It is the wrong lesson,
because splitting `DATABASE_URL` into `PLATFORM_DB_HOST`, `PLATFORM_DB_USER` and
`PLATFORM_DB_PASSWORD` **does not hide the secret from `docker inspect`**. `inspect`
prints the whole environment. `PLATFORM_DB_PASSWORD` would be just as visible — as
`AUTH_SECRET`, `AUTH_KEYCLOAK_SECRET`, `MINIO_ROOT_PASSWORD` and
`LITELLM_MASTER_KEY` already are on these same containers.

The real defect is narrower and more interesting:

> **The diagnostic question and the secret are coupled.** Answering *"which host is
> this talking to?"* requires printing a string that contains the password.

Splitting the components decouples them. You print `PLATFORM_DB_HOST` and the database
name, and never touch the password variable. The routine check stops being a leak
**by construction** rather than by remembering to truncate — and truncation is what
failed both times, because a 70-character cut of a URL lands in the middle of the
credential.

## Why we are not splitting the variables

Three of the four consumers could take components today:

| Service | How it connects | Could take components? |
|---|---|---|
| `api` | `new Pool({ connectionString })`, `db/pool.ts:8` | yes — `node-pg` accepts `host`/`user`/`password`/`database` |
| `ai` | `asyncpg.create_pool(settings.database_url)`, `main.py:87` | yes — asyncpg accepts keyword arguments |
| `knowledge` | pydantic `database_url` | yes |
| `litellm` | `database_url: os.environ/DATABASE_URL`, `litellm_config.yaml:45` | **no** |

**Prisma, which LiteLLM uses, requires a single connection URL.** It cannot be handed
components. Splitting the other three would leave one service still holding an inline
credential, so the leaky shape survives — and now the estate has two conventions, which
is worse than one bad one. Composing the URL inside a LiteLLM entrypoint would work, but
it means an entrypoint script whose only job is to reassemble a secret, and a wrapper
around a vendored image is a maintenance surface we would own forever.

**So `DATABASE_URL` stays.** The exception is written down here rather than fought.

## What changes instead

The fix is to make the safe answer easy, since the unsafe one is the natural one.
`scripts/db-target.sh` prints where each service is pointed, with the credential
removed at the source:

```
$ ssh deploy@<host> 'cd /opt/hill90-app && bash scripts/db-target.sh'
app-api          postgresql://hill90_app:<redacted>@postgres:5432/hill90_api
app-ai           postgresql://hill90_app:<redacted>@postgres:5432/hill90_api
app-litellm      postgresql://hill90_app:<redacted>@postgres:5432/hill90_litellm
app-knowledge    postgresql://hill90_app:<redacted>@postgres:5432/hill90_akm
```

It answers the question that caused both leaks — host, user, database, and which
instance — and it cannot print a password, because it never reads one into a variable
that gets emitted. A test asserts that: given a URL with a password, the output does not
contain it.

This does not stop anyone running `docker inspect` directly. It removes the *reason* to.

## What would actually remove the secret from `inspect`

Recorded for completeness, not proposed:

- **Secrets as mounted files.** The environment holds a path; the value never enters it.
  Strongest option, and it needs every consumer to support a `*_FILE` convention.
  Neither `node-pg` nor Prisma does natively.
- **A secrets agent** the services query at startup. Removes the value from both env and
  disk, and adds a runtime dependency on the agent being up before anything can connect.

Both are larger than this problem currently justifies. The reason to write them down is
that "we chose the cheap fix" should be a visible decision rather than an omission.

## See also

- `scripts/db-target.sh` — the redacted view
- `tests/scripts/db-target.bats` — asserts it cannot leak
