// Regenerate the committed Context Packet example (P2-B).
// Usage: npx tsx scripts/render-context-packet-example.ts
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXAMPLE_PACKET_DOC_PATH, renderExamplePacketDoc } from '../src/context-packet-example.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(repoRoot, EXAMPLE_PACKET_DOC_PATH)
writeFileSync(out, renderExamplePacketDoc())
console.log(`wrote ${EXAMPLE_PACKET_DOC_PATH}`)
