// Vitest global setup — keep unit tests runnable on hosts without a real
// sandbox backend (Windows/macOS without Docker, CI containers without bwrap).
// Production default remains failIfNoSandbox=true; only the test process opts out.
if (process.env.KC_SANDBOX_FAIL_IF_NO_SANDBOX === undefined) {
  process.env.KC_SANDBOX_FAIL_IF_NO_SANDBOX = 'false';
}
