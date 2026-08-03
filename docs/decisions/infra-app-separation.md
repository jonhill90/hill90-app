# Infra/App Separation

**Status: SUPERSEDED by events. Kept as a stub because six documents cite it.**

**Decided 2026-07-11. Overtaken 2026-07-26 to 2026-07-29.**

## What it decided

That Hill90 would become a homelab domain rather than an application host, the AI
agent application would be **shelved**, and the reusable value of both Hill90 and
`k8s-homelab` would be extracted into **two fresh, generic, public boilerplate
repositories** — a Docker one and a Kubernetes one (kubeadm + containerd + Calico
over k3s, chosen for the etcd experience). Hill90 and `k8s-homelab` would be
archived and left untouched as sources.

## What actually happened

**None of that.** No boilerplate repository was created and nothing was archived.
Instead the application was extracted into
[`hill90-app`](https://github.com/jonhill90/hill90-app) as a working repository on
2026-07-26, and since 2026-07-29 it has run in production as a **tenant** of
Hill90 rather than being shelved. Hill90 remained the live platform and gained a
tenancy contract it did not previously have.

So the *separation* happened and the *shelving* did not, which is why this
document's conclusions read as wrong rather than merely old.

## Why this stub exists rather than a deletion

The original 72 lines argued a question that is settled and described a plan that
was abandoned, so keeping them invites someone to re-propose two boilerplate
repos. But `SPEC.md`, `README.md`, `PRD.md`, `PROVENANCE.md`, `VERIFICATION.md`
and `running-the-app-on-hill90-infra.md` all cite this path, and deleting the file
would break every one of those links while erasing the record that the option was
considered at all.

The live successors are:

- **[running-the-app-on-hill90-infra.md](running-the-app-on-hill90-infra.md)** —
  what was actually built
- **Hill90's `app-tenancy-on-the-vps.md`** — the contract the platform offers a
  tenant

The one durable technical note worth not losing: **kubeadm v1.35 with containerd
and Calico was confirmed working on AlmaLinux 10 / Rocky 10.1.** No Kubernetes
work followed, so it has not been revisited since 2026-07-11.
