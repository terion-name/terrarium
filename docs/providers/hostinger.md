# Terrarium on Hostinger

> [!WARNING]
> We do not recommend Hostinger for the primary Terrarium use case.
> Terrarium works best with a separate block volume for the ZFS pool, snapshots, and the local time-machine history. Hostinger's VPS docs do not document attachable block-volume support, so you are usually forced into `--storage-mode file` on the root disk. That works, but it is a compromise rather than the preferred setup.

Official references:

- [How to Use the VPS Dashboard in Hostinger](https://www.hostinger.com/support/5726606-how-to-use-the-vps-dashboard-in-hostinger/)
- [How to Use SSH Keys at Hostinger VPS](https://www.hostinger.com/support/4792364-how-to-use-ssh-keys-at-hostinger-vps/)
- [Available Operating Systems for VPS at Hostinger](https://www.hostinger.com/support/1583571-how-to-use-the-available-operating-systems-for-vps-at-hostinger/)
- [Parameters and Limits of Hosting Plans in Hostinger](https://www.hostinger.com/support/6976044-parameters-and-limits-of-hosting-plans-in-hostinger/)
- [How to Increase VPS Partition Size at Hostinger](https://www.hostinger.com/support/8899490-how-to-increase-vps-partition-size-at-hostinger/)
- [How to Use Hostinger API CLI](https://www.hostinger.com/support/11679133-how-to-use-hostinger-api-cli/)
- [Getting Started With the Hostinger Terraform Provider](https://www.hostinger.com/support/11080294-getting-started-with-the-hostinger-terraform-provider/)

## Important limitation

Hostinger’s official VPS docs do not document independently attachable block storage volumes for VPS instances.

What the official docs do document:

- fixed disk capacity as part of the VPS plan
- plan upgrades when you need more disk
- expanding the existing partition after a plan upgrade

Because of that, Hostinger is not the ideal provider for Terrarium’s recommended `disk` mode. The clean Hostinger path is usually:

- choose a larger VPS plan up front
- use plain Ubuntu 24.04
- install Terrarium with `--storage-mode file`

## Console flow

1. Create a VPS in hPanel.
2. Choose a plain Ubuntu 24.04 template.
3. Add your SSH key during onboarding, or later in `VPS -> Manage -> Settings -> SSH keys`.
4. SSH into the VPS.
5. Install Terrarium in `file` mode.

Example install:

```bash
curl -fsSL https://github.com/terion-name/terrarium/releases/latest/download/install.sh | bash -s -- \
  --email admin@your-domain.tld \
  --acme-email certs@your-domain.tld \
  --idp local \
  --storage-mode file \
  --storage-size 150G
```

If you later upgrade the VPS plan for more disk, Hostinger documents expanding the existing partition after the resize.

## CLI note

Hostinger does publish an official CLI, `hapi`, and an official API. Their current support docs cover:

- installing the CLI
- authenticating with an API token
- common VM operations such as `list`, `get`, `start`, and `stop`

Documented commands:

```bash
hapi --help
hapi vps vm list
hapi vps vm get <vm_id>
hapi vps vm start <vm_id>
hapi vps vm stop <vm_id>
```

The current official support article does not document end-to-end VPS creation through `hapi`, so for Terrarium provisioning the most reliable documented path is still hPanel plus SSH.
