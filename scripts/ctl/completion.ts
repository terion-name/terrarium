export type CompletionShell = "bash" | "zsh" | "fish";

const commands = [
  "install",
  "status",
  "backup",
  "reconfigure",
  "update",
  "exec",
  "config",
  "cluster",
  "proxy",
  "mount",
  "idp",
  "set",
  "completion"
];

const actions: Record<string, string[]> = {
  backup: ["list", "export", "restore"],
  config: ["import", "export"],
  cluster: ["status", "init", "invite", "token", "join", "evacuate", "restore", "move", "remove", "ovn"],
  proxy: ["sync"],
  mount: ["add", "attach", "remove", "list"],
  idp: ["sync", "status", "logs", "backup", "restore"],
  set: ["domains", "emails", "idp", "s3", "syncoid"],
  completion: ["bash", "zsh", "fish"]
};

const optionGroups: Record<string, string[]> = {
  install: [
    "--non-interactive",
    "--yes",
    "--ref",
    "--email",
    "--acme-email",
    "--domain",
    "--manage-domain",
    "--proxy-domain",
    "--lxd-domain",
    "--idp",
    "--admin-group",
    "--oidc",
    "--oidc-client",
    "--oidc-secret",
    "--oidc-secret-file",
    "--lxd-oidc-client",
    "--lxd-oidc-secret",
    "--lxd-oidc-secret-file",
    "--auth-domain",
    "--zitadel-admin-email",
    "--generate-root-pwd",
    "--root-pwd-file",
    "--storage-mode",
    "--storage-source",
    "--storage-size",
    "--enable-s3",
    "--s3-endpoint",
    "--s3-bucket",
    "--s3-region",
    "--s3-prefix",
    "--s3-access-key",
    "--s3-secret-key",
    "--s3-secret-key-file",
    "--enable-syncoid",
    "--syncoid-target",
    "--syncoid-target-dataset",
    "--syncoid-ssh-key"
  ],
  backup: ["--source", "--instance", "--at", "--as-new"],
  update: ["--ref", "--skip-reconfigure", "--non-interactive"],
  exec: ["--root", "--user"],
  cluster: [
    "--member",
    "--address",
    "--token",
    "--storage-pool",
    "--network",
    "--parent",
    "--central-addresses",
    "--peer-cidr",
    "--wireguard",
    "--wireguard-cidr",
    "--wireguard-port",
    "--wireguard-endpoint",
    "--expires-at",
    "--target",
    "--move",
    "--force",
    "--yes",
    "--skip-export",
    "--skip-reconfigure"
  ],
  mount: [
    "-p",
    "--password",
    "--password-file",
    "--uid",
    "--gid",
    "--file-mode",
    "--dir-mode",
    "--seal",
    "--container",
    "--instance",
    "--container-path",
    "--device"
  ],
  idp: ["--source", "--at", "--as-new", "--lines"],
  set: [
    "--manage-domain",
    "--proxy-domain",
    "--lxd-domain",
    "--auth-domain",
    "--email",
    "--acme-email",
    "--zitadel-admin-email",
    "--admin-group",
    "--oidc",
    "--oidc-client",
    "--oidc-secret",
    "--oidc-secret-file",
    "--lxd-oidc-client",
    "--lxd-oidc-secret",
    "--lxd-oidc-secret-file",
    "--s3-endpoint",
    "--s3-bucket",
    "--s3-region",
    "--s3-prefix",
    "--s3-access-key",
    "--s3-secret-key",
    "--s3-secret-key-file",
    "--syncoid-target",
    "--syncoid-target-dataset",
    "--syncoid-ssh-key",
    "--enable",
    "--disable"
  ]
};

export function commandCompletionCandidates(prefix: string): string[] {
  return commands.filter((command) => command.startsWith(prefix));
}

function words(values: string[]): string {
  return values.join(" ");
}

export function completionScript(shell: CompletionShell): string {
  if (shell === "bash") {
    return bashCompletion();
  }
  if (shell === "zsh") {
    return zshCompletion();
  }
  return fishCompletion();
}

