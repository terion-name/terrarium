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

If you prefer to do this visually, the shipped LXD UI handles most of this flow well.

### Create the shared volume in LXD UI

1. Open `Storage`.
2. Select the Terrarium storage pool.
3. Open `Volumes`.
4. Create a new `Custom` filesystem volume.
5. Give it a clear name such as `openai-auth` or `agent-memory`.

### Attach it to each container in LXD UI

1. Open `Instances`.
2. Select a container such as `openclaw`.
3. Open `Devices`.
4. Add a new `Disk` device.
5. Choose the custom volume you created.
6. Set the target path inside the container, for example `/root/.config/openai`.
7. Repeat for every other container that should share the same data.

### Finish the login inside one container

The last part still happens inside the container itself:

1. Open `Console` for one of the containers in LXD UI.
2. Run the tool's normal login flow there.
3. Check another container and confirm the same files are visible at the same path.

This is one of the nicer Terrarium workflows for non-console-heavy users: the storage object and the device wiring can both be done from the LXD UI, and you only drop into the container console for the actual app login.

## When Not To Use This

Do **not** use this pattern when:

- the data should also be available on your laptop or desktop
- the data is large and should live outside the VPS
- the data needs its own separate backup lifecycle

For those cases, use [External Shared Storage](./external-shared-storage).
