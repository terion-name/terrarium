# Dokploy on Terrarium

Dokploy is an open-source deployment engine similar to Heroku or Vercel. It provides a web UI to manage Git-based apps, databases, and Docker Compose stacks.

Instead of installing Dokploy directly on your bare metal server, Terrarium lets you install Dokploy inside an LXC container. 

This model is powerful because:
- **The Control Plane:** One container runs the Dokploy UI.
- **The Deployment Servers:** One or more separate containers act as the places where your apps actually run.

If an app breaks its Docker daemon or gets compromised, it's trapped inside its own unprivileged LXC container, keeping your primary server and your Dokploy UI completely safe.

---

## 1. Create the Dokploy UI Container

First, we need a container for the Dokploy control panel.

**From the CLI:**
```bash
lxc launch images:ubuntu/24.04 dokploy
```

Jump inside and run the official installer:
```bash
lxc exec dokploy -- bash
apt-get update
apt-get install -y curl
curl -sSL https://dokploy.com/install.sh | sh
exit
```

By default, the Dokploy UI runs on port `3000`. We need to tell Terrarium to expose this port to the internet. We recommend adding the `@auth` tag so the Dokploy login page is protected by your Single Sign-On.

```bash
lxc config set dokploy user.proxy "https://dokploy.example.com:3000@auth"
terrariumctl proxy sync
```

Head to `https://dokploy.example.com` and create your first admin account.

---

## 2. Create a Deployment Server

Now we need a separate container for your actual apps to run on. We'll call this one `apps-a`.

```bash
lxc launch images:ubuntu/24.04 apps-a
```

Dokploy manages these servers over SSH, so we need to prepare the container to accept SSH connections from the Dokploy UI.

```bash
lxc exec apps-a -- bash
apt-get update
apt-get install -y bash curl openssh-server
systemctl enable --now ssh
mkdir -p /root/.ssh
chmod 700 /root/.ssh
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh
exit
```

### Link the Server to Dokploy

1. In your Dokploy UI, go to **Settings** -> **SSH Keys**. Create a new key and copy the Public Key.
2. Back on your host terminal, paste that Public Key into the app server's authorized keys file:
   ```bash
   lxc exec apps-a -- bash -lc 'cat >> /root/.ssh/authorized_keys'
   # Paste the key, press Enter, then press Ctrl-D
   ```
3. Find the private IP address of your app server:
   ```bash
   lxc list apps-a -c n4
   ```
4. In Dokploy, go to **Remote Servers** -> **Add Server**. Enter the private IP address, the user `root`, and the SSH key you created.
5. Click **Setup Server** to let Dokploy install Docker and prepare the container for deployments.

---

## 3. Deploying and Routing Apps

When you deploy a new app using Dokploy, you will assign it a domain name (like `https://my-website.example.com`) directly inside the Dokploy UI.

Dokploy will automatically handle routing *inside* the `apps-a` container. However, Terrarium still owns the *actual* connection to the internet. You must tell Terrarium to pass traffic for that domain into the app server.

On the Terrarium host, run:
```bash
lxc config set apps-a user.proxy "https://my-website.example.com:80"
terrariumctl proxy sync
```

**The Traffic Flow:**
`Internet` -> `Terrarium Traefik` -> `App Server Container` -> `Dokploy Traefik` -> `Your App`

*(If you deploy a second app to that same server, just append it to the label separated by a comma: `"https://my-website.example.com:80,https://app2.example.com:80"`)*

## Why Do It This Way?

This setup gives you a clean level of organization and safety:
- You get the Heroku-like automated deployment experience of Dokploy.
- You can create multiple separate Deployment Servers (e.g., `apps-client-a`, `apps-experiments`). If one client's app breaks its server, it doesn't affect your other clients.
- If a deployment completely destroys the Docker daemon on a server, you don't have to rebuild your VPS. Just use Terrarium's time machine to roll the `apps-a` LXC container back to a recent snapshot.