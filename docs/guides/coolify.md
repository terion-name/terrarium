# Coolify on Terrarium

[Coolify](https://coolify.io/) is an open-source alternative to Heroku and Vercel. It provides a web interface to deploy apps from Git repositories, manage Docker Compose stacks, and spin up databases.

If you install Coolify directly onto a bare metal server, it takes over the entire machine. **On Terrarium, we do it better.**

The cleanest way to run Coolify is to split it up:
- **The Control Plane:** One LXC container runs the Coolify dashboard.
- **The App Servers:** One or more separate LXC containers act as your "deployment servers", where your apps actually run.

This gives Coolify the SSH-managed server architecture it expects, while Terrarium keeps everything securely isolated and protected by ZFS snapshots.

---

## 1. Create the Control Plane (Dashboard)

First, let's create a container just for the Coolify dashboard.

```bash
lxc launch ubuntu:24.04 coolify --profile dev
```

The `dev` profile lets the `terrarium` user run the installer with sudo without using root as the normal working account.

Jump into the container and install Coolify:
```bash
trm exec coolify
sudo apt-get update
sudo apt-get install -y curl
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
exit
```
*(Note: Coolify automatically installs its own Docker engine inside this container.)*

### Securely Access the Dashboard
By default, the Coolify installer exposes the dashboard on port `8000`. We need to log in to create the initial admin account.

Let's temporarily publish the dashboard to the web, but lock it behind Terrarium's Single Sign-On so nobody else can access it:

```bash
lxc config set coolify user.proxy "https://coolify-setup.example.com:8000@auth"
terrariumctl proxy sync
```

If your Terrarium install uses the local managed ZITADEL, `terrariumctl proxy sync` also updates the route-auth callback URL in ZITADEL automatically. With an external provider such as ZITADEL Cloud, add this setup callback URL to that provider manually:
```text
https://coolify-setup.example.com/oauth2/callback
```

Go to `https://coolify-setup.example.com`, pass the SSO gate, and create your Coolify admin account. 

Once inside Coolify, go to **Settings** and set your official dashboard domain (e.g., `http://coolify.example.com`). Then, tell Terrarium to route traffic to Coolify's internal proxy on port `80`:

```bash
lxc config set coolify user.proxy "https://coolify.example.com:80@auth"
terrariumctl proxy sync
```

With an external provider, add the final dashboard callback too:
```text
https://coolify.example.com/oauth2/callback
```

---

## 2. Create an App Server

Now we need a place for your actual apps to run. Let's create a new "deployment server" container.

```bash
lxc launch ubuntu:24.04 apps-server-1 --profile dev
```

Coolify supports non-root server users when the user has SSH key access and passwordless sudo. Its docs currently mark this as experimental, which fits Terrarium's `dev` profile model: Coolify connects as `terrarium`, and `terrarium` can use sudo while preparing deployments.

Coolify manages its servers via SSH. We need to prep this container to accept SSH connections from the control plane.

```bash
trm exec apps-server-1
sudo apt-get update
sudo apt-get install -y bash curl ca-certificates openssh-server
install -d -m 0700 ~/.ssh
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl enable --now ssh
sudo systemctl restart ssh
exit
```

### Link the Server to Coolify

1. Log into your Coolify Dashboard.
2. Go to **Keys & Tokens** and create a new Private Key. Copy the associated Public Key.
3. Back on your host terminal, paste that Public Key into the app server's authorized keys file:
   ```bash
   trm exec apps-server-1 -- bash -lc 'cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
   # Paste the key, press Enter, then press Ctrl-D
   ```
4. Find the private IP address of your app server:
   ```bash
   lxc list apps-server-1 -c n4
   ```
5. In Coolify, go to **Servers** -> **Add New Server**. Enter the private IP address you just found, use the user `terrarium`, and select the Private Key you created.

Coolify will connect to the container over Terrarium's secure internal network, install Docker, and prepare it for deployments.

---

## 3. Deploying and Routing Apps

When you deploy an app (like a Node.js website) onto `apps-server-1` using Coolify, you'll set the domain inside the Coolify UI (e.g., `http://my-website.example.com`).

However, Terrarium still owns the *actual* public internet connection. You must tell Terrarium to pass traffic for that domain into the app server.

On the Terrarium host, run:
```bash
lxc config set apps-server-1 user.proxy "https://my-website.example.com:80"
terrariumctl proxy sync
```

**The Traffic Flow:**
`Internet` -> `Terrarium Traefik` -> `App Server Container` -> `Coolify Traefik` -> `Your App`

*(If you deploy a second app to that same server, just append it to the label separated by a comma: `"https://my-website.example.com:80,https://app2.example.com:80"`)*

## Why Do It This Way?

This setup gives you several architectural advantages:
- You get the beautiful, automated deployment experience of Coolify.
- You can create multiple separate App Servers (e.g., `apps-client-a`, `apps-experiments`). If one client's app gets hacked, they are physically isolated from the other clients.
- If a deployment completely breaks a server's Docker engine, you don't have to reinstall everything. Just use Terrarium to roll the `apps-server-1` LXC container back to a snapshot from earlier.
