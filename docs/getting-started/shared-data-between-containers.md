# Shared Data Between Containers

Sometimes you want several Terrarium containers to see the same small piece of state.

Common examples:

- one OpenAI or OpenRouter login that several agent environments should reuse
- shared CLI credentials for internal tools
- one small config or cache directory that belongs to a group of related containers

For this case, the cleanest Terrarium-native pattern is a **shared LXD custom storage volume**.

That gives you a shared filesystem that:

- is separate from any one container
- can be attached to multiple containers at the same time
- survives deleting and recreating a container
- stays inside the Terrarium/LXD storage model instead of turning into ad hoc host bind mounts

LXD documents this directly: custom filesystem volumes can be shared between multiple instances and are retained until you delete them. Source: [How to manage storage volumes](https://documentation.ubuntu.com/lxd/stable-5.21/howto/storage_volumes/)

## When To Use This Pattern

Use a shared custom volume when:

- the shared data is small
- you want it to live on the same Terrarium storage pool
- the same data should be visible in multiple containers
- you do not need to browse or edit it directly from your laptop all the time

This is a good fit for shared credentials, small agent memories, common configuration, or a shared working directory for a few related environments.

If the data should also be mounted on your own computer and live outside the VPS, use [External Shared Storage](./external-shared-storage) instead.

## Example: One OpenAI Login Across Several Agent Containers

Imagine you have three separate containers:

- `openclaw`
- `hermes`
- `research`

You want all three to see the same credentials directory so you can authorize once and reuse it.

The important idea is:

- create one shared volume
- attach it to each container at the path where that tool expects its credentials

## Create The Shared Volume

On the host:

```bash
lxc storage volume create terrarium openai-auth
```

This creates a filesystem volume named `openai-auth` on the Terrarium storage pool.

## Attach It To Containers

Attach the same volume to each container at the credentials path you want to share.

Example:

```bash
lxc storage volume attach terrarium openai-auth openclaw openai-auth /root/.config/openai
lxc storage volume attach terrarium openai-auth hermes openai-auth /root/.config/openai
lxc storage volume attach terrarium openai-auth research openai-auth /root/.config/openai
```

You can use a different mount path if the tool stores credentials somewhere else.

The pattern matters more than the exact path:

- one shared volume
- same mount path in every container that should reuse it

## Authorize Once

Now enter one of the containers and complete the login flow there:

```bash
lxc exec openclaw -- bash
```

After the tool writes its credentials into `/root/.config/openai`, the same files are visible in the other containers because they are all looking at the same shared volume.

## Verify It

From another container:

```bash
lxc exec hermes -- ls -la /root/.config/openai
```

If you see the same files, the sharing is working.

## Helpful Variations

### Shared agent memory directory

```bash
lxc storage volume create terrarium agent-memory
lxc storage volume attach terrarium agent-memory openclaw agent-memory /srv/shared-memory
lxc storage volume attach terrarium agent-memory hermes agent-memory /srv/shared-memory
```

### Shared configuration directory

```bash
lxc storage volume create terrarium shared-config
lxc storage volume attach terrarium shared-config worker-a shared-config /srv/shared-config
lxc storage volume attach terrarium shared-config worker-b shared-config /srv/shared-config
```

## Things To Keep In Mind

- This data is **shared live**. If one container changes or deletes files, the others see that immediately.
- This is best for small shared state, not for giant datasets.
- A shared custom volume is not “owned” by one container. Treat it as a shared resource on purpose.
- If multiple tools write to the same files in incompatible ways, sharing will become confusing. Use one shared volume only when the data is genuinely meant to be shared.

## UI Path

You can also do this from the LXD UI:

1. Open `Storage` -> `Volumes`
2. Create a new filesystem volume
3. Open each instance
4. Attach the same volume as a disk device
5. Choose the target mount path inside the container

If you prefer not to memorize the CLI, this is one of the easier things to do in the UI.

## When Not To Use This

Do **not** use this pattern when:

- the data should also be available on your laptop or desktop
- the data is large and should live outside the VPS
- the data needs its own separate backup lifecycle

For those cases, use [External Shared Storage](./external-shared-storage).
