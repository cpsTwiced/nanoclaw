---
name: rebuild
description: Rebuild the agent container and restart NanoClaw. Use when container code changes need to be applied. Triggers on "rebuild", "rebuild container", "restart nanoclaw".
---

# Rebuild & Restart

Rebuild the NanoClaw agent container image and restart the service.

## Steps

1. **Build the TypeScript project** (picks up any host-side changes):
   ```bash
   npm run build
   ```

2. **Rebuild the container image**:
   ```bash
   ./container/build.sh
   ```
   If the build fails, check the output for errors and fix before continuing.

3. **Restart the service**:
   ```bash
   # macOS
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw

   # Linux
   systemctl --user restart nanoclaw
   ```

4. Confirm success to the user.

## Clean Rebuild

If the user asks for a clean/fresh rebuild (or a normal rebuild didn't pick up changes), prune the Docker build cache first:

```bash
docker builder prune -af
./container/build.sh
```
