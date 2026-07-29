# Local Development Setup

Guide for setting up hill90-app for local development.

[`README.md`](../../README.md#running-locally) is the fuller reference — the
command table, the full port list, and what needs a real credential. This page
covers per-service development on top of it.

## Prerequisites

- Docker Desktop
- Node.js 20+
- Python 3.12+
- Poetry

## Quick Start

### 1. Clone Repository

```bash
git clone <repository-url>
cd hill90-app
```

### 2. Start Development Environment

```bash
./scripts/local.sh up
```

That generates `.env.local` and two Ed25519 keypairs on first run, builds the
images, starts the stack, and waits for health. `./scripts/local.sh status`,
`logs`, `down` and `reset` are the other verbs.

### 3. Access Services

Ports sit in a 13000/18000 band to avoid colliding with anything already bound
on 3000, 5432 or 8080:

- UI: http://localhost:13000
- API: http://localhost:13001/health
- AI (model router): http://localhost:18000/health
- MCP gateway: http://localhost:18001/health
- Knowledge (AKM): http://localhost:18002/health
- Keycloak: http://localhost:18080
- MinIO console: http://localhost:19001
- PostgreSQL: localhost:15432

## Service Development

### API Service (TypeScript)

```bash
cd services/api
npm install
npm run dev
```

### AI Service (Python)

```bash
cd services/ai
poetry install
poetry run uvicorn app.main:app --reload
```

### Keycloak (Identity Provider)

Keycloak runs as a Docker container — no local build needed, and it comes up as
part of `./scripts/local.sh up`. The local realm import seeds a development
account; production's does not, which is a deliberate gap recorded in
[`RESURRECTION.md`](../../RESURRECTION.md) §10.

Admin console: http://localhost:18080/admin/master/console/

## Testing

Per service, matching what CI runs:

```bash
cd services/api && npm test          # also services/ui
cd services/ai  && poetry run pytest # also services/knowledge, services/mcp
```

## Code Quality

```bash
cd services/api && npm run lint && npm run format   # api
cd services/ui  && npm run lint                     # ui has no format script
cd services/ai  && poetry run ruff check . && poetry run black .
```

## Troubleshooting

### Port Already in Use

`./scripts/local.sh up` checks the ports before starting anything and, on a
clash, names the port, the `PORT_*` variable to change in `.env.local`, and the
container holding it.

### Database Connection Failed

Check the container is up:

```bash
./scripts/local.sh status
docker ps | grep app-postgres
```
