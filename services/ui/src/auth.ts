import NextAuth from "next-auth"
import Keycloak from "next-auth/providers/keycloak"
import type { JWT } from "next-auth/jwt"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

/**
 * Base URL for server-to-server calls to Keycloak.
 *
 * Where the browser and this server reach Keycloak on different URLs — a
 * containerised local stack, where the browser uses a published localhost port
 * and this container must use the compose service name — set
 * KEYCLOAK_INTERNAL_ISSUER to the container-reachable one.
 *
 * AUTH_KEYCLOAK_ISSUER stays the browser-facing URL in both cases: it is the
 * `iss` claim Keycloak stamps into tokens, and the API validates against it.
 * Unset, this returns AUTH_KEYCLOAK_ISSUER and behaviour is unchanged.
 */
function internalIssuer(): string {
  return process.env.KEYCLOAK_INTERNAL_ISSUER || requireEnv("AUTH_KEYCLOAK_ISSUER")
}

async function refreshAccessToken(token: JWT): Promise<JWT> {
  const params = new URLSearchParams({
    client_id: requireEnv("AUTH_KEYCLOAK_ID"),
    client_secret: requireEnv("AUTH_KEYCLOAK_SECRET"),
    grant_type: "refresh_token",
    refresh_token: token.refreshToken!,
  })

  const response = await fetch(
    `${internalIssuer()}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }
  )

  if (!response.ok) {
    return {
      ...token,
      accessToken: undefined,
      idToken: undefined,
      refreshToken: undefined,
      accessTokenExpires: undefined,
      error: "RefreshAccessTokenError",
    }
  }

  const refreshed = await response.json()

  return {
    ...token,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? token.refreshToken,
    accessTokenExpires: Date.now() + refreshed.expires_in * 1000,
    error: undefined,
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Keycloak({
      clientId: process.env.AUTH_KEYCLOAK_ID,
      clientSecret: process.env.AUTH_KEYCLOAK_SECRET,
      issuer: process.env.AUTH_KEYCLOAK_ISSUER,
      // With KEYCLOAK_INTERNAL_ISSUER set, pin every endpoint explicitly. That
      // disables OIDC discovery, which would otherwise be fetched from the
      // browser-facing issuer — unreachable from inside a container. The
      // authorization endpoint stays browser-facing; the back-channel ones do
      // not. Without it, these are all undefined and discovery runs as before.
      ...(process.env.KEYCLOAK_INTERNAL_ISSUER
        ? {
            authorization: {
              url: `${process.env.AUTH_KEYCLOAK_ISSUER}/protocol/openid-connect/auth`,
              params: { scope: "openid email profile" },
            },
            token: `${process.env.KEYCLOAK_INTERNAL_ISSUER}/protocol/openid-connect/token`,
            userinfo: `${process.env.KEYCLOAK_INTERNAL_ISSUER}/protocol/openid-connect/userinfo`,
            jwks_endpoint: `${process.env.KEYCLOAK_INTERNAL_ISSUER}/protocol/openid-connect/certs`,
          }
        : {}),
    }),
  ],
  callbacks: {
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname
      const isProtected =
        path.startsWith("/dashboard") ||
        path.startsWith("/profile") ||
        path.startsWith("/settings") ||
        path.startsWith("/agents") ||
        path.startsWith("/docs") ||
        path.startsWith("/admin")
      if (isProtected && !auth) return false
      return true
    },
    async jwt({ token, account }) {
      // Initial sign-in: persist tokens and roles from Keycloak
      if (account) {
        const decoded = account.access_token
          ? JSON.parse(Buffer.from(account.access_token.split(".")[1], "base64url").toString())
          : {}

        return {
          ...token,
          accessToken: account.access_token,
          idToken: account.id_token,
          refreshToken: account.refresh_token,
          accessTokenExpires: account.expires_at ? account.expires_at * 1000 : Date.now() + 300_000,
          // Client roles on hill90-ui, not realm roles: realm roles in the shared
          // platform realm grant Grafana Admin and OpenBao access.
          roles: decoded.resource_access?.[process.env.AUTH_KEYCLOAK_ID || 'hill90-ui']?.roles ?? [],
        }
      }

      // Not expired yet — return as-is
      if (token.accessTokenExpires && Date.now() < token.accessTokenExpires) {
        return token
      }

      // Token expired — attempt refresh
      return refreshAccessToken(token)
    },
    async session({ session, token }) {
      session.error = token.error
      if (token.error === "RefreshAccessTokenError") {
        session.accessToken = undefined
        session.idToken = undefined
      } else {
        session.accessToken = token.accessToken
        session.idToken = token.idToken
      }
      if (session.user) {
        session.user.roles = token.roles
        session.user.sub = token.sub
      }
      return session
    },
  },
})
