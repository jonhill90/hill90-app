# Removing `app-minio` — the procedure, written before the window expires

**Do not run this before 2026-08-01 01:41 UTC.** `app-minio` was stopped 2026-07-31
01:40:43 UTC and the agreed retention is one full day unused.

Removing a container is cheap. Removing `prod_app-minio-data` is **irreversible**. This
exists so the decision at 01:41 is a checklist rather than a judgement call made at speed.

Every check below was **run read-only on 2026-07-31 11:40 UTC** and its result recorded, so
the operator compares against a known baseline instead of deciding what "looks right".

---

## Part 1 — Establish it is genuinely unused. Evidence, not impression.

Run all five. They are cheap. **If any disagrees with the recorded baseline, stop and read
Part 4 before doing anything else.**

### 1.1 The container has not run since it was stopped

```bash
ssh vps 'docker inspect app-minio --format "state={{.State.Status}} exit={{.State.ExitCode}} finishedAt={{.State.FinishedAt}} restarts={{.RestartCount}}"'
```

**Baseline 2026-07-31 11:40 UTC:** `state=exited exit=0 finishedAt=2026-07-31T01:40:43Z restarts=0`.

A changed `finishedAt`, a non-zero `restarts`, or `state=running` all mean somebody started
it. That is not fatal, but it invalidates "one day unused" and the volume check below must
then be treated as the only evidence that matters.

### 1.2 Nothing in production points at it

```bash
ssh vps 'for c in app-api app-ai app-knowledge app-ui app-mcp app-litellm; do
  printf "%-16s %s\n" "$c" "$(docker inspect "$c" --format "{{range .Config.Env}}{{println .}}{{end}}" | grep "^MINIO_ENDPOINT=" | cut -d= -f2-)"
done'
```

**Baseline:** only `app-api` sets it, and it reads **`http://minio:9000`** — the platform's.
Everything else is unset.

Anything resolving to `app-minio:9000` means a running service still depends on it. **Stop.**

### 1.3 Config in both repositories — and the two references that must SURVIVE

```bash
grep -rn "app-minio" --include="*.yml" --include="*.sh" --include="*.env*" . | grep -v node_modules
```

This is the check most likely to be misread, so it is spelled out.

**These must NOT be deleted — local development runs the app's own MinIO deliberately:**

| Path | Why it stays |
|---|---|
| `deploy/compose/prod/docker-compose.minio.yml` | the local override **layers on** this file; deleting it breaks `local.sh up` |
| `deploy/compose/overrides/local.minio.yml` | defines the local `app-minio` |
| `.env.local.example` → `MINIO_ENDPOINT=http://app-minio:9000` | the local endpoint, correct as written |

Whether local moves onto the platform's services is
[a separate open decision](../decisions/local-parity-with-platform-services.md). **Retiring
production is not a licence to delete the local path.** The same reasoning already kept the
`db` and `auth` compose files after those retirements.

### 1.4 The platform holds the buckets

```bash
ssh vps 'docker run --rm -v prod_minio-data:/d:ro alpine sh -c "
  find /d -maxdepth 1 -mindepth 1 -type d ! -name .minio.sys | sed s@/d/@@
  echo objects: \$(find /d -name xl.meta -not -path \"*/.minio.sys/*\" | wc -l)"'
```

**Baseline:** buckets `agent-avatars`, `chat-attachments`, `user-avatars`; **2 objects**,
both `user-avatars/cutover-proof/*` — the cutover proof artefacts, not user data.

Fewer than three buckets means the platform is not yet holding what the tenant expects.
**Stop.**

### 1.5 The real safety check — does the retained volume hold anything the platform's does not?

"The buckets were empty at cutover" is not "the buckets are empty now". This is the check
that decides whether the volume can go.

```bash
ssh vps 'docker run --rm -v prod_app-minio-data:/d:ro alpine sh -c "
  echo size: \$(du -sh /d | cut -f1)
  echo buckets:; find /d -maxdepth 1 -mindepth 1 -type d ! -name .minio.sys | sed s@/d/@@
  echo objects: \$(find /d -name xl.meta -not -path \"*/.minio.sys/*\" | wc -l)
  echo contents:; find /d -maxdepth 2 -mindepth 2 -not -path \"*/.minio.sys/*\""'
```

**Baseline 2026-07-31 11:40 UTC:** 168 KB, buckets `user-avatars`, `agent-avatars`,
`chat-attachments`, **0 objects**, and the depth-2 listing is **empty** — the three bucket
directories contain nothing at all. The 168 KB is `.minio.sys` metadata.

> `xl.meta` is the per-object-version metadata file MinIO writes for every object, so
> counting it counts objects. The depth-2 listing is the independent cross-check: it would
> show a stray file even if it carried no `xl.meta`.

