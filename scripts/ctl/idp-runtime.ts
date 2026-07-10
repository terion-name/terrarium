import { configString } from "../lib/common";
import { effectiveIdpProvider, idpMode, type MutableConfig } from "./context";

export type LocalIdpRuntimeDescriptor = {
  provider: "zitadel" | "logto";
  label: "ZITADEL" | "Logto";
  instanceConfigKey: string;
  instanceName: string;
  composeProject: string;
  composePath: string;
  serviceName: string;
  bootstrapPasswordCommand?: string;
};

const DEFAULT_IDP_INSTANCE = "terrarium-idp";

export function localIdpRuntimeDescriptor(config: MutableConfig): LocalIdpRuntimeDescriptor | null {
  if (idpMode(config) !== "local") {
    return null;
  }

  const provider = effectiveIdpProvider(config);
  if (provider === "zitadel") {
    const instanceName = configString(config, "terrarium_zitadel_instance_name", DEFAULT_IDP_INSTANCE);
    return {
      provider,
      label: "ZITADEL",
      instanceConfigKey: "terrarium_zitadel_instance_name",
      instanceName,
      composeProject: "terrarium-zitadel",
      composePath: "/var/lib/terrarium/zitadel/docker-compose.yml",
      serviceName: "terrarium-zitadel.service",
      bootstrapPasswordCommand: `lxc exec ${instanceName} -- cat /etc/terrarium/secrets/zitadel_admin_password`
    };
  }

  if (provider === "logto") {
    const instanceName = configString(config, "terrarium_logto_instance_name", DEFAULT_IDP_INSTANCE);
    return {
      provider,
      label: "Logto",
      instanceConfigKey: "terrarium_logto_instance_name",
      instanceName,
      composeProject: "terrarium-logto",
      composePath: "/var/lib/terrarium/logto/docker-compose.yml",
      serviceName: "terrarium-logto.service",
      bootstrapPasswordCommand: `lxc exec ${instanceName} -- cat /etc/terrarium/secrets/logto_admin_password`
    };
  }

  return null;
}

export function unmanagedLocalIdpRuntimeMessage(): string {
  return "Terrarium does not manage a local IDP runtime for this IDP mode/provider.";
}

export function localIdpInfoCommand(runtime: LocalIdpRuntimeDescriptor): string[] {
  return ["lxc", "info", runtime.instanceName];
}

export function localIdpComposePsCommand(runtime: LocalIdpRuntimeDescriptor): string[] {
  return [
    "lxc",
    "exec",
    runtime.instanceName,
    "--",
    "docker",
    "compose",
    "--project-name",
    runtime.composeProject,
    "-f",
    runtime.composePath,
    "ps"
  ];
}

export function localIdpComposeLogsCommand(runtime: LocalIdpRuntimeDescriptor, lines: string): string[] {
  return [
    "lxc",
    "exec",
    runtime.instanceName,
    "--",
    "docker",
    "compose",
    "--project-name",
    runtime.composeProject,
    "-f",
    runtime.composePath,
    "logs",
    "--tail",
    lines
  ];
}

export function localIdpServiceStatusCommand(runtime: LocalIdpRuntimeDescriptor): string[] {
  return ["lxc", "exec", runtime.instanceName, "--", "systemctl", "is-active", runtime.serviceName];
}
