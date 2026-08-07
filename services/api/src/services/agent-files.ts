import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const CONFIG_BASE = process.env.AGENTBOX_CONFIG_LOCAL_PATH || '/data/agentbox';

interface AgentRow {
  agent_id: string;
  name: string;
  description: string;
  tools_config: Record<string, unknown>;
  cpus: string;
  mem_limit: string;
  pids_limit: number;
  soul_md: string;
  rules_md: string;
}

// app#619: this write happens inside the API container's own mount namespace
// (CONFIG_BASE, a Docker-managed volume) and has no visibility into whether the
// HOST path a NEW agent container will bind-mount (AGENTBOX_CONFIG_HOST_PATH,
// consumed later by docker.ts) actually resolves to the same underlying
// storage. Left unguarded, that mismatch let this write report success while
// the real failure surfaced two layers away, inside the freshly-started agent
// container, as `FileNotFoundError: agent.yml` — disconnected from its cause.
// These checks catch the two failure modes that ARE visible from here, before
// a single byte is written:
function assertAgentFilesAreReachable(): void {
  if (!process.env.AGENTBOX_CONFIG_HOST_PATH) {
    throw new Error(
      'AGENTBOX_CONFIG_HOST_PATH is not set — refusing to write agent files. ' +
        'Without it, no new agent container has anything to bind-mount from what ' +
        'this write is about to produce, and that would otherwise only surface ' +
        'later as a failure inside the agent container itself.'
    );
  }

  // Guard against CONFIG_BASE silently NOT being the mounted volume it is
  // meant to be (e.g. a compose misconfiguration, or the mount failing to
  // attach) — writes would still "succeed", landing on this container's own
  // ephemeral layer instead of the storage a new agent container reads from.
  let baseDev: number;
  let parentDev: number;
  try {
    baseDev = fs.statSync(CONFIG_BASE).dev;
    parentDev = fs.statSync(path.dirname(CONFIG_BASE)).dev;
  } catch (err) {
    throw new Error(`Cannot stat ${CONFIG_BASE} (AGENTBOX_CONFIG_LOCAL_PATH) — refusing to write agent files: ${err}`);
  }
  if (baseDev === parentDev) {
    throw new Error(
      `${CONFIG_BASE} (AGENTBOX_CONFIG_LOCAL_PATH) is not a mounted volume — it shares a filesystem ` +
        `with its own parent directory. A write here would succeed but be invisible to anything ` +
        'outside this container, including the host path a new agent container bind-mounts from.'
    );
  }
}

export function writeAgentFiles(agent: AgentRow, skillInstructions?: string): string {
  assertAgentFilesAreReachable();

  const dir = path.join(CONFIG_BASE, agent.agent_id);
  fs.mkdirSync(dir, { recursive: true });

  // Write agent.yml
  const config = {
    version: 1,
    id: agent.agent_id,
    name: agent.name,
    description: agent.description,
    soul_path: 'SOUL.md',
    rules_path: 'RULES.md',
    tools: agent.tools_config,
    tool_loop: {
      max_iterations: 15,
      iteration_timeout: 600,
    },
    resources: {
      cpus: agent.cpus,
      mem_limit: agent.mem_limit,
      pids_limit: agent.pids_limit,
    },
    state: {
      workspace: '/workspace',
      logs: '/var/log/agentbox',
      data: '/data',
    },
  };
  fs.writeFileSync(path.join(dir, 'agent.yml'), yaml.dump(config), 'utf-8');

  // Write identity files
  fs.writeFileSync(path.join(dir, 'SOUL.md'), agent.soul_md, 'utf-8');

  // Merge skill instructions into RULES.md (fresh-at-start, not resolve-on-save)
  let rulesContent = agent.rules_md;
  if (skillInstructions) {
    rulesContent = rulesContent
      ? `${rulesContent}\n\n---\n\n## Skill Instructions\n\n${skillInstructions}`
      : `## Skill Instructions\n\n${skillInstructions}`;
  }
  fs.writeFileSync(path.join(dir, 'RULES.md'), rulesContent, 'utf-8');

  return dir;
}

export function removeAgentFiles(agentId: string): void {
  const dir = path.join(CONFIG_BASE, agentId);
  fs.rmSync(dir, { recursive: true, force: true });
}
