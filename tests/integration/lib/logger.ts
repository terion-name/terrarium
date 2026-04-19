import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Small file-backed logger used by the integration harness.
 *
 * Each run gets a plain text transcript that can be uploaded from GitHub Actions
 * or inspected locally when a real-infra failure needs debugging.
 */
export class IntegrationLogger {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  private writeLine(level: string, message: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    appendFileSync(this.path, line, "utf8");
    console.log(line.trimEnd());
  }

  info(message: string): void {
    this.writeLine("INFO", message);
  }

  warn(message: string): void {
    this.writeLine("WARN", message);
  }

  error(message: string): void {
    this.writeLine("ERROR", message);
  }

  child(name: string): IntegrationLogger {
    return new IntegrationLogger(join(dirname(this.path), `${name}.log`));
  }
}
