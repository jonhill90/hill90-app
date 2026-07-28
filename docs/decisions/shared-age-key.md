# One Age Key Per Host, Shared Between Hill90 and hill90-app

**Status:** decided and implemented
**Decided:** 2026-07-28
**Recorded:** 2026-07-28

Written because review pointed out, correctly, that this arrangement arrived as
a side effect of fixing a broken path rather than as a decision anyone made. It
is now a decision.

## Context

hill90-app is a tenant of the Hill90 platform: it runs its own containers on
Hill90's host, attached to Hill90's networks, behind Hill90's Traefik. Both
repositories keep their production secrets in a SOPS store encrypted to an age
key, and both are deployed by GitHub Actions over SSH as the same `deploy` user.

The question is whether the tenant gets its own age key or uses the host's.

The app's deploy workflow originally defaulted `VPS_AGE_KEY` to
`/opt/hill90-app/infra/secrets/keys/age-prod.key`, with a comment asserting that
a separate key was required because "a tenant must not be able to decrypt
platform secrets."

**That file could never have existed.** Age private keys are not committed, and
Hill90's own checkout on the VPS carries only `age-dev.pub`, `age-prod.pub` and a
`.gitkeep` at the equivalent path. The workflow would have failed on first run.

## Decision

**One age key per host. Both repositories encrypt to it.**

```
/opt/hill90/secrets/keys/keys.txt        -rw------- deploy deploy
~deploy/.bashrc:28                       export SOPS_AGE_KEY_FILE=...keys.txt
public half                              age1p30vk2qpvlkj5pzh72f0wwvlqgmedvr204nldmpskmptgy9ryg8qg9qd5v
```

`hill90-app/infra/secrets/.sops.yaml` encrypts to that public half, the same one
Hill90's `.sops.yaml` uses. The deploy workflow exports `SOPS_AGE_KEY_FILE` to
that path inline in the ssh invocation rather than relying on the shell profile,
because a non-interactive ssh does not reliably source `.bashrc`. Hill90's
reusable workflow does the same, for the same reason.

## Why not a separate key for the tenant

The isolation argument sounds right and does not survive contact with the host.

**Both deploys run as the same `deploy` user, on the same box, from trees that
user owns.** The key is mode `600` owned by `deploy`. Anything the app's deploy
can execute can already read `/opt/hill90/secrets/keys/keys.txt` — a second key
would not change that, because the boundary it appeals to is not enforced
anywhere. It is isolation theatre.

What a second key *would* add is real: another key to generate, distribute to the
host, hold as a GitHub secret, and rotate. Two keys that must both be rotated,
where one of them provides no access the other did not already grant.

A genuine tenant boundary would need the app to deploy as a different Unix user
with its own home and its own key, and Hill90's tooling, `deploy.sh`,
`/opt/hill90` ownership and the SSH configuration all assume a single `deploy`
user. That is a much larger change than a key file, and it is not the change
being made here. If it is ever made, this decision should be revisited with it —
a separate key only becomes meaningful once a separate user exists.

## Consequences

**Rotating Hill90's age key breaks hill90-app's secrets.** This is the important
one and it is not obvious from either repository in isolation.

The two stores are independent files encrypted to a shared recipient. Rotating
the key means re-encrypting **both**:

```
# in Hill90
sops rotate -i infra/secrets/prod.enc.env

# in hill90-app — DO NOT SKIP
sops rotate -i infra/secrets/prod.enc.env
```

and updating the `SOPS_AGE_KEY` GitHub secret in **both** repositories, plus the
key file on the host. Missing the app half leaves a store nothing on the VPS can
decrypt, and the failure appears at the next app deploy as a SOPS error during
`Get Tailscale IP` — in a different repository from the change that caused it,
possibly weeks later.

**This repository's `SOPS_AGE_KEY` can decrypt Hill90's store.** The capability
exists even though this repository never holds Hill90's ciphertext. Anyone with
write access here, or with the ability to add a workflow step, could exfiltrate
Hill90's secrets by fetching that ciphertext. This is the honest price of the
decision. It is accepted because the same person administers both repositories
and the same `deploy` user runs both deploys — the trust boundary the arrangement
would violate does not exist in the first place.

**A compromise of either repository's Actions secrets compromises both stores.**
The blast radius of a leaked `SOPS_AGE_KEY` is now two repositories rather than
one.

## Alternatives considered

- **Separate key per repository** — rejected above. No boundary, real cost.
- **Separate key plus a separate deploy user** — the arrangement that would make
  isolation real. Out of scope: it touches Hill90's `deploy.sh`, the `/opt/hill90`
  ownership model and the SSH configuration. Revisit together, not separately.
- **OpenBao instead of SOPS for the app** — Hill90 already runs OpenBao and
  `platform/vault/policies/policy-{api,ai,ui,mcp,knowledge}.hcl` describe the KV
  layout the services once expected. This is the better long-term answer, since
  an AppRole per service is a boundary that is actually enforced. It needs an
  AppRole and policy, which is a Hill90-side change, and the vault work is
  explicitly out of scope (Hill90 #547/#536). `scripts/_common.sh` keeps the
  vault-first/SOPS-fallback signature so adding it later does not change callers.

## See also

- [running-the-app-on-hill90-infra.md](running-the-app-on-hill90-infra.md) — the
  tenancy work this came out of, including the retraction of the original
  separate-key claim
- `.github/workflows/reusable-deploy-service.yml` — where `VPS_AGE_KEY` is set
- `infra/secrets/.sops.yaml` — the recipient
