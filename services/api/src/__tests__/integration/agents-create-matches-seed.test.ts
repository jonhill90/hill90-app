/**
 * app#605-adjacent investigation, not a bug fix: does POST /agents actually produce
 * the row this estate has been treating as a real example of one?
 *
 * THE CLAIM BEING TESTED. Per hill90-app and Hill90 records, the `agents` table's
 * `platform-guide` row was INSERTED BY SQL mirroring the route statement column for
 * column — POST /agents itself has never run. This is the first real exercise of the
 * create path, end to end, against a real Postgres, to establish whether the row the
 * route actually writes matches the row that has been treated as this estate's one
 * concrete example of what a created agent looks like.
 *
 * WHY A REAL POSTGRES, NOT THE MOCKED SUITE. Every other test in this repo mocks
 * `../db/pool` (`jest.mock('../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }))`)
 * and hand-supplies whatever rows the assertions expect — which can prove the route's
 * SQL text is well-formed, but cannot prove what a real Postgres actually returns for
 * defaulted columns, jsonb round-tripping, or COALESCE fallbacks. This file does not
 * mock the pool at all: `getPool()` is the real one, pointed at a throwaway Postgres.
 *
 * HARNESS: no testcontainers dependency exists in this package (checked
 * package.json before writing this), and no docker-compose-driven jest run exists
 * either — checked, not assumed, by searching for any existing real-Postgres test in
 * services/api and finding none (only `boot-migrations-fatal.test.ts`, which points at
 * an UNREACHABLE database on purpose, to test the failure path). What this repo DOES
 * already use for "a real Postgres in CI" is a plain `services: postgres:` block in
 * ci.yml (the `sql-identifiers` and `python` jobs both use `pgvector/pgvector:pg16`) —
 * this test follows that exact convention rather than introducing testcontainers as a
 * second way to get a database.
 *
 * GATED, NOT WIRED INTO THE DEFAULT SUITE. `npm test`'s own `api` CI job has no real
 * Postgres — this file self-skips, loudly, when `API_INTEGRATION_DATABASE_URL` is not
 * set, rather than silently doing nothing (a skip with no visible reason is the exact
 * "cannot determine read as clean" trap this estate keeps finding elsewhere). Run it
 * with a real Postgres reachable at that URL — see the PR description for the
 * one-line docker command used to produce the evidence in it.
 *
 * TOUCHES NOTHING IN PRODUCTION. Every query in this file runs against the throwaway
 * database identified by API_INTEGRATION_DATABASE_URL. The comparison values captured
 * FROM production are hardcoded constants below, read once, read-only, before this
 * file was written — never queried live by this test.
 *
 * IDENTITY: testuser01, never jon or hill90admin, per instruction.
 */
import { Pool } from 'pg';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';

const INTEGRATION_DB_URL = process.env.API_INTEGRATION_DATABASE_URL;

// One real read against production, BEFORE this file existed, read-only
// (`SELECT * FROM agents WHERE agent_id = 'platform-guide'`, over SSH, via
// `docker exec postgres psql`) — recorded here as the comparison baseline,
// not re-queried by this test. Columns this test does not assert on are
// noted below with why, not silently dropped.
const SEEDED_PLATFORM_GUIDE_ROW = {
  agent_id: 'platform-guide',
  name: 'Platform Guide',
  description: 'Answers questions about the Hill90 platform from the shared knowledge base.',
  tools_config: {
    shell: { enabled: false },
    health: { enabled: true },
    filesystem: { enabled: false },
  },
  cpus: '1.0',
  mem_limit: '1g',
  pids_limit: 200,
  soul_md:
    'You are the Platform Guide for Hill90, a single-VPS homelab platform.\n\n' +
    'You answer questions about how the estate is put together: Traefik at the edge, one Keycloak with one realm, Postgres, OpenBao, the LGTM observability stack, and the tenant application that consumes them.\n\n' +
    'Prefer the shared knowledge base over your own recollection. When the knowledge base does not cover something, say so plainly rather than guessing — this estate has been bitten repeatedly by confident answers that were not checked.',
  rules_md:
    'Cite the source you used when you answer from the knowledge base.\n\n' +
    'If you cannot find something, say you could not find it. Do not fill the gap with a plausible answer.\n\n' +
    'Never print a secret value, even one you can see.',
  status: 'stopped',
  autonomy_level: 'act_within_scope',
  // A real UUID for the platform's 'default' model policy, resolved via the
  // route's own COALESCE fallback — this test proves that resolution
  // independently below rather than hardcoding agreement here.
  model_policy_id_resolves_to_default_policy: true,
  // NOT asserted here — see the header note and the describe block below for
  // why: id/created_at/updated_at/created_by are identity/time columns that
  // MUST differ between any two rows by construction, and container_state
  // has no INSERT-time value at all (no column default; the platform-guide
  // row's live 'absent' value reflects reconciliation activity in the ~30
  // hours since it was created, not anything the create path itself wrote).
};

