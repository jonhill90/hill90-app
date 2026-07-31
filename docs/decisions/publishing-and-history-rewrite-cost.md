# Publishing this repository: what a history rewrite would cost

**Status: decision aid, not a decision.** Nothing here is a recommendation. The input
that decides it is risk tolerance, which is Jon's and has not been stated. Measured
2026-07-31 against `main` at 619 commits.

## First, the thing that changes the shape of the question

**The current tree contains neither identifier.** Both were redacted on 2026-07-29 in
`de08e4f` (#14). Verified: zero occurrences of either on `main` today.

So a visitor who clones and reads sees nothing. The exposure is **in history only**, and
reaching it takes `git log -S` or a search of the commit archive — deliberate work, not an
accident.

And the repository is **still private**. That matters more than it sounds: a rewrite
performed *before* first publication actually removes the values from what the world can
fetch. A rewrite performed *after* does not — pushed objects stay reachable by SHA on
GitHub even when unreferenced, so the window for this to be effective is open now and
closes at publication.

## The measurements

The pickaxe count and the rewrite scope are different numbers, and the difference is the
whole cost. `git log -S` finds commits where the number of occurrences *changed*; a filter
must rewrite every commit whose *tree contains* the string.

| Exposed item | `git log -S` hits | Commits whose tree contains it | Paths | Earliest | Commits that would get new SHAs |
|---|---|---|---|---|---|
| `100.88.29.112` (tailnet address) | **4** | **59** | **1** | `d2a9f64`, 2026-07-27 | 64 on `main` |
| `remote.hill90.com` (SSH alias) | **7** | **380** | **4** | `4bf4bd1`, 2026-04-04 | **374** on `main` |
| `jonhill90@live.com` (author email) | n/a — commit **metadata**, not file content | ~all (1065 author/committer fields) | n/a | first commit | **619** on `main`, 754 across all refs |

The 4 and 7 were measured independently and are correct as pickaxe counts. The 59 and 380
are the numbers that decide the work.

Other facts a filter author needs:

- **Zero merge commits** in the affected range. This removes a whole class of difficulty —
  no merge rewriting, no risk of collapsing a merge's second parent.
- **All 3 tags point inside the range** (`pre-rebase-12`, `pre-rebase-16`,
  `pre-rebase-17`) and would all need re-pointing.
- **No GitHub releases exist**, so nothing depends on a release asset.
- The affected paths are **markdown only** — one decision record for the address, plus
  three runbooks for the alias. Nothing in code, compose or CI carries either.

## What a filter would have to touch

Two different operations with very different reach:

- **The two identifiers:** a content replacement over 4 paths — `git filter-repo
  --replace-text` with two rules. Narrow, and mechanically simple because the paths are
  few and no merges are involved.
- **The email:** a metadata rewrite over every commit — `--email-callback` or a mailmap.
  There is no way to scope this; the address is in the author and committer fields of
  essentially every commit, so the earliest rewritten commit is the first commit and
  **every SHA in the repository changes.**

Those can be done together or separately. Doing the identifiers alone changes 374 SHAs;
including the email changes all 619.

## What breaks, stated plainly

- **Every commit SHA after the earliest rewritten commit changes.** 374 for the
  identifiers, 619 if the email is included.
- **A force-push is required**, and **every existing clone diverges.** Anyone holding one
  must re-clone or hard-reset; a `git pull` will not reconcile it.
- **74 merged pull requests each record a merged commit SHA.** All were squash-merged
  (which is why there are no merge commits), so every one of those SHAs would no longer
  exist on the branch and the PR pages would reference orphaned commits.
- **Any external link to a commit breaks** — anything of the form
  `github.com/.../commit/<sha>`, in a chat log, an issue, a bookmark or another
  repository's notes.
- **Three tags need moving.**
- **`docs/extraction/VERIFICATION.md` carries 33 SHA-like strings.** Most are Hill90's
  own commits and are unaffected, but at least one resolves to a commit in *this*
  repository and would become dangling. That file is the extraction's audit trail, so a
  rewrite makes the record of the extraction partly unverifiable against the repository it
  describes.

## The three options, with their true costs

**1. Publish as-is.** Cost: the tailnet address and the SSH alias remain findable in
history by anyone who looks for them, and the email remains in commit metadata. No SHAs
change, nothing breaks, the extraction audit trail stays verifiable, and the work is zero.

**2. Rewrite, then publish.** Cost: everything under "What breaks". Roughly an hour of
careful work for the identifiers, plus verification that the replacement caught every
blob; the email variant is the same operation over a larger range. Effective, because the
repository is private today — the values have not been served to anyone yet.

**3. Keep the repository private.** Cost: no exposure and no rewrite, but the repository
does not become the public artefact it was extracted to be, and the docs site continues to
describe a codebase nobody can read. This is the only option that also protects anything
found *later*, since it does not depend on today's search being complete.

## Which of the three actually matters

This is the part that is not obvious from the counts, and it does not rank the way the
numbers do.

**The tailnet address matters least, and arguably not at all — because it is already
public by another route.** `100.64.0.0/10` is the Tailscale CGNAT range: not routable from
the internet, and useful only to somebody who is already on the tailnet, for whom it is
discoverable anyway. More decisively, **public DNS already serves this exact address**: six
hostnames in the zone resolve to it on any public resolver, verified 2026-07-31 and
recorded in Hill90's `docs/architecture/security.md`. Rewriting 374 commits to conceal a
value that the DNS answers on request achieves nothing. If this address is the concern, the
fix is in DNS, not in git.

**The SSH alias is the one with real leverage, and only in combination.** On its own it is
a hostname. Combined with what the repository legitimately documents — that deploys run
over SSH from a CI runner across Tailscale, as a specific deploy user, into a specific
path — it tells someone who has *already obtained tailnet access* precisely where to go and
as whom, with no reconnaissance. That is a genuine reduction in an attacker's work. The
precondition is still tailnet access, which neither the alias nor the deploy path provides.

**The email is a nuisance rather than a weakness.** It is a real address, so it adds to
spam and phishing surface, and phishing is a plausible route to the credentials that do
matter. But it is almost certainly exposed already through any public commit authored
anywhere else, and rewriting it here costs every SHA in the repository — the largest cost
of the three for the smallest security gain.

So the ordering by what an attacker gains is: **SSH alias (in combination) > email >
tailnet address (already public via DNS)** — which is the reverse of the ordering by how
much work each would take to remove.

## One thing not to conclude from this document

Nothing above is a claim that the current tree is unsafe to publish. It is not, on these
two identifiers: they are gone from it. The question is only whether history should carry
them, and that is a judgement about who might look and what they would gain — not a defect
waiting to be fixed.
