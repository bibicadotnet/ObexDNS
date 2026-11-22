#!/usr/bin/env node
/**
 * @file docker.ts
 * @description Docker packaging and Docker Hub publishing workflow script for DNS Worker (Serverfull Mode).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const currentDir = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

const ROOT_DIR = path.resolve(currentDir, '..');

interface PackageMeta {
  name: string;
  version: string;
}

/**
 * Loads package metadata from root package.json.
 *
 * @returns Package name and version.
 */
function getPackageMeta(): PackageMeta {
  try {
    const pkgPath = path.join(ROOT_DIR, 'package.json');
    const content = fs.readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(content);
    return {
      name: parsed.name || 'dns-worker',
      version: parsed.version || 'latest'
    };
  } catch (err) {
    console.warn('[Docker] Failed to read package.json, using defaults:', err);
    return { name: 'dns-worker', version: 'latest' };
  }
}

/**
 * Parses command-line flags and arguments.
 *
 * @param args - Raw CLI arguments.
 * @returns Parsed options dictionary and subcommand.
 */
function parseCliArgs(args: string[]): { command: string; repo: string; platforms: string; push: boolean; isAlpha: boolean } {
  const meta = getPackageMeta();
  let command = 'build';
  let repo = process.env.DOCKER_REPO || process.env.DOCKER_IMAGE || 'hugokoo/dns-worker';
  let platforms = process.env.DOCKER_PLATFORMS || 'linux/amd64,linux/arm64';
  let push = false;
  let isAlpha = false;

  for (const arg of args) {
    if (arg === 'build' || arg === 'push' || arg === 'multiarch' || arg === 'run' || arg === 'help') {
      command = arg;
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length).trim();
    } else if (arg.startsWith('--platforms=')) {
      platforms = arg.slice('--platforms='.length).trim();
    } else if (arg === '--push') {
      push = true;
    } else if (arg === '--alpha' || arg === '--canary') {
      isAlpha = true;
    } else if (arg === '--help' || arg === '-h') {
      command = 'help';
    }
  }

  return { command, repo, platforms, push, isAlpha };
}

/**
 * Resolves short git commit SHA (7 chars).
 *
 * @returns Short commit hash.
 */
function getShortGitSha(): string {
  try {
    const res = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf-8' });
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim();
    }
  } catch {}
  return 'dev';
}

/**
 * Generates Docker tags for release or alpha/canary preview channels.
 *
 * @param repo - Target image repository.
 * @param version - Base package version.
 * @param isAlpha - Whether to tag as alpha/canary channel.
 * @returns Array of docker image tag strings.
 */
function getTags(repo: string, version: string, isAlpha: boolean): string[] {
  if (isAlpha) {
    const baseVer = version.split('-')[0];
    const shortSha = getShortGitSha();
    return [
      `${repo}:alpha`,
      `${repo}:canary`,
      `${repo}:${baseVer}-alpha.${shortSha}`,
      `${repo}:${baseVer}-canary.${shortSha}`
    ];
  }
  return [`${repo}:latest`, `${repo}:${version}`, `${repo}:v${version}`];
}

/**
 * Executes a shell command synchronously and forwards stdio.
 *
 * @param cmd - Executable command.
 * @param args - Command line arguments.
 * @returns Spawn result.
 */
function execCommand(cmd: string, args: string[]): SpawnSyncReturns<Buffer> {
  console.log(`\n\x1b[36m➜  Executing:\x1b[0m ${cmd} ${args.join(' ')}\n`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    shell: true
  });
  if (result.error) {
    console.error(`\x1b[31m✖ Error executing '${cmd}': ${result.error.message}\x1b[0m`);
    console.error(`Please verify that Docker (or Docker Desktop) is installed and available in your PATH.`);
    process.exit(1);
  }
  return result;
}

/**
 * Displays helpful CLI documentation and usage examples.
 */
function showHelp(): void {
  const meta = getPackageMeta();
  console.log(`
\x1b[1m\x1b[32mDNS Worker - Docker Packaging & Docker Hub Workflow\x1b[0m
Package: ${meta.name} (v${meta.version})
Runtime: Bun LTS (oven/bun:1-slim)

\x1b[1mUsage:\x1b[0m
  npm run docker:build        [-- --repo=<name>]             Build local Docker image
  npm run docker:build:alpha  [-- --repo=<name>]             Build local image tagged with alpha & canary
  npm run docker:multiarch    [-- --repo=<name>] [--push]     Build multi-arch image (amd64/arm64)
  npm run docker:push         [-- --repo=<name>]             Push release images to Docker Hub
  npm run docker:push:alpha   [-- --repo=<name>]             Push alpha & canary images to Docker Hub
  npm run docker:run          [-- --repo=<name>]             Run container locally in detached mode

\x1b[1mOptions:\x1b[0m
  --repo=<name>         Target Docker Hub repository (default: hugokoo/dns-worker or $DOCKER_REPO)
                        Example: --repo=hugokoo/dns-worker
  --alpha, --canary     Build/push with alpha and canary pre-release tags
  --platforms=<list>    Target platforms for multiarch build (default: linux/amd64,linux/arm64)
  --push                Immediately push images after building (used with multiarch)

\x1b[1mServerfull Port Mapping:\x1b[0m
  - 53:53/udp           Classic UDP DNS (RFC 1035)
  - 853:853/tcp         DNS over TLS (DoT, RFC 7858)
  - 80:80/tcp           HTTP Web Dashboard (Auto-redirects to HTTPS)
  - 443:443/tcp         HTTPS Web Dashboard & DoH (Primary / Recommended)

\x1b[1mPersistent Volumes:\x1b[0m
  - /var/lib/dns-worker SQLite database (dns_worker.sqlite) & persistent JWT secret
  - /etc/dns-worker     Custom .env configuration file
  - /etc/ssl/dns-worker Mounted TLS certificates (fullchain.pem & privkey.pem)
`);
}