function describeOrSkip(): jest.Describe {
  if (INTEGRATION_DB_URL) return describe;
  // eslint-disable-next-line no-console
  console.warn(
    '[agents-create-matches-seed] SKIPPED: API_INTEGRATION_DATABASE_URL is not set. ' +
      'This is not evidence the create path works — it is evidence this test did not run. ' +
      'See the file header for how to point it at a real Postgres.'
  );
  return describe.skip;
}

describeOrSkip()('POST /agents against a real Postgres — does the created row match the platform-guide seed?', () => {
  let pool: Pool;
  let app: import('express').Application;
  let userToken: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: INTEGRATION_DB_URL });

    const { runMigrations } = await import('../../db/migrate');
    await runMigrations(pool);

    // Idempotent re-run support: this throwaway database may already have
    // a prior run's row in it (this container is not torn down between
    // local re-runs the way CI's ephemeral service container would be).
    // TRUNCATE, not DROP/recreate — migrations already ran above and are
    // slow to redo for no reason.
    await pool.query('TRUNCATE agents CASCADE');

    // The real pool singleton (services/api/src/db/pool.ts) reads
    // DATABASE_URL lazily on first getPool() call — set BEFORE createApp is
    // imported/invoked so every route in this test hits the same database
    // runMigrations just built, not a mock.
    process.env.DATABASE_URL = INTEGRATION_DB_URL;

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const issuer = 'https://auth.hill90.com/realms/platform';
    // testuser01, never jon or hill90admin — per instruction. This is a
    // locally self-signed token (same convention every other test in this
    // suite already uses; none of them contact a real Keycloak), so the
    // `sub` value is this test's own choice of identity, not a claim about
    // testuser01's real Keycloak subject UUID.
    userToken = jwt.sign(
      { sub: 'testuser01', resource_access: { 'hill90-ui': { roles: ['user'] } } },
      privateKey,
      { algorithm: 'RS256', issuer, expiresIn: '1h' }
    );

    const { createApp } = await import('../../app');
    app = createApp({ issuer, getSigningKey: async () => publicKey });
  }, 60000);

  afterAll(async () => {
    await pool.end();
    const { getPool } = await import('../../db/pool');
    await getPool().end();
  });

  it('SANITY: the throwaway database starts with an empty agents table, not a copy of production', async () => {
    const { rows } = await pool.query('SELECT count(*) FROM agents');
    expect(Number(rows[0].count)).toBe(0);
  });

  it('SANITY: migrations seed the "default" model policy the route\'s COALESCE fallback depends on', async () => {
    const { rows } = await pool.query(
      "SELECT id FROM model_policies WHERE name = 'default' AND created_by IS NULL"
    );
    expect(rows).toHaveLength(1);
  });

  describe('creating an agent that mirrors platform-guide\'s own input fields', () => {
    let created: any;

    beforeAll(async () => {
      // Deliberately mirrors the SEEDED row's own content fields
      // (agent_id/name/description/soul_md/rules_md) but sends NO
      // tools_config, cpus, mem_limit, pids_limit or autonomy_level — the
      // question this test asks is what the ROUTE'S OWN DEFAULTS produce
      // for a call that omits them, since that is what "created via the
      // route" would mean for a row that carries no other sign of a
      // non-default create request.
      const res = await request(app)
        .post('/agents')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          agent_id: 'platform-guide',
          name: 'Platform Guide',
          description: SEEDED_PLATFORM_GUIDE_ROW.description,
          soul_md: SEEDED_PLATFORM_GUIDE_ROW.soul_md,
          rules_md: SEEDED_PLATFORM_GUIDE_ROW.rules_md,
        });
      expect(res.status).toBe(201);
      created = res.body;

      // Read the row back directly from Postgres, not from the route's own
      // response body — the response is a RETURNING clause the route
      // wrote by hand and could itself omit or reshape a column; the table
      // is the actual claim under test.
      const { rows } = await pool.query('SELECT * FROM agents WHERE agent_id = $1', ['platform-guide']);
      expect(rows).toHaveLength(1);
      created = rows[0];
    }, 30000);

    it('agent_id, name, description, soul_md, rules_md match exactly — these are pass-through fields', () => {
      expect(created.agent_id).toBe(SEEDED_PLATFORM_GUIDE_ROW.agent_id);
      expect(created.name).toBe(SEEDED_PLATFORM_GUIDE_ROW.name);
      expect(created.description).toBe(SEEDED_PLATFORM_GUIDE_ROW.description);
      expect(created.soul_md).toBe(SEEDED_PLATFORM_GUIDE_ROW.soul_md);
      expect(created.rules_md).toBe(SEEDED_PLATFORM_GUIDE_ROW.rules_md);
    });

    it('cpus, mem_limit, pids_limit match the seeded row — both are the route\'s own defaults', () => {
      expect(created.cpus).toBe(SEEDED_PLATFORM_GUIDE_ROW.cpus);
      expect(created.mem_limit).toBe(SEEDED_PLATFORM_GUIDE_ROW.mem_limit);
      expect(created.pids_limit).toBe(SEEDED_PLATFORM_GUIDE_ROW.pids_limit);
    });

    it('autonomy_level and status match — both are defaults, not caller input', () => {
      expect(created.autonomy_level).toBe(SEEDED_PLATFORM_GUIDE_ROW.autonomy_level);
      expect(created.status).toBe(SEEDED_PLATFORM_GUIDE_ROW.status);
    });

    it('model_policy_id resolves to the real "default" policy via the route\'s own COALESCE, agreeing with the seed', async () => {
      const { rows } = await pool.query(
        "SELECT id FROM model_policies WHERE name = 'default' AND created_by IS NULL"
      );
      expect(created.model_policy_id).toBe(rows[0].id);
    });

    // THE FINDING. resolvedToolsConfig in the route (agents.ts) is
    // `tools_config || DEFAULT_TOOLS_CONFIG` — DEFAULT_TOOLS_CONFIG
    // (services/merge-tools-config.ts) is
    //   { shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
    //     filesystem: { enabled: false, read_only: false, allowed_paths: [...], denied_paths: [] },
    //     health: { enabled: true } }
    // — every sub-key present. The SEEDED row's tools_config
    // ({"shell":{"enabled":false},"health":{"enabled":true},"filesystem":{"enabled":false}})
    // is missing every one of those sub-keys. No call this route can
    // receive produces that exact shape from its OWN default — a caller
    // COULD explicitly submit an incomplete object (the route does not
    // validate tools_config's shape), but the row this estate has treated
    // as "what the create path produces" does not match what the create
    // path's default actually produces, and this test proves that
    // directly rather than by inference from reading the two literals.
    it('THE ASSERTION THAT MATTERS: the route\'s real default tools_config does NOT match the seeded row\'s shape', () => {
      const DEFAULT_TOOLS_CONFIG = {
        shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
        filesystem: { enabled: false, read_only: false, allowed_paths: ['/workspace', '/home/agentuser'], denied_paths: [] },
        health: { enabled: true },
      };
      // The route's own default, verified against what was actually
      // written to Postgres for a create call that supplied no
      // tools_config of its own.
      expect(created.tools_config).toEqual(DEFAULT_TOOLS_CONFIG);
      // The divergence, stated as a positive, passing assertion rather than
      // left to be inferred: what a real create produces and what the
      // seeded row contains are not the same value.
      expect(created.tools_config).not.toEqual(SEEDED_PLATFORM_GUIDE_ROW.tools_config);
      expect(Object.keys(created.tools_config.shell).sort()).not.toEqual(
        Object.keys(SEEDED_PLATFORM_GUIDE_ROW.tools_config.shell).sort()
      );
    });

    it('id, created_at, updated_at, created_by are NOT compared to the seed — identity/time columns that must differ by construction', () => {
      expect(created.id).not.toBe('4997c7ff-b97e-44a7-93e4-ba42392bd2db');
      expect(created.created_by).toBe('testuser01');
    });

    it('container_profile_id defaults to null when omitted — the seeded row carries a real reference, a caller would have had to supply one explicitly', () => {
      // Not asserted as agreement or disagreement with "what the seed
      // means" — this only documents what the route's own default is,
      // since nothing about an omitted container_profile_id proves
      // anything about how the seed was produced.
      expect(created.container_profile_id).toBeNull();
    });
  });
});
