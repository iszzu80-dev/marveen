import Database from '/home/iszzu/marveen/node_modules/better-sqlite3/lib/index.js'
import { storeDocument } from '/home/iszzu/marveen/dist/cos/cos-documents.js'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const db = new Database('/home/iszzu/marveen/store/claudeclaw.db')
const ROOT='/home/iszzu/marveen/store/personal-cos-drive-archive'
const mimeOf = f => f.endsWith('.pdf')?'application/pdf':f.endsWith('.jpg')?'image/jpeg':f.endsWith('.png')?'image/png':f.endsWith('.xlsx')?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':f.endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/octet-stream'
const caseIds = new Set(db.prepare("SELECT case_id FROM personal_cases").all().map(r=>r.case_id))
function walk(dir){let out=[];for(const e of readdirSync(dir)){const p=join(dir,e);statSync(p).isDirectory()?out.push(...walk(p)):out.push(p)}return out}
const files=walk(ROOT)
let linked=0, orphan=0, dup=0
for(const f of files){
  const m=f.match(/(PRI-[A-Z]+-\d{4}-\d{3})/)
  const caseId = m && caseIds.has(m[1]) ? m[1] : null
  const filename=f.split('/').pop()
  const r=storeDocument(db,{namespace:'personal',caseId,source:'drive',sourceRef:'chatgpt-cos-drive',storedPath:f,filename,mimeType:mimeOf(filename),docKind:filename.match(/\.(jpg|png)$/)?'photo':filename.includes('szamla')||filename.includes('invoice')||filename.includes('DMRV')?'invoice':'other'})
  if(r.duplicate)dup++; else if(caseId){linked++}else{orphan++}
  console.log(`${r.duplicate?'dup ':caseId?'LINK':'orph'} ${(caseId||'-').padEnd(20)} ${filename.slice(0,50)}`)
}
console.log(`\nlinked=${linked} orphan(no case)=${orphan} dup=${dup} total=${files.length}`)
console.log('cos_documents rows:', db.prepare("SELECT COUNT(*) n FROM cos_documents").get().n)
db.close()
