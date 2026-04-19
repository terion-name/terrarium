import { cac } from "cac";
import { createContext } from "./context";
import type { IntegrationCliOptions, SuiteName } from "./types";
import { runSmokeSuite } from "./scenarios/smoke";
import { runFullSuite } from "./scenarios/full";

/** Main CLI entrypoint for the Terrarium real-infra integration harness. */
const cli = cac("terrarium-integration");

cli
  .option("--suite <suite>", "Suite to run: smoke or full", { default: "smoke" })
  .option("--only <scenario>", "Run only the named scenario", { default: [] })
  .option("--keep-on-failure", "Skip teardown when a scenario fails")
  .option("--reuse-infra", "Reuse previously created infrastructure when supported")
  .option("--release-preflight", "Mark the run as a release-preflight invocation")
  .help();

try {
  const parsed = cli.parse();
  if ((parsed.options as Record<string, unknown>).help) {
    process.exit(0);
  }
  const options = cli.options as unknown as Record<string, unknown>;
  const suite = String(options.suite || "smoke") as SuiteName;
  if (!["smoke", "full"].includes(suite)) {
    throw new Error(`unsupported suite: ${suite}`);
  }

  const normalized: IntegrationCliOptions = {
    suite,
    only: Array.isArray(options.only) ? (options.only as string[]) : options.only ? [String(options.only)] : [],
    keepOnFailure: Boolean(options.keepOnFailure),
    reuseInfra: Boolean(options.reuseInfra),
    releasePreflight: Boolean(options.releasePreflight)
  };

  const context = createContext(normalized);
  await context.buildLinuxBundle();

  try {
    if (suite === "smoke") {
      await context.withScenario("smoke", async () => {
        await runSmokeSuite(context);
      });
    } else {
      await context.withScenario("full", async () => {
        await runFullSuite(context);
      });
    }
  } finally {
    if (!context.config.keepOnFailure) {
      await context.runCleanup();
    } else {
      context.logger.warn("KEEP_ON_FAILURE enabled, leaving infrastructure in place");
    }
  }
} catch (error) {
  console.error(`terrarium-integration: ${String(error).replace(/^Error: /, "")}`);
  process.exit(1);
}
