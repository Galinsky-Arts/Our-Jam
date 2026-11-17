// Credentials for the opt-in external acceptance scripts (Stripe TEST mode,
// Google OAuth initiation). They come ONLY from CI/workflow secrets or the
// caller's environment and are never logged. When they are absent the scripts
// report SKIPPED and exit 0: nothing external is faked.
export function stripeSandboxCredentials(env = process.env) {
  const secretKey = env.STRIPE_TEST_SECRET_KEY ?? "";
  const webhookSecret = env.STRIPE_TEST_WEBHOOK_SECRET ?? "";
  if (!secretKey) return null;
  if (!/^(sk|rk)_test_/.test(secretKey))
    throw Error("Only Stripe sandbox (sk_test_/rk_test_) keys are accepted");
  if (webhookSecret && !webhookSecret.startsWith("whsec_"))
    throw Error("STRIPE_TEST_WEBHOOK_SECRET must be a whsec_ signing secret");
  return { STRIPE_SECRET_KEY: secretKey, STRIPE_WEBHOOK_SECRET: webhookSecret };
}
export function oauthAcceptanceTarget(env = process.env) {
  const origin = env.OUR_JAM_ORIGIN ?? "";
  const auth = env.NEON_AUTH_BASE_URL ?? "";
  if (!origin || !auth) return null;
  for (const value of [origin, auth])
    if (!/^https:\/\//.test(value)) throw Error("Acceptance URLs must be HTTPS");
  return { origin: new URL(origin).origin, auth: auth.replace(/\/$/, "") };
}
export function skipped(reason) {
  console.log("SKIPPED: " + reason);
  process.exit(0);
}
