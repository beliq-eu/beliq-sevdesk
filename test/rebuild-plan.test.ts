import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// scripts/rebuild-plan.sh decides what the rebuild path of docker-publish.yml
// pushes to `latest`. It runs here as it runs in the workflow: bash, a real git
// checkout of "main" with a release tag, and a tree it prepares on disk. Only
// the registry is a stand-in, a `docker` on PATH that answers
// `buildx imagetools inspect` from files.

const SCRIPT = resolve('scripts/rebuild-plan.sh')
const IMAGE = 'ghcr.io/beliq-eu/beliq-sevdesk'
const OLD = `sha256:${'a'.repeat(64)}`
const NEW = `sha256:${'b'.repeat(64)}`
const NEWER = `sha256:${'c'.repeat(64)}`

const FAKE_DOCKER = `#!/usr/bin/env bash
# docker buildx imagetools inspect <ref> [--format <f> | --raw]
ref="$4"; tag="\${ref##*:}"
[ -d "$FAKE_REGISTRY/$tag" ] || { echo "ERROR: $ref: not found" >&2; exit 1; }
case "\${5:-}" in
  --format) cat "$FAKE_REGISTRY/$tag/labels.json" ;;
  --raw) cat "$FAKE_REGISTRY/$tag/index.json" ;;
  *) echo "Name: $ref" ;;
esac
`

function dockerfile(base: string): string {
  return [
    '# worker image',
    `FROM ${base} AS builder`,
    'WORKDIR /build',
    'RUN npm ci',
    '',
    `FROM  ${base}   AS runner`,
    'ENTRYPOINT ["node", "dist/index.js"]',
    '',
  ].join('\n')
}

let dir: string
let repo: string
let registry: string
let tree: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const [name, content] of Object.entries(files)) await writeFile(join(repo, name), content)
  git('add', '--all')
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}

/** What `latest` and the X.Y.Z tag read as on the stand-in registry. */
async function publish(tag: string, labels: Record<string, string>, annotations?: Record<string, string>) {
  await mkdir(join(registry, tag), { recursive: true })
  await writeFile(join(registry, tag, 'labels.json'), JSON.stringify(labels))
  await writeFile(
    join(registry, tag, 'index.json'),
    JSON.stringify({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [], annotations }),
  )
}

function plan() {
  const run = spawnSync('bash', [SCRIPT, tree], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, IMAGE, FAKE_REGISTRY: registry, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  })
  const out = Object.fromEntries(
    run.stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
  return { status: run.status, out, stderr: run.stderr }
}

