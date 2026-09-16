import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inlineLocalAssets } from '../src/lib/html-inline.js'

// The inliner reads files off disk in a directory the user chose, and folds what
// it reads into a document that is about to be PUBLISHED. So half of these tests
// are not about fidelity at all — they are about what it must refuse to read.

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'margins-inline-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A 1×1 transparent PNG — real bytes, so the base64 is a real encoding. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function write(rel: string, contents: string | Buffer): void {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, contents)
}

describe('inlineLocalAssets — what it folds in', () => {
  it('turns a local stylesheet into a style block', () => {
    write('css/site.css', 'body { color: rebeccapurple }')
    const html = '<html><head><link rel="stylesheet" href="css/site.css"></head><body>hi</body></html>'

    const out = inlineLocalAssets(html, dir)

    expect(out.html).toContain('<style>')
    expect(out.html).toContain('color: rebeccapurple')
    expect(out.html).not.toContain('<link')
    expect(out.inlined).toEqual([{ path: 'css/site.css', bytes: 29 }])
  })

  it('turns a local image into a data URI, keeping the rest of the tag', () => {
    write('img/logo.png', PNG)
    const html = '<img class="brand" src="img/logo.png" alt="Logo" width="32">'

    const out = inlineLocalAssets(html, dir)

    expect(out.html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`)
    // Only the attribute VALUE is replaced — the other attributes survive.
    expect(out.html).toContain('class="brand"')
    expect(out.html).toContain('alt="Logo"')
    expect(out.html).toContain('width="32"')
  })

  it("handles an inline SVG's <image href>", () => {
    write('img/logo.png', PNG)
    const out = inlineLocalAssets('<svg><image href="img/logo.png" /></svg>', dir)
    expect(out.html).toContain('data:image/png;base64,')
  })

  it('handles xlink:href and single-quoted values', () => {
    write('img/logo.png', PNG)
    const out = inlineLocalAssets("<svg><image xlink:href='img/logo.png'/></svg>", dir)
    expect(out.html).toContain('data:image/png;base64,')
    expect(out.inlined).toHaveLength(1)
  })

  it('inlines several references and reports each with its size', () => {
    write('css/a.css', 'a{}')
    write('img/one.png', PNG)
    write('img/two.png', PNG)
    const html = `<link rel="stylesheet" href="css/a.css"><img src="img/one.png"><img src="img/two.png">`

    const out = inlineLocalAssets(html, dir)

    expect(out.inlined.map((a) => a.path)).toEqual(['css/a.css', 'img/one.png', 'img/two.png'])
    expect(out.inlined[1]!.bytes).toBe(PNG.byteLength)
  })

  it('reads the file behind a ?query, without the query reaching disk', () => {
    write('css/site.css', 'h1{}')
    const out = inlineLocalAssets('<link rel="stylesheet" href="css/site.css?v=7">', dir)
    expect(out.html).toContain('h1{}')
  })

  it('escapes a </style> hiding in the CSS', () => {
    // Otherwise it closes the block we just opened and the browser renders the
    // rest of the stylesheet as visible text.
    write('css/site.css', 'p::after { content: "</style>" }')
    const out = inlineLocalAssets('<link rel="stylesheet" href="css/site.css">', dir)
    expect(out.html).not.toContain('content: "</style>"')
    expect(out.html).toContain('<\\/style')
    // Exactly one real closing tag: the one we wrote.
    expect(out.html.match(/<\/style>/g)).toHaveLength(1)
  })
})

describe('inlineLocalAssets — what it leaves alone', () => {
  it('leaves absolute, protocol-relative, data and fragment references untouched', () => {
    const html = [
      '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
      '<link rel="stylesheet" href="//cdn.example.com/y.css">',
      '<img src="data:image/gif;base64,R0lGOD">',
      '<img src="#spot">',
    ].join('')

    const out = inlineLocalAssets(html, dir)

    expect(out.html).toBe(html)
    expect(out.inlined).toHaveLength(0)
    // Remote references are not a problem to report: the server drops them and
    // the docs say so. Warning about each one would bury the real warnings.
    expect(out.warnings).toHaveLength(0)
  })

  it('leaves a non-stylesheet <link> alone', () => {
    write('img/logo.png', PNG)
    const html = '<link rel="icon" href="img/logo.png">'
    expect(inlineLocalAssets(html, dir).html).toBe(html)
  })

  it('warns and leaves the tag when the file is missing', () => {
    const html = '<img src="img/gone.png">'
    const out = inlineLocalAssets(html, dir)

    expect(out.html).toBe(html)
    expect(out.inlined).toHaveLength(0)
    expect(out.warnings.join('\n')).toMatch(/gone\.png .* not found/)
  })

  it('does not inline a reference inside an HTML comment', () => {
    write('img/logo.png', PNG)
    const html = '<!-- <img src="img/logo.png"> --><p>real</p>'

    const out = inlineLocalAssets(html, dir)

    expect(out.html).toBe(html)
    expect(out.inlined).toHaveLength(0)
  })

  it('does not inline a reference inside a <script> block', () => {
    write('img/logo.png', PNG)
    const html = `<script>var t = '<img src="img/logo.png">'</script><p>real</p>`

    const out = inlineLocalAssets(html, dir)

    expect(out.html).toBe(html)
    expect(out.inlined).toHaveLength(0)
  })

  it('does not inline a reference inside a <style> block', () => {
    write('css/site.css', 'a{}')
    const html = `<style>/* <link rel="stylesheet" href="css/site.css"> */</style>`

    const out = inlineLocalAssets(html, dir)

    expect(out.html).toBe(html)
    expect(out.inlined).toHaveLength(0)
  })

  it('still inlines real references that appear after a masked region', () => {
    // The positive control for the masking. Blanking too much would make every
    // assertion above pass for the wrong reason.
    write('img/logo.png', PNG)
    const html = '<!-- a note --><img src="img/logo.png">'

    const out = inlineLocalAssets(html, dir)

    expect(out.inlined).toHaveLength(1)
    expect(out.html).toContain('<!-- a note -->')
    expect(out.html).toContain('data:image/png;base64,')
  })
})

describe('inlineLocalAssets — what it refuses to read', () => {
  it('never reads a file kind it cannot render, however it is referenced', () => {
    // The allow-list. A crafted page in a stashed folder must not be able to
    // base64 a secret into a document that is about to be published.
    write('.env', 'MARGINS_API_KEY=sk-live-do-not-publish')
    write('notes.json', '{"private":true}')
    const html = '<img src=".env"><link rel="stylesheet" href="notes.json">'

    const out = inlineLocalAssets(html, dir)

    expect(out.html).toBe(html)
    expect(out.html).not.toContain('sk-live-do-not-publish')
    expect(out.html).not.toContain('private')
    expect(out.inlined).toHaveLength(0)
    expect(out.warnings).toHaveLength(2)
  })

  it('refuses a path that climbs out of the document folder', () => {
    const outside = mkdtempSync(join(tmpdir(), 'margins-outside-'))
    writeFileSync(join(outside, 'secret.css'), 'body{content:"stolen"}')
    try {
      const html = `<link rel="stylesheet" href="../${join(outside).split('/').pop()}/secret.css">`
      const out = inlineLocalAssets(html, dir)

      expect(out.html).not.toContain('stolen')
      expect(out.inlined).toHaveLength(0)
      expect(out.warnings.join('\n')).toMatch(/outside the document's folder|not found/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a symlink rather than following it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'margins-outside-'))
    writeFileSync(join(outside, 'secret.css'), 'body{content:"stolen"}')
    mkdirSync(join(dir, 'css'), { recursive: true })
    symlinkSync(join(outside, 'secret.css'), join(dir, 'css', 'site.css'))
    try {
      const out = inlineLocalAssets('<link rel="stylesheet" href="css/site.css">', dir)

      expect(out.html).not.toContain('stolen')
      expect(out.inlined).toHaveLength(0)
      expect(out.warnings.join('\n')).toMatch(/symlink/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses an absolute path', () => {
    const out = inlineLocalAssets('<link rel="stylesheet" href="/etc/hosts">', dir)
    expect(out.inlined).toHaveLength(0)
    expect(out.warnings.join('\n')).toMatch(/absolute path/)
  })
})
