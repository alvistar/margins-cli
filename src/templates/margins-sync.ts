/**
 * Workflow template stamped by `margins install`.
 *
 * Kept as a TypeScript template-string constant (NOT a .yml asset) so it
 * survives the tsdown bundle into the published package — a file asset would
 * be missing at runtime on the npx path, and mocked-fs tests wouldn't catch it.
 *
 * Content mirrors margins-sync-action/templates/margins-sync.yml exactly.
 *
 * NOTE on trigger paths: the `on.push.paths` extension list below is a static
 * convenience subset of the syncable types. The authoritative list of image
 * extensions the sync actually uploads is SYNCABLE_IMAGE_EXTENSIONS in
 * src/lib/image-scanner.ts (also what audit/install cap pre-checks count).
 * Rarer types (avif/ico/bmp/tiff) still sync when a listed path retriggers.
 */

export const WORKFLOW_PATH = '.github/workflows/margins-sync.yml'

export const MARGINS_SYNC_TEMPLATE = `# Margins sync — stamped by \`margins install\` (schema-version 1).
# Pushes this repo's markdown + referenced images to its Margins workspace on
# every merge to the default branch. Auth is GitHub OIDC: no secrets stored.
name: Margins sync

on:
  push:
    branches: ["__DEFAULT_BRANCH__"]
    paths:
      - "**.md"
      - "**.png"
      - "**.jpg"
      - "**.jpeg"
      - "**.svg"
      - "**.gif"
      - "**.webp"
      # Config changes must retrigger sync too:
      - ".marginsignore"
      - ".github/workflows/margins-sync.yml"
  workflow_dispatch:

# Queue, don't cancel: cancellation has a grace window in which an older run's
# in-flight 409-retry could overwrite a newer run's tree. GitHub keeps at most
# one pending run and executes in order, so the last writer is always newest.
concurrency:
  group: margins-sync-\${{ github.ref }}
  cancel-in-progress: false

permissions:
  id-token: write
  contents: read

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: alvistar/margins-sync-action@v1
        with:
          server-url: "__SERVER_URL__"
          workspace-id: "__WORKSPACE_ID__"
          schema-version: 1
`

export interface StampOptions {
  defaultBranch: string
  serverUrl: string
  workspaceId: string
}

/**
 * Stamp the template placeholders. `serverUrl` is normalized to the origin
 * (scheme + host, no trailing slash) — it doubles as the OIDC audience, which
 * the server pins as an exact string.
 */
export function stampTemplate(opts: StampOptions): string {
  const origin = new URL(opts.serverUrl).origin
  return MARGINS_SYNC_TEMPLATE
    .replaceAll('__DEFAULT_BRANCH__', opts.defaultBranch)
    .replaceAll('__SERVER_URL__', origin)
    .replaceAll('__WORKSPACE_ID__', opts.workspaceId)
}
