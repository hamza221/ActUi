# ActUI demo repository

Launch the built dashboard against this fixture without pulling a container image:

```bash
actui examples/demo-repo --trust
```

Choose the `pull_request` event, open **Configure**, set the runner mapping to `self-hosted=-self-hosted`, and run **Demo CI**. Its host-runner jobs print deterministic sample output and exercise parallel jobs followed by a dependent build.

The same run can be started from the JSON CLI:

```bash
actui run --workflow ci.yml --event pull_request \
  --platform self-hosted=-self-hosted --json
```