**Any non-zero object count, or any entry in the depth-2 listing, means the volume holds
something the platform does not. Stop and report.**

---

## Part 2 — The removal, and the gate at the moment of removal

**The gate is not the plan. Run it again, here, against what is actually there.** This
estate has already been saved once this week by looking before deleting.

### 2.1 Re-run the gate immediately before removing anything

```bash
ssh vps 'docker run --rm -v prod_app-minio-data:/d:ro alpine sh -c "
  find /d -maxdepth 2 -mindepth 2 -not -path \"*/.minio.sys/*\"; \
  echo objects: \$(find /d -name xl.meta -not -path \"*/.minio.sys/*\" | wc -l)"'
```

**Expect: no listed paths, `objects: 0`.** Anything else — **abort, do not remove, report**.

### 2.2 Remove the container

```bash
ssh vps 'docker rm app-minio && docker ps -a --filter name=app-minio --format "{{.Names}}" | wc -l'
```

Expect `0`. This also removes the stale Traefik labels: while the container exists,
`docker start app-minio` recreates the `storage.hill90.com` router collision, and because
**both backends are MinIO the host answers 200 either way** — it would look fine.

### 2.3 Close the path that recreates it — otherwise the removal is undone

**This is the step most likely to be skipped, and skipping it silently reverses everything
above.** `minio` is still in `DEPLOY_REST` in `scripts/deploy.sh`, so **`deploy.sh minio`
and `deploy.sh all` will both happily recreate `app-minio` in production.** That is exactly
the failure `refuse_if_retired` was written for after `db` and `auth` — and `minio` was
never added to it.

Add a `minio)` branch to `refuse_if_retired()` in the same shape as `db` and `auth`, naming:
the retirement date, that object storage is the platform's `minio` via the scoped
`tenant-hill90-app` credential, and that the **local** compose files are untouched by the
refusal.

Until that lands, treat the removal as provisional: the next `deploy all` reverses it.

### 2.4 The volume — and the argument against keeping it

The instinct is to keep the volume because it is "the only irreplaceable half". **On the
measured evidence that is not true here: it contains no data.** Zero objects, three empty
bucket directories, 168 KB of MinIO's own metadata.

So keeping it does not preserve anything. What it does preserve is a **belief** — that a
safety net exists — and that belief is itself the risk: a future reader sees a retained
`prod_app-minio-data` and reasonably concludes the tenant's old objects are in it. They are
not, and never were after the cutover.

**Recommendation: remove the volume too, once 2.1 passes**, and record that it was empty
rather than leaving an empty volume standing in for a backup.

```bash
ssh vps 'docker volume rm prod_app-minio-data && docker volume ls --format "{{.Name}}" | grep -c prod_app-minio-data'
```

Expect `0` (grep exits 1 on no match, which is the success case here).

**If you prefer to keep it anyway** — a defensible choice, it costs 168 KB — then write into
[`HANDOFF-2026-07-31.md`](../decisions/HANDOFF-2026-07-31.md) that it is **retained and
empty**, so nobody later mistakes it for the tenant's object history. An unlabelled retained
volume is worse than either removing it or labelling it.

Note it is in **no backup**: `backup.sh backup-all` covers `prod_minio-data`, not
`prod_app-minio-data`. Removing it is therefore final in the strict sense — see the
platform's `docs/reference/backup-coverage.md`.

---

## Part 3 — Afterwards

```bash
ssh vps 'echo "total $(docker ps -q|wc -l) unhealthy $(docker ps --filter health=unhealthy -q|wc -l) platform $(docker ps --format "{{.Names}}"|grep -vcE "^app-")"'
```

Expect **23 / 0 / 16** unchanged — `app-minio` was already stopped, so removing it changes
no running count. If a number moves, something else happened at the same time.

Then confirm `storage.hill90.com` still serves the **platform's** console (403 off-tailnet
is the healthy answer — the edge allowlist, not a fault), and update the handoff entry from
"stopped, not removed" to what actually happened.

---

## Part 4 — What would make me abort

Any one of these. None is a judgement call.

1. **The volume contains any object** — non-zero `xl.meta` count, or any entry in the
   depth-2 listing. It holds something the platform does not, and the premise of this whole
   procedure is false.
2. **`finishedAt` has moved, or `restarts` is non-zero, or it is running.** Somebody used it
   during the retention window. Find out why before removing anything.
3. **Any running production service resolves `MINIO_ENDPOINT` to `app-minio`.** Something
   still depends on it.
4. **The platform's MinIO is missing any of the three buckets.** The destination is not
   ready to be the only copy.
5. **Anything in the grep from 1.3 that is not accounted for** — specifically a *production*
   reference beyond `docker-compose.minio.yml` and `deploy.sh`. Local references are
   expected and must survive.

In every case: **stop, change nothing, and report what was found.** The window expiring is a
permission to proceed, not an instruction to.
