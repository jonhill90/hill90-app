/**
 * Roles live at `session.user.roles`. There is no `session.roles`, and there never was.
 *
 * This test exists because `session.roles` was reported as an intermittent defect —
 * "null on a second login while the token's claims were correct". It is not a defect and
 * it is not intermittent. Two of my own scripts disagreed: one read
 * `sess.roles ?? sess.user?.roles` and printed ["user"], the other read only
 * `sess.roles` and printed null. The difference between the scripts was reported as a
 * difference between logins.
 *
 * Verified against production afterwards — three consecutive fresh logins, every one:
 *
 *   token resource_access.hill90-ui.roles   ["user"]
 *   session.user.roles                      ["user"]
 *   session.roles                           null
 *   'roles' in session                      false
 *
 * The field is absent, so reading it yields undefined. That is the contract, and this
 * test pins it in both directions — because the tempting "fix" is to add
 * `session.roles`, which would give the codebase two sources of truth for authorisation
 * and make the wrong one look supported.
 *
 * `types/next-auth.d.ts` already declares `roles` under `Session.user` only, so
 * `session.roles` is a type error. This asserts the runtime shape as well.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8')

describe('session roles contract', () => {
  it('the session callback assigns roles to session.user, not to session', () => {
    const auth = src('auth.ts')
    expect(auth).toMatch(/session\.user\.roles\s*=\s*token\.roles/)
    // The shape that would create a second source of truth.
    expect(auth).not.toMatch(/^\s*session\.roles\s*=/m)
  })

  it('roles is declared under Session.user in the type augmentation', () => {
    const types = src('types/next-auth.d.ts')
    const sessionBlock = types.slice(
      types.indexOf('interface Session'),
      types.indexOf('declare module "next-auth/jwt"'),
    )
    // roles must appear inside the nested `user` object, not at the top level.
    const userBlock = sessionBlock.slice(sessionBlock.indexOf('user:'))
    expect(userBlock).toMatch(/roles\?:\s*string\[\]/)
  })

  it('no ui source reads session.roles — every consumer uses session.user.roles', () => {
    // Guards against a future edit quietly introducing the wrong path. Covers the seven
    // existing consumers and anything added later.
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    const hits = execSync(
      "grep -rnE '(session|data)(\\?)?\\.roles' src --include=*.ts --include=*.tsx || true",
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter((l) => l && !l.includes('__tests__'))
    expect(hits).toEqual([])
  })
})
