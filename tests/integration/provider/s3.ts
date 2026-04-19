import type { IntegrationConfig } from "../types";
import { IntegrationLogger } from "../lib/logger";
import { run, runAllowFailure } from "../lib/process";

/** Wrapper around AWS CLI prefix-scoped operations used by the real S3 tests. */
export class S3Provider {
  private readonly logger: IntegrationLogger;
  private readonly env: Record<string, string>;
  readonly bucket: string;
  readonly endpoint: string;
  readonly region: string;

  constructor(config: IntegrationConfig, logger: IntegrationLogger) {
    this.logger = logger;
    this.bucket = config.s3Bucket;
    this.endpoint = config.s3Endpoint;
    this.region = config.s3Region;
    this.env = {
      AWS_ACCESS_KEY_ID: config.s3AccessKey,
      AWS_SECRET_ACCESS_KEY: config.s3SecretKey,
      AWS_DEFAULT_REGION: config.s3Region,
      AWS_EC2_METADATA_DISABLED: "true"
    };
  }

  private baseArgs(): string[] {
    return this.endpoint ? ["aws", "--endpoint-url", this.endpoint] : ["aws"];
  }

  async verifyBucket(): Promise<void> {
    this.logger.info(`verify S3 bucket ${this.bucket}`);
    await run([...this.baseArgs(), "s3api", "head-bucket", "--bucket", this.bucket], { env: this.env });
  }

  async clearPrefix(prefix: string): Promise<void> {
    this.logger.info(`clear S3 prefix s3://${this.bucket}/${prefix}`);
    await runAllowFailure([...this.baseArgs(), "s3", "rm", `s3://${this.bucket}/${prefix}`, "--recursive"], { env: this.env });
  }

  async listPrefix(prefix: string): Promise<string> {
    return await run([...this.baseArgs(), "s3", "ls", `s3://${this.bucket}/${prefix}`, "--recursive"], { env: this.env });
  }
}