function bashCompletion(): string {
  return `# terrariumctl bash completion
_terrariumctl_complete() {
  local cur command
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  command="\${COMP_WORDS[1]}"

  if [[ "\${cur}" == -* ]]; then
    case "\${command}" in
      install) COMPREPLY=( $(compgen -W "${words(optionGroups.install)} --help" -- "\${cur}") ) ;;
      backup) COMPREPLY=( $(compgen -W "${words(optionGroups.backup)} --help" -- "\${cur}") ) ;;
      update) COMPREPLY=( $(compgen -W "${words(optionGroups.update)} --help" -- "\${cur}") ) ;;
      exec) COMPREPLY=( $(compgen -W "${words(optionGroups.exec)} --help" -- "\${cur}") ) ;;
      cluster) COMPREPLY=( $(compgen -W "${words(optionGroups.cluster)} --help" -- "\${cur}") ) ;;
      mount) COMPREPLY=( $(compgen -W "${words(optionGroups.mount)} --help" -- "\${cur}") ) ;;
      idp) COMPREPLY=( $(compgen -W "${words(optionGroups.idp)} --help" -- "\${cur}") ) ;;
      set) COMPREPLY=( $(compgen -W "${words(optionGroups.set)} --help" -- "\${cur}") ) ;;
      *) COMPREPLY=( $(compgen -W "--help --version" -- "\${cur}") ) ;;
    esac
    return 0
  fi

  case "\${COMP_CWORD}" in
    1)
      COMPREPLY=( $(compgen -W "${words(commands)}" -- "\${cur}") )
      ;;
    2)
      case "\${command}" in
        backup) COMPREPLY=( $(compgen -W "${words(actions.backup)}" -- "\${cur}") ) ;;
        config) COMPREPLY=( $(compgen -W "${words(actions.config)}" -- "\${cur}") ) ;;
        cluster) COMPREPLY=( $(compgen -W "${words(actions.cluster)}" -- "\${cur}") ) ;;
        proxy) COMPREPLY=( $(compgen -W "${words(actions.proxy)}" -- "\${cur}") ) ;;
        mount) COMPREPLY=( $(compgen -W "${words(actions.mount)}" -- "\${cur}") ) ;;
        idp) COMPREPLY=( $(compgen -W "${words(actions.idp)}" -- "\${cur}") ) ;;
        set) COMPREPLY=( $(compgen -W "${words(actions.set)}" -- "\${cur}") ) ;;
        completion) COMPREPLY=( $(compgen -W "${words(actions.completion)}" -- "\${cur}") ) ;;
      esac
      ;;
    3)
      if [[ "\${command}" == "set" && "\${COMP_WORDS[2]}" == "idp" ]]; then
        COMPREPLY=( $(compgen -W "local oidc" -- "\${cur}") )
      elif [[ "\${command}" == "mount" && "\${COMP_WORDS[2]}" == "add" ]]; then
        COMPREPLY=( $(compgen -W "smb cifs" -- "\${cur}") )
      elif [[ "\${command}" == "cluster" && "\${COMP_WORDS[2]}" == "ovn" ]]; then
        COMPREPLY=( $(compgen -W "configure" -- "\${cur}") )
      fi
      ;;
  esac
}

complete -F _terrariumctl_complete terrariumctl
complete -F _terrariumctl_complete trm
`;
}

function zshCompletion(): string {
  return `#compdef terrariumctl trm

_terrariumctl() {
  local -a commands actions opts
  commands=(${words(commands)})

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  case "$words[2]" in
    backup) actions=(${words(actions.backup)}); opts=(${words(optionGroups.backup)}) ;;
    config) actions=(${words(actions.config)}) ;;
    cluster) actions=(${words(actions.cluster)}); opts=(${words(optionGroups.cluster)}) ;;
    proxy) actions=(${words(actions.proxy)}) ;;
    mount) actions=(${words(actions.mount)}); opts=(${words(optionGroups.mount)}) ;;
    idp) actions=(${words(actions.idp)}); opts=(${words(optionGroups.idp)}) ;;
    set) actions=(${words(actions.set)}); opts=(${words(optionGroups.set)}) ;;
    completion) actions=(${words(actions.completion)}) ;;
    install) opts=(${words(optionGroups.install)}) ;;
    update) opts=(${words(optionGroups.update)}) ;;
    exec) opts=(${words(optionGroups.exec)}) ;;
  esac

  if [[ "$PREFIX" == -* ]]; then
    _describe 'option' opts
    return
  fi

  if (( CURRENT == 3 )); then
    _describe 'action' actions
    return
  fi

  if [[ "$words[2]" == "set" && "$words[3]" == "idp" ]]; then
    compadd local oidc
  elif [[ "$words[2]" == "mount" && "$words[3]" == "add" ]]; then
    compadd smb cifs
  elif [[ "$words[2]" == "cluster" && "$words[3]" == "ovn" ]]; then
    compadd configure
  fi
}

_terrariumctl "$@"
`;
}

function fishCompletion(): string {
  const lines = ["# terrariumctl fish completion"];
  for (const command of ["terrariumctl", "trm"]) {
    lines.push(`complete -c ${command} -f -n "__fish_use_subcommand" -a "${words(commands)}"`);
    for (const [rootCommand, rootActions] of Object.entries(actions)) {
      lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from ${rootCommand}" -a "${words(rootActions)}"`);
    }
    for (const [rootCommand, options] of Object.entries(optionGroups)) {
      for (const option of options) {
        if (option.startsWith("--")) {
          lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from ${rootCommand}" -l ${option.replace(/^--/, "")}`);
        } else if (option.startsWith("-")) {
          lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from ${rootCommand}" -s ${option.replace(/^-/, "")}`);
        }
      }
    }
    lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from set; and __fish_seen_subcommand_from idp" -a "local oidc"`);
    lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from mount; and __fish_seen_subcommand_from add" -a "smb cifs"`);
    lines.push(`complete -c ${command} -f -n "__fish_seen_subcommand_from cluster; and __fish_seen_subcommand_from ovn" -a "configure"`);
  }
  return `${lines.join("\n")}\n`;
}
