/** Offline only: no SDK, credential, login, queue or provider operation. */
import { initializeRecoveryPolicy } from "./recovery-policy.ts";

const args = process.argv.slice(2).filter(arg => arg !== "--");
if (args.length !== 3 || args[0] !== "--event-cutover-utc" || args[2] !== "--suppress-onboarding") {
  console.error("Usage: bun run recovery-init -- --event-cutover-utc <explicit-UTC-time> --suppress-onboarding");
  process.exitCode = 1;
} else {
  try {
    const policy = await initializeRecoveryPolicy(args[1]!, true);
    console.log(JSON.stringify({ event: "recovery_policy_initialized", ...policy }));
  } catch {
    console.error("Recovery initialization refused: use a fresh private data directory and a valid explicit UTC cutoff; an existing policy cannot be reset");
    process.exitCode = 1;
  }
}
