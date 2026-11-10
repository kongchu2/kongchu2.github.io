#!/usr/bin/env node
// Obsidian 볼트의 Blog 폴더에서 `publish: true`인 노트와, 그 노트가 쓰는 첨부 파일만 content/로 복사한다.
// content/는 매번 비우고 다시 만든다. 공개 표시가 없는 노트는 절대 저장소에 들어가지 않는다.
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const VAULT =
  process.env.VAULT ?? path.join(os.homedir(), "Library/Mobile Documents/iCloud~md~obsidian/Documents")
const SRC = path.join(VAULT, process.env.BLOG_DIR ?? "Blog")
const OUT = path.resolve(import.meta.dirname, "..", "content")
const ATTACH_DIR = "attachments"
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"])

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else out.push(p)
  }
  return out
}

function isPublished(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return !!m && /^publish:\s*["']?true["']?\s*$/m.test(m[1])
}

// ![[file.png]], ![[file.png|300]], ![alt](file.png) 중 로컬 파일만
function embeds(text) {
  const out = new Set()
  for (const m of text.matchAll(/!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) out.add(m[1].trim())
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const t = decodeURIComponent(m[1])
    if (!/^[a-z]+:\/\//i.test(t)) out.add(t)
  }
  return [...out]
}

const srcStat = await fs.stat(SRC).catch(() => null)
if (!srcStat?.isDirectory()) {
  console.error(`볼트의 블로그 폴더를 찾을 수 없음: ${SRC}`)
  process.exit(1)
}

await fs.rm(OUT, { recursive: true, force: true })
await fs.mkdir(OUT, { recursive: true })

// 첨부 파일은 볼트 전체에서 이름으로 찾는다 (Obsidian 기본 방식)
const vaultFiles = await walk(VAULT)
const byName = new Map()
for (const f of vaultFiles) {
  const n = path.basename(f)
  if (!byName.has(n)) byName.set(n, f)
}

let published = 0
let skipped = 0
const assets = new Map()
const missing = []

for (const file of await walk(SRC)) {
  if (!file.endsWith(".md")) continue
  const text = await fs.readFile(file, "utf8")
  const rel = path.relative(SRC, file)
  if (!isPublished(text)) {
    skipped++
    continue
  }
  await fs.mkdir(path.join(OUT, path.dirname(rel)), { recursive: true })
  await fs.copyFile(file, path.join(OUT, rel))
  published++
  for (const ref of embeds(text)) {
    const local = path.resolve(path.dirname(file), ref)
    const hit = (await fs.stat(local).catch(() => null))?.isFile()
      ? local
      : byName.get(path.basename(ref))
    if (!hit) missing.push(`${rel} → ${ref}`)
    else if (hit.endsWith(".md")) continue // 노트 임베드는 그 노트가 공개일 때만 보임
    else assets.set(path.basename(hit), hit)
  }
}

if (assets.size) await fs.mkdir(path.join(OUT, ATTACH_DIR), { recursive: true })
for (const [name, src] of assets) await fs.copyFile(src, path.join(OUT, ATTACH_DIR, name))

console.log(`공개 노트 ${published}개, 첨부 ${assets.size}개 복사 (비공개라 건너뜀: ${skipped}개)`)
if (missing.length) console.warn(`찾지 못한 첨부:\n  ${missing.join("\n  ")}`)
