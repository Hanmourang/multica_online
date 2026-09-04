/** Credentials used by the development auto-login shortcut. */
export interface DevAutoLoginConfig {
  /** Account the fixed development verification code is issued for. */
  email: string;
  /** Verification code accepted by the server in non-production builds. */
  code: string;
}

/**
 * Raw values resolved by the host app. `packages/core` must not read
 * environment variables, so web (Next.js `process.env`) and desktop (Vite
 * `import.meta.env`) parse their own config and hand the result in.
 */
export interface DevAutoLoginEnv {
  enabled?: string | boolean;
  email?: string;
  code?: string;
}

/** Account created by `scripts/dev-env.sh` for local checkouts. */
const DEFAULT_DEV_EMAIL = "dev@localhost";

/** Fixed code served when `MULTICA_DEV_VERIFICATION_CODE` is set locally. */
const DEFAULT_DEV_CODE = "888888";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (!value) return false;
  return ENABLED_VALUES.has(value.trim().toLowerCase());
}

/**
 * Turns host-provided configuration into an auto-login request, or `null`
 * when the shortcut is off. Returning `null` keeps the caller on the normal
 * login flow, so a production build that never sets these values is
 * unaffected.
 */
export function resolveDevAutoLogin(
  env: DevAutoLoginEnv,
): DevAutoLoginConfig | null {
  if (!isEnabled(env.enabled)) return null;
  const email = env.email?.trim();
  const code = env.code?.trim();
  return {
    email: email ? email : DEFAULT_DEV_EMAIL,
    code: code ? code : DEFAULT_DEV_CODE,
  };
}
