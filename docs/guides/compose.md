# Isolated Docker Compose Stacks on Terrarium

One of the best ways to use Terrarium is to run a full Docker Compose application inside a single LXC container.

This solves a massive problem with traditional Linux servers: if you run all your Docker containers directly on the host machine, things get messy quickly. A broken database on one app can interfere with another, package dependencies clash, and you can't undo a bad deployment without taking down your entire server.

Terrarium puts each Compose stack in its own isolated boundary.

## Why this is the best way to run Compose:

- **Security:** The stack lives in an unprivileged LXC container. If an app gets compromised, the attacker is still locked out of your main host OS.
- **Isolation:** Each Compose stack gets its own file system, its own Docker daemon, and its own networking rules.
- **The Time Machine:** Did a `docker compose up` break your app? Just roll the container back 15 minutes and everything works again.
- **Clean Networking:** You don't have to map a hundred messy ports to your host. Just expose the main web server port to `0.0.0.0` inside the container, and let Terrarium route your domain name to it.

## 1. Create a Docker-Friendly Container

Terrarium is designed for this. By default, the `ubuntu/24.04` image is pre-configured with the permissions necessary to run Docker safely inside LXC (called "nesting").

**From the CLI:**
```bash
lxc launch images:ubuntu/24.04 my-stack --profile default --profile dev
```

*(You can also use the **LXD UI** at `lxd.<your-domain>` to create a new instance named `my-stack` with both the `default` and `dev` profiles.)*

The default profile keeps Docker-in-LXC support enabled. Adding the `dev` profile gives the normal `terrarium` user passwordless sudo for installing Docker and managing the stack without working directly as root.

## 2. Install Docker Inside the Container

Jump into your new container:
```bash
trm exec my-stack
```

Now, run the official Docker installer script. This only installs Docker *inside the container*, not on your host:
```bash
sudo apt-get update
sudo apt-get install -y curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker terrarium
```

Exit and re-enter the container so the new `docker` group membership is active. You now have a fully functional, isolated Docker daemon running inside your LXC container.

## 3. Deploy Your App

Now you can treat this container exactly like a regular Linux server.

1. Write your `docker-compose.yml` file.
2. Put it in `/opt/myapp` (or wherever you prefer).
3. Run `docker compose up -d`.

**Important Networking Rule:** Make sure the service you actually want people to see (like your Nginx web server or Node.js app) is mapping its port to `0.0.0.0` *inside the container*.

For example, your compose file should look like this:
```yaml
services:
  web:
    image: nginx
    ports:
      - "8080:80" # This exposes port 8080 INSIDE the LXC container
  db:
    image: postgres
    # Do NOT expose the database port here. It will remain completely private.
```

Now exit the container:
```bash
exit
```

## 4. Publish the App

Your Docker Compose app is now running perfectly, but it's completely invisible to the internet. 

Let's tell Terrarium's Traefik proxy to route traffic from a domain name directly to port `8080` inside that container.

On the host, run:
```bash
lxc config set my-stack user.proxy "https://app.example.com:8080"
terrariumctl proxy sync
```

Terrarium automatically provisions an SSL certificate and routes your traffic securely.

## Advanced: Running Many Apps (Dokploy / Coolify)

If you find yourself managing dozens of Docker Compose files and want a UI to manage them (like Heroku or Vercel), you don't have to do it by hand.

Terrarium is the perfect host for self-hosted deployment platforms. Check out our guides on how to run [Dokploy on Terrarium](dokploy.md) or [Coolify on Terrarium](coolify.md) inside an isolated LXC container.
