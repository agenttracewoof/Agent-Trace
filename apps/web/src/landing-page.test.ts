import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The static home page (`apps/landing`) has no build and no tests of its own,
 * so the claims on it that the code can witness are checked here, in the gate.
 */

const landingDir = fileURLToPath(new URL('../../landing/', import.meta.url))
const page = readFileSync(`${landingDir}index.html`, 'utf8').replace(/\r\n/g, '\n')

const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

describe('the static home page', () => {
  it('shows the example the SDK README gives, word for word', () => {
    const block = /<pre id="sdk-example">([\s\S]*?)<\/pre>/.exec(page)?.[1]
    expect(block).toBeDefined()
    const [install, blank, ...code] = textOf(block ?? '').split('\n')
    expect(install).toBe('$ npm install @agenttracewoof/sdk')
    expect(blank).toBe('')

    const readme = readFileSync(
      fileURLToPath(new URL('../../../packages/sdk/README.md', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n')
    expect(code.length).toBeGreaterThan(5)
    expect(readme).toContain(code.join('\n'))
  })

  it('marks every way into sign-in, each on a line of its own, for the signup switch', () => {
    // The Pages build deletes `data-signup` lines when VITE_SIGNUP_OPEN is not
    // `true` (owner's decision 2026-10-03): a sign-in link anywhere else, or one
    // sharing its line with other markup, would survive or take that markup along.
    const lines = page.split('\n').filter((line) => line.includes('sign-in/'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line, line).toContain('data-signup')
      expect(line.trim(), line).toMatch(/^<(a|p) [^\n]*<\/(a|p)>$/)
    }
  })

  it('gives link previews an absolute image that exists', () => {
    const image = /<meta property="og:image" content="([^"]+)">/.exec(page)?.[1] ?? ''
    expect(image).toMatch(/^https:\/\/agenttracewoof\.github\.io\/Agent-Trace\/assets\/og\.png$/)
    expect(existsSync(`${landingDir}assets/og.png`)).toBe(true)
  })

  it('names only assets that are there', () => {
    const local = [...page.matchAll(/(?:src|srcset|href)="((?:assets\/)[^"]+|styles\.css)"/g)].map(
      (match) => match[1] ?? '',
    )
    expect(local.length).toBeGreaterThan(4)
    for (const path of local) expect(existsSync(`${landingDir}${path}`), path).toBe(true)
  })
})
