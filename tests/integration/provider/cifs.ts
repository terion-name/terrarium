import type { IntegrationConfig } from "../types";
import { IntegrationLogger } from "../lib/logger";

/** Static CIFS fixture settings used by the shared-storage scenarios. */
export class CifsProvider {
  readonly address: string;
  readonly username: string;
  readonly password: string;
  readonly hostPathBase: string;
  readonly logger: IntegrationLogger;

  constructor(config: IntegrationConfig, logger: IntegrationLogger) {
    this.address = config.cifsAddress;
    this.username = config.cifsUsername;
    this.password = config.cifsPassword;
    this.hostPathBase = config.cifsHostPathBase.replace(/^\/+/, "").replace(/\/+$/, "");
    this.logger = logger;
  }

  runPath(slug: string): string {
    return `${this.hostPathBase}/${slug}`;
  }
}