let release: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'beliq-sevdesk-rebuild-'))
  repo = join(dir, 'repo')
  registry = join(dir, 'registry')
  tree = join(dir, 'release')
  await mkdir(join(dir, 'bin'))
  await writeFile(join(dir, 'bin', 'docker'), FAKE_DOCKER)
  await chmod(join(dir, 'bin', 'docker'), 0o755)
  await mkdir(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')

  release = await commit(
    {
      Dockerfile: dockerfile(`node:22-bookworm-slim@${OLD}`),
      '.trivyignore': '# none\n',
      'package.json': JSON.stringify({ version: '0.4.0' }),
      'worker.txt': 'as released\n',
    },
    'release 0.4.0',
  )
  git('tag', 'v0.4.0')
  await commit(
    {
      Dockerfile: dockerfile(`node:22-bookworm-slim@${NEW}`),
      'package.json': JSON.stringify({ version: '0.4.0' }),
      'worker.txt': 'unreleased change on main\n',
    },
    'base update on main',
  )
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')

  const labels = { 'org.opencontainers.image.version': '0.4.0', 'org.opencontainers.image.revision': release }
  await publish('latest', labels)
  await publish('0.4.0', labels)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('rebuild plan (real git, stand-in registry)', () => {
  it('rebuilds the release latest carries on the base main pins, and changes nothing else', async () => {
    const { status, out, stderr } = plan()
    expect(status, stderr).toBe(0)
    expect(out).toEqual({
      push: 'true',
      version: '0.4.0',
      minor: '0.4',
      commit: release,
      'base-name': 'docker.io/library/node:22-bookworm-slim',
      'base-digest': NEW,
      context: tree,
    })
    // The release's tree, with main's digest in both FROM lines.
    const built = await readFile(join(tree, 'Dockerfile'), 'utf8')
    const tagged = execFileSync('git', ['show', 'v0.4.0:Dockerfile'], { cwd: repo, encoding: 'utf8' })
    expect(built.split('\n').filter((l) => l.startsWith('FROM'))).toEqual([
      `FROM node:22-bookworm-slim@${NEW} AS builder`,
      `FROM node:22-bookworm-slim@${NEW} AS runner`,
    ])
    expect(built.split('\n').filter((l) => !l.startsWith('FROM'))).toEqual(
      tagged.split('\n').filter((l) => !l.startsWith('FROM')),
    )
    expect(await readFile(join(tree, 'worker.txt'), 'utf8')).toBe('as released\n')
  })

  it('pushes nothing when the annotation on latest names the base main pins', async () => {
    await publish(
      'latest',
      { 'org.opencontainers.image.version': '0.4.0', 'org.opencontainers.image.revision': release },
      { 'org.opencontainers.image.base.digest': NEW },
    )
    const { status, out } = plan()
    expect(status).toBe(0)
    expect(out).toEqual({ push: 'false' })
    expect(existsSync(tree)).toBe(false)
  })

  it('reads the annotation before the tag\'s Dockerfile', async () => {
    // latest was rebuilt on NEW once; main has moved on to NEWER since.
    await publish(
      'latest',
      { 'org.opencontainers.image.version': '0.4.0', 'org.opencontainers.image.revision': release },
      { 'org.opencontainers.image.base.digest': NEW },
    )
    await commit({ Dockerfile: dockerfile(`node:22-bookworm-slim@${NEWER}`) }, 'another base update')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    const { status, out } = plan()
    expect(status).toBe(0)
    expect(out['base-digest']).toBe(NEWER)
  })

  it('pushes nothing for a release image already on the base main pins', async () => {
    await commit({ Dockerfile: dockerfile(`node:22-bookworm-slim@${OLD}`) }, 'main back on the released base')
    const { status, out } = plan()
    expect(status).toBe(0)
    expect(out).toEqual({ push: 'false' })
  })

  it.each([
    [
      'main moves the base to another tag',
      async () => {
        await commit({ Dockerfile: dockerfile(`node:24-bookworm-slim@${NEW}`) }, 'node 24')
      },
      /name node:24-bookworm-slim node:24-bookworm-slim, and v0\.4\.0's name node:22-bookworm-slim node:22-bookworm-slim/,
    ],
    [
      'main names a base with no digest',
      async () => {
        await commit({ Dockerfile: dockerfile('node:22-bookworm-slim') }, 'unpinned')
      },
      /main's FROM node:22-bookworm-slim names no digest/,
    ],
    [
      'latest carries no version label',
      () => publish('latest', { 'org.opencontainers.image.revision': release }),
      /carries no X\.Y\.Z version label/,
    ],
    [
      'the X.Y.Z image does not exist',
      () => rm(join(registry, '0.4.0'), { recursive: true }),
      /says 0\.4\.0, and .*:0\.4\.0 does not exist/,
    ],
    [
      'there is no git tag for that version',
      async () => {
        git('tag', '-d', 'v0.4.0')
      },
      /there is no tag v0\.4\.0/,
    ],
    [
      'latest names another commit than the tag',
      () =>
        publish('latest', {
          'org.opencontainers.image.version': '0.4.0',
          'org.opencontainers.image.revision': '0'.repeat(40),
        }),
      /names commit 0{40}, and v0\.4\.0 is /,
    ],
  ])('refuses when %s, and prepares no tree', async (_label, arrange, message) => {
    await arrange()
    const { status, out, stderr } = plan()
    expect(status).toBe(1)
    expect(out.push).toBeUndefined()
    expect(stderr).toMatch(message)
    expect(existsSync(tree)).toBe(false)
  })

  it('refuses a release tree with no .trivyignore for the scan', async () => {
    git('tag', '-d', 'v0.4.0')
    git('checkout', '-q', release)
    git('rm', '-q', '.trivyignore')
    git('commit', '-q', '-m', 'release 0.4.0 without an ignore file')
    const commitWithout = git('rev-parse', 'HEAD')
    git('tag', 'v0.4.0')
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-edit', '-s', 'ours', commitWithout)
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    const labels = { 'org.opencontainers.image.version': '0.4.0', 'org.opencontainers.image.revision': commitWithout }
    await publish('latest', labels)
    const { status, stderr } = plan()
    expect(status).toBe(1)
    expect(stderr).toMatch(/v0\.4\.0 has no \.trivyignore, which the scan reads/)
  })

  it('refuses a release tag that is not on main', async () => {
    git('checkout', '-q', '--orphan', 'elsewhere')
    const stray = await commit({ Dockerfile: dockerfile(`node:22-bookworm-slim@${OLD}`) }, 'stray')
    git('tag', '-f', 'v0.4.0', stray)
    git('checkout', '-q', 'main')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    await publish('latest', { 'org.opencontainers.image.version': '0.4.0', 'org.opencontainers.image.revision': stray })
    const { status, stderr } = plan()
    expect(status).toBe(1)
    expect(stderr).toMatch(/v0\.4\.0 \(.+\) is not on main/)
  })
})
