import { cac } from "cac";
import chalk from "chalk";
import { registerInstallCommand } from "./terrarium-install";
import { proxySyncCmd as syncProxyConfig } from "./terrarium-traefik-sync";
import { idpSyncCmd as syncIdpConfig } from "./terrarium-zitadel-sync";
import { TERRARIUM_VERSION } from "./generated/build-info";
import { backupActionCmd } from "./ctl/backup";
import { normalizedArgv, parseBooleanOption, PREFIX } from "./ctl/context";
import {
  configExportCmd,
  configImportCmd,
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
  reconfigure: () => reconfigureCmd({ applyHardening: false }),
  syncProxy: syncProxyConfig,
  syncIdp: syncIdpConfig
};

/** Main CLI definition for the compiled Terrarium binary. */
const cli = cac("terrariumctl");
// CAC's string transform runs after numeric coercion; cliOption recovers exact argv values instead.
const STRING_OPTION = {};
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
  .command("config <action>", "Config storage operations")
  .usage("config import | config export")
  .action((action) => {
    if (action === "import") {
      configImportCmd();
      return;
    }
    if (action === "export") {
      configExportCmd();
      return;
    }
    throw new Error(`unsupported config action: ${action}`);
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
  .option("-p, --password <password>", "SMB/CIFS password for non-interactive automation", STRING_OPTION)
  .option("--password-file <path>", "Read SMB/CIFS password from a root-readable file", STRING_OPTION)
  .option("--uid <uid>", "UID to present for mounted files", { ...STRING_OPTION, default: "0" })
  .option("--gid <gid>", "GID to present for mounted files", { ...STRING_OPTION, default: "0" })
  .option("--file-mode <mode>", "File mode for mounted files", { ...STRING_OPTION, default: "0660" })
  .option("--dir-mode <mode>", "Directory mode for mounted directories", { ...STRING_OPTION, default: "0770" })
  .option("--seal <value>", "Enable SMB encryption: true or false", { ...STRING_OPTION, default: "true" })
  .usage(
    "mount add smb|cifs /host/path //server/share username [-p PASSWORD|--password-file PATH] [--seal true|false]\n  terrariumctl mount remove /host/path\n  terrariumctl mount list"
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
        passwordFile: rawOptions.passwordFile as string | undefined,
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
  .command("set <section> [value]", "Update saved Terrarium configuration")
  .option("--manage-domain <domain>", "Override the Cockpit domain", STRING_OPTION)
  .option("--proxy-domain <domain>", "Override the Traefik dashboard domain", STRING_OPTION)
  .option("--lxd-domain <domain>", "Override the LXD domain", STRING_OPTION)
  .option("--auth-domain <domain>", "Override the ZITADEL domain", STRING_OPTION)
  .option("--email <email>", "Terrarium contact/admin email", STRING_OPTION)
  .option("--acme-email <email>", "ACME account email", STRING_OPTION)
  .option("--zitadel-admin-email <email>", "ZITADEL bootstrap admin email", STRING_OPTION)
  .option("--admin-group <group>", "Management admin group", STRING_OPTION)
  .option("--oidc <issuer>", "External OIDC issuer URL", STRING_OPTION)
  .option("--oidc-client <clientId>", "External OIDC client ID", STRING_OPTION)
  .option("--oidc-secret <clientSecret>", "External OIDC client secret", STRING_OPTION)
  .option("--oidc-secret-file <path>", "Read the external OIDC client secret from a root-readable file", STRING_OPTION)
  .option("--lxd-oidc-client <clientId>", "Optional separate external OIDC client ID for LXD", STRING_OPTION)
  .option("--lxd-oidc-secret <clientSecret>", "Optional separate external OIDC client secret for LXD", STRING_OPTION)
  .option("--lxd-oidc-secret-file <path>", "Read the optional LXD OIDC client secret from a root-readable file", STRING_OPTION)
  .option("--s3-endpoint <url>", "S3 endpoint URL", STRING_OPTION)
  .option("--s3-bucket <name>", "S3 bucket name", STRING_OPTION)
  .option("--s3-region <name>", "S3 region", STRING_OPTION)
  .option("--s3-prefix <prefix>", "S3 object prefix", STRING_OPTION)
  .option("--s3-access-key <key>", "S3 access key", STRING_OPTION)
  .option("--s3-secret-key <secret>", "S3 secret key", STRING_OPTION)
  .option("--s3-secret-key-file <path>", "Read the S3 secret key from a root-readable file", STRING_OPTION)
  .option("--syncoid-target <host>", "Remote syncoid SSH target", STRING_OPTION)
  .option("--syncoid-target-dataset <dataset>", "Remote syncoid dataset", STRING_OPTION)
  .option("--syncoid-ssh-key <path>", "SSH key path for syncoid", STRING_OPTION)
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
