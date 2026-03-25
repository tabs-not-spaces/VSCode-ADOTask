import * as task from 'azure-pipelines-task-lib/task';
import * as toolLib from 'azure-pipelines-tool-lib/tool';
import { spawn, SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import https from 'node:https';
import { arch, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { exit } from 'node:process';

async function main() {
  try {
    const tunnelName = task.getInput('tunnelName') || 'ado-pipeline-tunnel';

    task.debug(`Starting VS Code Tunnel: ${tunnelName}. Enable Debug logging to see more detail on the process.`);

    // Timeouts (in minutes) configurable via task inputs
    const connectionTimeoutMinutes = (() => {
      const v = task.getInput('connectionTimeout') || '5';
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : 5;
    })();

    const sessionTimeoutMinutes = (() => {
      const v = task.getInput('sessionTimeout') || '60';
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : 60;
    })();

    const connectionTimeoutMs = connectionTimeoutMinutes * 60 * 1000;
    const sessionTimeoutMs = sessionTimeoutMinutes * 60 * 1000;

    task.debug(`Connection timeout: ${connectionTimeoutMinutes} minutes, session timeout: ${sessionTimeoutMinutes} minutes`);

    // Determine platform
    const runnerPlatform = platform();
    const runnerArch = arch();
    let downloadUrl = '';
    let downloadFileName = '';
    let extractPath = '';

    const cliToolCacheName = 'vscode-cli';

    // Check if architecture is supported
    if (runnerArch !== 'x64') {
      throw new Error(`Unsupported architecture: ${runnerArch}. Only x64 is supported.`);
    }

    switch (runnerPlatform) {
      case 'linux':
        // Alpine CLI build is statically linked and compatible with all glibc/musl Linux agents
        downloadUrl = 'https://code.visualstudio.com/sha/download?build=stable&os=cli-alpine-x64';
        downloadFileName = 'code-cli.tar.gz';
        extractPath = join(homedir(), cliToolCacheName);
        break;
      case 'darwin':
        downloadUrl = 'https://code.visualstudio.com/sha/download?build=stable&os=cli-darwin-x64';
        downloadFileName = 'code-cli.zip';
        extractPath = join(homedir(), cliToolCacheName);
        break;
      case 'win32':
        downloadUrl = 'https://code.visualstudio.com/sha/download?build=stable&os=cli-win32-x64';
        downloadFileName = 'code-cli.zip';
        extractPath = join(homedir(), cliToolCacheName);
        break;
      default:
        throw new Error(`Unsupported platform: ${runnerPlatform}`);
    }

    task.debug(`Platform: ${runnerPlatform}, Architecture: ${runnerArch}`);
    task.debug(`Download URL: ${downloadUrl}`);

    // Fetch the latest stable VS Code release version string
    async function fetchStableReleaseVersion(url: string): Promise<string> {
      return new Promise((resolve) => {
        try {
          https.get(url, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (d: Buffer) => chunks.push(d));
            res.on('end', () => {
              try {
                const body = Buffer.concat(chunks).toString();
                let parsed: unknown = null;
                try {
                  parsed = JSON.parse(body);
                } catch {
                  resolve(body.trim());
                  return;
                }

                if (Array.isArray(parsed) && parsed.length > 0) {
                  const first = parsed[0] as Record<string, unknown> | string;
                  if (typeof first === 'string') {
                    resolve(first);
                  } else {
                    resolve(String(first?.version || first?.name || '') || '');
                  }
                } else if (typeof parsed === 'object' && parsed !== null) {
                  const obj = parsed as Record<string, unknown>;
                  resolve(String(obj.version || obj.name || '') || '');
                } else if (typeof parsed === 'string') {
                  resolve(parsed);
                } else {
                  resolve('');
                }
              } catch (e) {
                task.debug(`Error parsing version response: ${e}`);
                resolve('');
              }
            });
          }).on('error', (e) => {
            task.debug(`Version API request error: ${e}`);
            resolve('');
          });
        } catch {
          resolve('');
        }
      });
    }

    const releasesApi = 'https://update.code.visualstudio.com/api/releases/stable';
    task.debug('Checking stable releases API for version...');
    const stableVersion = await fetchStableReleaseVersion(releasesApi);
    if (!stableVersion) {
      task.warning(`Could not determine stable VS Code version from ${releasesApi}; skipping tool cache and downloading directly.`);
    } else {
      task.debug(`Stable VS Code version: ${stableVersion}`);
    }

    // Create extraction directory
    if (!existsSync(extractPath)) {
      mkdirSync(extractPath, { recursive: true });
    }

    // Check the agent tool cache for a previously downloaded VS Code CLI (only when we have a version)
    let cliPath = '';
    if (stableVersion) {
      try {
        task.debug(`Checking agent tool cache for VS Code CLI ${cliToolCacheName} version ${stableVersion}...`);
        const found = toolLib.findLocalTool(cliToolCacheName, stableVersion);
        if (found) {
          cliPath = found;
          task.debug(`Found cached VS Code CLI ${stableVersion} in tool cache: ${cliPath}`);
        } else {
          task.debug(`No cached VS Code CLI found for version ${stableVersion}.`);
        }
      } catch (err) {
        task.warning(`Tool cache check failed: ${err}`);
      }
    }

    if (!cliPath) {
      const cliName = runnerPlatform === 'win32' ? 'code.exe' : 'code';
      task.debug('Downloading VS Code CLI...');
      const downloadPath = await toolLib.downloadTool(downloadUrl, join(extractPath, downloadFileName));
      task.debug(`Downloaded to: ${downloadPath}`);
      task.debug('Extracting VS Code CLI...');
      if (runnerPlatform === 'win32') {
        extractPath = await toolLib.extractZip(downloadPath, extractPath);
      } else {
        extractPath = await toolLib.extractTar(downloadPath, extractPath);
      }

      const extractCliPath = join(extractPath, cliName);

      // Verify the CLI binary exists before attempting to use it
      if (!existsSync(extractCliPath)) {
        throw new Error(`VS Code CLI not found at expected path: ${extractCliPath}`);
      }

      if (runnerPlatform !== 'win32') {
        task.debug(`Making ${extractCliPath} executable...`);
        chmodSync(extractCliPath, 0o755);
      }

      if (stableVersion) {
        task.debug(`Caching VS Code CLI ${extractCliPath} as ${cliToolCacheName} version ${stableVersion}...`);
        const cacheDir = await toolLib.cacheFile(extractCliPath, cliName, cliToolCacheName, stableVersion);
        task.debug(`Cached VS Code CLI to: ${cacheDir}`);
        cliPath = join(cacheDir, cliName);
      } else {
        cliPath = extractCliPath;
      }
    }

    if (!cliPath) {
      throw new Error('Failed to download and extract VS Code CLI');
    }

    // Create CLI data directory for auth token storage, keyed by the ADO user identity
    const cliDataDir = join(homedir(), 'vscode-cli-data');
    const noCacheCliAuth = task.getBoolInput('noCacheCliAuth', false);

    // ADO identity for scoping the cached auth directory
    const adoUser =
      process.env['BUILD_REQUESTEDFOREMAIL'] ||
      process.env['BUILD_REQUESTEDFOR'] ||
      '';

    if (adoUser && !noCacheCliAuth) {
      task.debug(`Using ADO user identity for CLI data dir: ${adoUser}`);
    } else if (noCacheCliAuth) {
      task.debug('Auth caching disabled (noCacheCliAuth=true)');
    } else {
      task.debug('ADO user identity not available; auth will not be persisted across runs');
    }

    if (!existsSync(cliDataDir)) {
      mkdirSync(cliDataDir, { recursive: true });
    }

    // Start tunnel — authenticate via Microsoft account (Azure AD) for ADO environments
    task.debug('Starting VS Code tunnel...');
    const tunnelArgs = [
      'tunnel',
      '--accept-server-license-terms',
      '--verbose',
      '--provider',
      'microsoft',
      '--cli-data-dir',
      cliDataDir
    ];

    if (tunnelName) {
      tunnelArgs.push('--name', tunnelName);
    }

    const options: SpawnOptions = {
      stdio: 'pipe',
      detached: true
    };

    task.debug(`Starting: ${cliPath} ${tunnelArgs.join(' ')}`);
    const child = spawn(cliPath, tunnelArgs, options);
    child.unref();

    const killChild = () => { try { child.kill(); } catch (_) {} };

    task.debug('VS Code tunnel started — capturing output');

    // If a file `/adocontinue` or `~/adocontinue` is created, exit and allow the pipeline to continue
    const continueFilePaths = ['/adocontinue', join(homedir(), 'adocontinue')];
    const continuePollIntervalMs = 5_000;
    const checkContinueFiles = () => {
      for (const p of continueFilePaths) {
        try {
          if (existsSync(p)) {
            return p;
          }
        } catch {
          // ignore permission errors
        }
      }
      return undefined;
    };

    const continueWatcher = setInterval(() => {
      const found = checkContinueFiles();
      if (found) {
        console.log(`Continue file detected: ${found} — detaching and allowing pipeline to continue`);
        clearInterval(continueWatcher);
        exit(0);
      }
    }, continuePollIntervalMs);

    // Track connection state and timeouts
    let connected = false;
    let connectionTimer: NodeJS.Timeout | null = null;
    let sessionTimer: NodeJS.Timeout | null = null;
    const connectionIndicator = '[tunnels::connections::relay_tunnel_host] Opened new client';

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        const text = String(chunk);
        const lines = text.split(/\r?\n/).filter(l => l.length > 0);
        for (const line of lines) {
          task.debug(line);
          // Surface authentication and connection instructions to the pipeline log
          if (line.startsWith('Open this link') || line.startsWith('To grant access')) {
            console.log(line);
          }
          if (!connected && line.includes(connectionIndicator)) {
            connected = true;
            task.debug('Connection detected; switching to session timeout');
            if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
            sessionTimer = setTimeout(() => {
              task.warning(`Session timeout after ${sessionTimeoutMinutes} minutes reached; terminating tunnel`);
              killChild();
            }, sessionTimeoutMs);
          }
        }
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        const text = String(chunk);
        const lines = text.split(/\r?\n/).filter(l => l.length > 0);
        for (const line of lines) {
          task.debug(line);
        }
      });
    }

    // Start the connection timeout
    connectionTimer = setTimeout(() => {
      if (!connected) {
        task.warning(`Connection timeout after ${connectionTimeoutMinutes} minutes reached; terminating tunnel`);
        killChild();
      }
    }, connectionTimeoutMs);

    // Wait for the tunnel process to exit
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearInterval(continueWatcher);
        if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
        if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
      };

      child.on('error', err => {
        cleanup();
        reject(err);
      });

      child.on('close', (code) => {
        cleanup();
        console.log(`VS Code tunnel exited with code ${code}`);
        if (code && code !== 0) {
          reject(new Error(`VS Code tunnel exited with code ${code}`));
        } else {
          resolve();
        }
      });
    });
  } catch (err) {
    task.setResult(
      task.TaskResult.Failed,
      `Task failed with error: ${err instanceof Error ? err.message : String(err)}`
    );
    exit(1);
  }
}

main();
