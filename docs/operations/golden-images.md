# Golden Images

Backups are for recovery. Golden images are for reuse.

Terrarium's normal backup flow gives you a time machine for existing containers:
you can roll back a broken app, restore a snapshot as a separate container, or
export restore points to S3. A golden image is different. It is a named template
you can launch again and again.

## Create a Golden Image

Start with a container that is already configured the way you want:

```bash
trm image create web-01 golden-web
```

Terrarium creates a temporary snapshot, copies it to a temporary instance,
removes published-route proxy config from that copy, publishes the image, and
cleans up the temporary resources.

If you already made the snapshot you want to preserve, publish that snapshot:

```bash
lxc snapshot web-01 known-good
trm image create web-01 golden-web --snapshot known-good
```

If the image alias already exists and you want to replace it:

```bash
trm image create web-01 golden-web --snapshot known-good --reuse
```

## Launch From a Golden Image

Use the alias as the image name:

```bash
trm image launch golden-web web-02 --profile dev
```

You can still set basic launch-time resources:

```bash
trm image launch golden-web web-03 --profile dev --disk 40G --memory 4G --cpu 2
```

And you can publish the new container with a fresh route:

```bash
trm image launch golden-web web-04 --proxy https://web-04.example.com:8080
```

## Manage Images

List images:

```bash
trm image list
```

Delete an image alias when you no longer need it:

```bash
trm image delete golden-web
```

## When to Use This

Use golden images for:

- base development containers with your tools already installed
- app templates you launch repeatedly
- known-good agent environments before a large experiment

Use backups instead when you need to recover an existing container's history or
export data off the server.
