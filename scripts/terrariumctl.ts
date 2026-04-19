import { cac } from "cac";
import chalk from "chalk";
import { registerInstallCommand } from "./terrarium-install";
import { proxySyncCmd as syncProxyConfig } from "./terrarium-traefik-sync";
import { idpSyncCmd as syncIdpConfig } from "./terrarium-zitadel-sync";
import { TERRARIUM_VERSION } from "./generated/build-info";
import { backupActionCmd } from "./ctl/backup";
import { normalizedArgv, parseBooleanOption, PREFIX } from "./ctl/context";
import {
  parseSetCommandOptions,
  setDomainsCmd,
  setEmailsCmd,
  setIdpCmd,
  setS3Cmd,
  setSyncoidCmd
} from "./ctl/config";
import { mountAddCmd, mountListCmd, mountRemoveCmd } from "./ctl/mount";
import { statusCmd } from "./ctl/status";
import { reconfigureCmd } from "./ctl/system";

/**
 * Prompts before destructive operations that alter persisted or mounted state.
 *
 * Keeping the prompt here allows command modules to stay focused on their
 * domain logic while the CLI shell owns the human interaction policy.
 */
async function confirmDestructive(message: string): Promise<void> {
  const { confirm } = await import("@inquirer/prompts");
  const approved = await confirm({ message, default: false });
  if (!approved) {
    throw new Error("operation cancelled");
  }
}

/** Shared callback bundle used by all `set ...` commands after config changes. */
const reconcileActions = {
  reconfigure: reconfigureCmd,
  syncProxy: syncProxyConfig,
  syncIdp: syncIdpConfig
};

/** Main CLI definition for the compiled Terrarium binary. */
const cli = cac("terrariumctl");
cli.version(TERRARIUM_VERSION);

registerInstallCommand(cli);

cli.command("status", "Show Terrarium service and endpoint status").action(async () => {
  await statusCmd();
});

cli
  .command("backup <action>", "Backup operations: list, export, restore")
  .option("--source <source>", "Restore source: local or s3")
  .option("--instance <name>", "Instance name")
  .option("--at <snapshotOrTimestamp>", "Snapshot name fragment or timestamp")
  .option("--as-new <name>", "Restore as a new instance")
  .usage("backup list | backup export | backup restore [--source local|s3] --instance NAME [--at SNAPSHOT|TIMESTAMP] [--as-new NEWNAME]")
  .action(async (action, options) => {
    await backupActionCmd(action, {
      source: options.source as string | undefined,
      instance: options.instance as string | undefined,
      at: options.at as string | undefined,
      asNew: options.asNew as string | undefined
    });
  });

cli.command("reconfigure", "Re-run the Ansible reconciliation with the installed binary").action(async () => {
  await reconfigureCmd();
});

cli
  .command("proxy <action>", "Proxy operations")
  .usage("proxy sync")
  .action(async (action) => {
    if (action !== "sync") {
      throw new Error(`unsupported proxy action: ${action}`);
    }
    await syncProxyConfig();
  });

cli
  .command("mount <action> [...args]", "Manage host SMB/CIFS mounts")
  .option("-p, --password <password>", "SMB/CIFS password for non-interactive automation")
  .option("--uid <uid>", "UID to present for mounted files", { default: "0" })
  .option("--gid <gid>", "GID to present for mounted files", { default: "0" })
  .option("--file-mode <mode>", "File mode for mounted files", { default: "0660" })
  .option("--dir-mode <mode>", "Directory mode for mounted directories", { default: "0770" })
  .option("--seal <value>", "Enable SMB encryption: true or false", { default: "true" })
  .usage(
    "mount add smb|cifs /host/path //server/share username [-p PASSWORD] [--seal true|false]\n  terrariumctl mount remove /host/path\n  terrariumctl mount list"
  )
  .action(async (action, args, options) => {
    const normalizedAction = action.trim().toLowerCase();
    const commandArgs = (args as string[]) ?? [];
    const rawOptions = options as Record<string, unknown>;

    if (normalizedAction === "add") {
      const [protocol, hostPath, address, username] = commandArgs;
      if (!protocol || !hostPath || !address || !username) {
        throw new Error("mount add requires: <protocol> <hostPath> <address> <username>");
      }
      await mountAddCmd(protocol, hostPath, address, username, rawOptions.password as string | undefined, {
        uid: rawOptions.uid as string | undefined,
        gid: rawOptions.gid as string | undefined,
        fileMode: rawOptions.fileMode as string | undefined,
        dirMode: rawOptions.dirMode as string | undefined,
        seal: parseBooleanOption(rawOptions.seal as string | undefined, "--seal", true)
      });
      return;
    }

    if (normalizedAction === "remove") {
      const [hostPath] = commandArgs;
      if (!hostPath) {
        throw new Error("mount remove requires: <hostPath>");
      }
      await mountRemoveCmd(hostPath, confirmDestructive);
      return;
    }

    if (normalizedAction === "list") {
      await mountListCmd();
      return;
    }

    throw new Error(`unsupported mount action: ${action}`);
  });

