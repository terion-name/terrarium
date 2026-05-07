# Shared Data Between Containers

Sometimes you need several of your isolated environments to share the exact same files. 

For example, you might want to:
- Share one API login file across multiple AI agents.
- Create a shared "memory" folder for different services to read from.
- Keep a central configuration directory that all your worker containers pull from.

The cleanest, most native way to do this in Terrarium is by creating a **Shared LXD Custom Volume**. 

This creates an isolated chunk of storage that exists independently of any single container. You can attach it to as many containers as you want at the same time. If you delete a container, the shared volume (and its data) survives.

---

## 🛠️ The Easy Way: Using the LXD UI

If you prefer a visual approach, you can do all of this right from your browser.

### 1. Create the Shared Volume
1. Open the **LXD UI** at `lxd.<your-domain>`.
2. Go to **Storage**, select your `terrarium` storage pool, and click **Volumes**.
3. Click **Create Volume** and choose the `Custom` type.
4. Name it something clear, like `agent-memory`.

### 2. Attach It to Your Containers
1. Go to the **Instances** tab and select a container (e.g., `openclaw`).
2. Click **Devices** -> **Add Device** -> **Disk**.
3. Choose the custom volume you just created (`agent-memory`).
4. Set the **Target Path** where you want it to appear inside the container (e.g., `/srv/shared-memory`).
5. Repeat this process for any other containers that need access.

---

## 💻 The Hacker Way: Using the CLI

If you prefer the terminal, you can accomplish the exact same thing with a few quick commands.

**1. Create the volume:**
```bash
lxc storage volume create terrarium agent-memory
```

**2. Attach it to your containers:**
```bash
lxc storage volume attach terrarium agent-memory openclaw agent-memory /srv/shared-memory
lxc storage volume attach terrarium agent-memory hermes agent-memory /srv/shared-memory
```

*In this example, both the `openclaw` and `hermes` containers can now read and write to the `/srv/shared-memory` folder, and they will instantly see each other's changes.*

---

## Example: Sharing a Single Login

Let's say you have three separate AI containers (`openclaw`, `hermes`, and `research`), and you want all of them to use the same OpenAI Codex login.

Instead of authenticating three separate times, you can just share the folder where the tool expects its credentials to be stored.

```bash
# Create the volume
lxc storage volume create terrarium codex-auth

# Attach it exactly where the CLI expects the auth file to live
lxc storage volume attach terrarium codex-auth openclaw codex-auth /home/terrarium/.codex
lxc storage volume attach terrarium codex-auth hermes codex-auth /home/terrarium/.codex
lxc storage volume attach terrarium codex-auth research codex-auth /home/terrarium/.codex
```

Now, just log into one of those containers, run the login command, and *boom*—all three containers are authenticated instantly.

---

## When *Not* To Use This

This feature is fantastic for small, internal state sharing. However, you should **not** use this if:
- You want to access the files directly from your personal laptop over the internet.
- You have massive amounts of data that shouldn't live on your VPS's main drive.
- The data needs to survive if you delete your entire VPS.

If you need any of those features, check out the [External Shared Storage](./external-shared-storage.md) guide instead.