/**
 * Builds standard local Docker images with versioned tags.
 *
 * @param repo - Target image name/repository.
 * @param version - Package version string.
 */
function handleBuild(repo: string, version: string, isAlpha: boolean): void {
  const tags = getTags(repo, version, isAlpha);
  const args = ['build'];
  for (const tag of tags) {
    args.push('-t', tag);
  }
  args.push('.');

  const result = execCommand('docker', args);
  if (result.status !== 0) {
    console.error(`\x1b[31m✖ Docker build failed with exit code ${result.status}\x1b[0m`);
    process.exit(result.status || 1);
  }

  console.log(`
\x1b[32m✔ Successfully built Docker images:\x1b[0m
${tags.map(t => `  • ${t}`).join('\n')}

Next steps:
  1. Test locally:   npm run docker:run -- --repo=${repo}
  2. Push to Hub:    npm run docker:push -- --repo=${repo}${isAlpha ? ' --alpha' : ''}
`);
}

/**
 * Builds multi-architecture images using docker buildx.
 *
 * @param repo - Target image repository.
 * @param version - Package version string.
 * @param platforms - Target architectures (comma separated).
 * @param push - Whether to push to registry directly.
 * @param isAlpha - Whether to build for alpha channel.
 */
function handleMultiarch(repo: string, version: string, platforms: string, push: boolean, isAlpha: boolean): void {
  const tags = getTags(repo, version, isAlpha);
  const args = ['buildx', 'build', '--platform', platforms];
  for (const tag of tags) {
    args.push('-t', tag);
  }
  if (push) {
    args.push('--push');
  } else {
    args.push('--load');
  }
  args.push('.');

  const result = execCommand('docker', args);
  if (result.status !== 0) {
    console.error(`\x1b[31m✖ Docker buildx failed with exit code ${result.status}\x1b[0m`);
    process.exit(result.status || 1);
  }

  console.log(`\x1b[32m✔ Multi-arch build completed for platforms [${platforms}].\x1b[0m`);
}

/**
 * Pushes tagged images to Docker Hub.
 *
 * @param repo - Target image repository.
 * @param version - Package version string.
 * @param isAlpha - Whether to push alpha channel tags.
 */
function handlePush(repo: string, version: string, isAlpha: boolean): void {
  const tags = getTags(repo, version, isAlpha);
  for (const tag of tags) {
    const result = execCommand('docker', ['push', tag]);
    if (result.status !== 0) {
      console.error(`\x1b[31m✖ Failed to push ${tag}. Make sure you are logged in ('docker login').\x1b[0m`);
      process.exit(result.status || 1);
    }
  }

  console.log(`\x1b[32m✔ Successfully pushed all tags to Docker Hub repository: ${repo}\x1b[0m`);
}

/**
 * Runs container locally with all Serverfull ports and volumes exposed.
 *
 * @param repo - Target image repository.
 */
function handleRun(repo: string): void {
  const containerName = 'dns-worker';
  const localCertsDir = path.join(ROOT_DIR, 'certs');
  const args = [
    'run',
    '-d',
    '--name', containerName,
    '--restart', 'unless-stopped',
    '-p', '53:53/udp',
    '-p', '853:853/tcp',
    '-p', '80:80/tcp',
    '-p', '443:443/tcp',
    '-v', 'dns_worker_data:/var/lib/dns-worker',
    '-v', 'dns_worker_config:/etc/dns-worker'
  ];

  if (fs.existsSync(localCertsDir)) {
    args.push('-v', `${localCertsDir}:/etc/ssl/dns-worker:ro`);
  }

  args.push(`${repo}:latest`);

  const result = execCommand('docker', args);
  if (result.status !== 0) {
    console.error(`\x1b[31m✖ Failed to run container. Try removing existing container first: docker rm -f ${containerName}\x1b[0m`);
    process.exit(result.status || 1);
  }

  console.log(`
\x1b[32m✔ DNS Worker container is running in the background!\x1b[0m
  • Container Name : ${containerName}
  • Web Dashboard  : https://localhost (Port 443, pure HTTP on port 80 automatically redirects to HTTPS)
  • Classic UDP DNS: udp://127.0.0.1:53
  • DNS over TLS   : tls://127.0.0.1:853
  • Persistent Data: Docker Volume 'dns_worker_data' (/var/lib/dns-worker)
  • Configuration  : Docker Volume 'dns_worker_config' (/etc/dns-worker)
  • TLS Certificate: ${fs.existsSync(localCertsDir) ? `Mounted from ${localCertsDir} (/etc/ssl/dns-worker)` : 'Mount to /etc/ssl/dns-worker or configure in .env'}

Useful commands:
  - View container logs:   docker logs -f ${containerName}
  - View serverfull status: docker exec -it ${containerName} bun dist/serverfull.mjs status
  - Stop container:        docker stop ${containerName}
`);
}

/**
 * Main command router.
 */
function main(): void {
  const rawArgs = process.argv.slice(2);
  const { command, repo, platforms, push, isAlpha } = parseCliArgs(rawArgs);
  const { version } = getPackageMeta();

  switch (command) {
    case 'help':
      showHelp();
      break;
    case 'multiarch':
      handleMultiarch(repo, version, platforms, push, isAlpha);
      break;
    case 'push':
      handlePush(repo, version, isAlpha);
      break;
    case 'run':
      handleRun(repo);
      break;
    case 'build':
    default:
      handleBuild(repo, version, isAlpha);
      break;
  }
}

main();
