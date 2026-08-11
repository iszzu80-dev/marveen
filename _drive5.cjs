const { chromium } = require('playwright-core'); const fs=require('fs')
;(async()=>{
 const token=fs.readFileSync('store/.dashboard-token','utf8').trim()
 const b=await chromium.launch({args:['--no-sandbox']}); const p=await b.newPage()
 const errs=[]; p.on('pageerror',e=>errs.push(e.message))
 await p.goto(`http://localhost:3420/?token=${token}`,{waitUntil:'networkidle'})
 await p.click('a[data-page="settings"]'); await p.waitForTimeout(2000)
 const tabs = await p.$$eval('#settingsTabNav *', els=>els.filter(e=>e.innerText&&e.children.length===0).map(e=>e.innerText.trim()).slice(0,15))
 console.log('settings tabs:', tabs.join(' | '))
 for (const label of tabs) {
   try {
     await p.click(`#settingsTabNav :text-is("${label}")`); await p.waitForTimeout(1200)
     const n = await p.$$eval('.autonomy-row', e=>e.length)
     if (n>0) { console.log(`TAB "${label}" -> autonomy rows: ${n}`)
       console.log('  sample:', JSON.stringify(await p.$eval('.tab-panel:not([hidden])', e=>e.innerText.trim().slice(0,220))))
       await p.screenshot({path:'/tmp/claude-1000/-home-iszzu-marveen/6ef7b177-770e-4168-a585-7cc3b5a19e26/scratchpad/autonomy.png'})
       break }
   } catch(e) {}
 }
 console.log('page errors:', errs.length?errs.slice(0,3):'none')
 await b.close()
})().catch(e=>{console.error('FAIL',e.message.slice(0,150));process.exit(1)})