cli
  .command("idp <action>", "Identity provider operations")
  .usage("idp sync")
  .action(async (action) => {
    if (action !== "sync") {
      throw new Error(`unsupported idp action: ${action}`);
    }
    await syncIdpConfig();
  });

cli
  .command("set <section> [value]", "Update persisted Terrarium configuration")
  .option("--manage-domain <domain>", "Override the Cockpit domain")
  .option("--proxy-domain <domain>", "Override the Traefik dashboard domain")
  .option("--lxd-domain <domain>", "Override the LXD domain")
  .option("--auth-domain <domain>", "Override the ZITADEL domain")
  .option("--email <email>", "Terrarium contact/admin email")
  .option("--acme-email <email>", "ACME account email")
  .option("--zitadel-admin-email <email>", "ZITADEL bootstrap admin email")
  .option("--admin-group <group>", "Management admin group")
  .option("--oidc <issuer>", "External OIDC issuer URL")
  .option("--oidc-client <clientId>", "External OIDC client ID")
  .option("--oidc-secret <clientSecret>", "External OIDC client secret")
  .option("--s3-endpoint <url>", "S3 endpoint URL")
  .option("--s3-bucket <name>", "S3 bucket name")
  .option("--s3-region <name>", "S3 region")
  .option("--s3-prefix <prefix>", "S3 object prefix")
  .option("--s3-access-key <key>", "S3 access key")
  .option("--s3-secret-key <secret>", "S3 secret key")
  .option("--syncoid-target <host>", "Remote syncoid SSH target")
  .option("--syncoid-target-dataset <dataset>", "Remote syncoid dataset")
  .option("--syncoid-ssh-key <path>", "SSH key path for syncoid")
  .option("--enable", "Enable the selected integration")
  .option("--disable", "Disable the selected integration")
  .usage("set domains [rootDomain] | set emails | set idp local|oidc | set s3 | set syncoid")
  .action(async (section, value, options) => {
    const rawOptions = options as Record<string, unknown>;
    const parsed = parseSetCommandOptions(rawOptions);

    if (section === "domains") {
      await setDomainsCmd((value as string | undefined) || "", parsed.domains, reconcileActions, confirmDestructive);
      return;
    }
    if (section === "emails") {
      await setEmailsCmd(parsed.emails, reconcileActions);
      return;
    }
    if (section === "idp") {
      await setIdpCmd({ mode: value as string, ...parsed.idp }, reconcileActions);
      return;
    }
    if (section === "s3") {
      await setS3Cmd(parsed.s3, reconcileActions);
      return;
    }
    if (section === "syncoid") {
      await setSyncoidCmd(parsed.syncoid, reconcileActions);
      return;
    }

    throw new Error(`unsupported set section: ${section}`);
  });

cli.help();

try {
  cli.parse(normalizedArgv(process.argv), { run: false });
  await cli.runMatchedCommand();
} catch (error) {
  console.error(chalk.red(`${PREFIX}: ${String(error).replace(/^Error: /, "")}`));
  process.exit(1);
}
