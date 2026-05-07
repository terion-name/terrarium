# Operations

Your server is up and running. Now what? 

This section covers all the things you do *after* Terrarium is installed. Whether you want to change your domain name, set up automated S3 backups, or link multiple servers together into a cluster, you'll find the guides here.

- **[Reconfiguration](reconfiguration.md):** How to safely change your domains, emails, and login methods without breaking anything.
- **[Clustering](clustering.md):** How to link multiple Terrarium servers together into a highly available swarm.
- **[Backups and Restore](backups-and-restore.md):** How to use your built-in time machine and off-site S3 exports.

### The `terrariumctl` Command

Your primary tool for managing Terrarium is `terrariumctl`. It's a single, powerful command that handles almost everything.

The most common commands you'll use day-to-day are:
- `terrariumctl set domains`
- `terrariumctl set emails`
- `terrariumctl set idp` (To change between local ZITADEL and external OIDC logins)
- `terrariumctl set s3` (To configure off-site backups)
- `terrariumctl proxy sync` (To manually update your network routing rules)

*Want to see everything it can do? Check out the full [terrariumctl Reference](../reference/terrariumctl.md).*