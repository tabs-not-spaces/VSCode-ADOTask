# VS Code Tunnel — Azure DevOps Pipeline Task

Enables live debugging of an Azure Pipelines job using an instance of Visual Studio Code Server running inside the pipeline agent.

This is an Azure DevOps adaptation of [JustinGrote/VSCode-action](https://github.com/JustinGrote/VSCode-action), which provides the same capability for GitHub Actions.

---

## Usage

Add the task to your pipeline YAML at the point where you want to pause for debugging.  It is strongly recommended to make the step conditional so it only activates on failure or when explicitly enabled:

```yaml
steps:
  - task: VSCodeTunnel@1
    condition: failed()        # Only start the tunnel when a previous step fails
    displayName: 'VS Code Debug Tunnel'
    inputs:
      tunnelName: 'my-pipeline-tunnel'   # optional — max 20 chars
      connectionTimeout: 5               # optional — minutes, default 5
      sessionTimeout: 60                 # optional — minutes, default 60
      noCacheCliAuth: false              # optional — default false
```

On first run, the task will print a link in the pipeline log for **Microsoft account (Azure AD) device code login**.  Open the link, sign in, and then access the VS Code instance via your browser or the VS Code desktop app using **Remote Tunnels: Connect to Tunnel** from the Command Palette.

---

## Authentication

This task authenticates the VS Code CLI with a **Microsoft account**, which is appropriate for Azure DevOps environments (unlike the GitHub account used by the original GitHub Action).

On subsequent runs with `noCacheCliAuth: false` (the default), the auth token is stored in a local directory on the agent and reused, so device-code login is only required when the token expires.  Set `noCacheCliAuth: true` for a fresh auth on every run (more secure).

> **Note for Microsoft-hosted agents:** Microsoft-hosted agents are ephemeral, so cached auth tokens are lost between runs.  You will need to authenticate on every run or use a self-hosted agent for persistent token caching.

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `tunnelName` | No | `ado-pipeline-tunnel` | Name for the tunnel. Must be less than 20 characters. |
| `connectionTimeout` | No | `5` | Minutes to wait for an initial connection before terminating. |
| `sessionTimeout` | No | `60` | Minutes after the first connection before the tunnel is terminated. |
| `noCacheCliAuth` | No | `false` | Disable caching of tunnel auth tokens on the agent. |

---

## Output Variables

| Variable | Description |
|----------|-------------|
| `tunnelUrl` | The URL for accessing the VS Code tunnel (set when available). |

---

## Resuming the Pipeline

Once you are done debugging, create an `adocontinue` file on the agent to allow the pipeline to continue:

```bash
touch /adocontinue
# or
touch ~/adocontinue
```

The task polls for these files every 5 seconds and exits cleanly when detected, allowing subsequent pipeline steps to run.

---

## Credits

Based on [JustinGrote/VSCode-action](https://github.com/JustinGrote/VSCode-action) — a GitHub Actions version of the same concept.
