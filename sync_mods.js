// sync_mods.js — instance の mods/ フォルダに distribution.json の MOD を一致させて push
//
// 使い方:  node sync_mods.js
//   1. CurseForge の "test server" インスタンスの mods フォルダで MOD を足す/消す/差し替える
//      (C:\Users\mitsu\curseforge\minecraft\Instances\test server\mods)
//   2. このスクリプトを実行 → 差分を検出して distribution.json を更新し、git push
//   3. プレイヤーは HachiCrauncher を再起動するだけで新しい構成に同期される
//
// 振り分け: CurseForge アプリ管理のMOD = 公式CDN(またはModrinth)参照 / 手動追加MOD = 自前ホスト(repo/mods/)
// NeoForge ローダ(ForgeHosted)や lib は触らない。MOD(Type.File)だけ同期する。
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process')
const { uploadAsset } = require('./gh_assets')   // 手動MODは GitHub Release assets にホスト
const md5 = b => crypto.createHash('md5').update(b).digest('hex')
const UA = 'HachiCrauncher'
const INST = 'C:/Users/mitsu/curseforge/minecraft/Instances/test server'
const DISTRO = path.resolve(__dirname)
const REPO = path.join(DISTRO, 'repo')
const PAGES = 'https://hachimitsuki.github.io/hachicrauncher-distro/repo'
const MC = '1.21.1'
const SID = 'hachi-neoforge-1.21.1'
const SLUG = { 'Entity Culling': 'entityculling', 'EntityCulling': 'entityculling' }  // CF再配布不可→Modrinth slug

async function dl(u){ const r = await fetch(u,{headers:{'User-Agent':UA}}); if(!r.ok) throw new Error('DL '+r.status+' '+u); return Buffer.from(await r.arrayBuffer()) }
async function getJson(u){ const r = await fetch(u,{headers:{'User-Agent':UA}}); if(!r.ok) throw new Error('JSON '+r.status); return r.json() }

async function main(){
    const modsDir = path.join(INST, 'mods')
    const jars = fs.readdirSync(modsDir).filter(x => x.toLowerCase().endsWith('.jar'))
    const inst = JSON.parse(fs.readFileSync(path.join(INST,'minecraftinstance.json'),'utf8'))
    const byFile = {}
    for(const a of (inst.installedAddons||[])){ const f=a.installedFile||{}; if(f.fileName) byFile[f.fileName]={url:f.downloadUrl, dist:a.allowModDistribution, name:a.name} }

    const distPath = path.join(DISTRO,'distribution.json')
    const dist = JSON.parse(fs.readFileSync(distPath,'utf8'))
    const srv = dist.servers.find(s=>s.id===SID)
    if(!srv){ console.error('server not found:', SID); process.exit(1) }
    const nonFile = srv.modules.filter(m=>m.type!=='File')         // ForgeHosted(loader)等は温存
    const allFile = srv.modules.filter(m=>m.type==='File')
    const isRP  = m => (m.artifact.path||'').startsWith('resourcepacks/')
    const isOpt = m => (m.artifact.path||'') === 'hachicrauncher-shared-options.txt'
    const existing = {}; for(const m of allFile) if(!isRP(m) && !isOpt(m)) existing[(m.artifact.path||'').replace('mods/','')] = m

    // ---- MOD ----
    const fileMods = []; let added = 0
    for(const fn of jars){
        if(existing[fn]){ fileMods.push(existing[fn]); continue }   // 既に配信中 → そのまま
        const a = byFile[fn] || {}; let url = a.url, name = fn
        if(a.dist===false){   // CF再配布不可 → Modrinth から取得
            try{
                const slug = SLUG[a.name] || fn.toLowerCase().replace(/-(neoforge|fabric|forge|mc).*/,'').replace(/[^a-z0-9]+/g,'-')
                const vs = await getJson(`https://api.modrinth.com/v2/project/${slug}/version?loaders=["neoforge"]&game_versions=["${MC}"]`)
                const v = vs.find(x=>x.version_type==='release')||vs[0]; const f = v.files.find(x=>x.primary)||v.files[0]
                url = f.url; name = url.split('/').pop()
            }catch(e){ console.log('SKIP(modrinth)', fn, e.message); continue }
        }
        let buf
        if(url){ buf = await dl(url) }                              // CF/Modrinth 参照
        else { buf = fs.readFileSync(path.join(modsDir,fn)); url = await uploadAsset(fn, buf); console.log('  ↳ Release asset へアップロード（git非コミット）') }  // 手動MOD → GitHub Release assets
        fileMods.push({ id:`mod:${fn.replace(/[^a-z0-9]/gi,'_')}`, name:a.name||name, type:'File', artifact:{ size:buf.length, MD5:md5(buf), path:`mods/${name}`, url } })
        console.log('+ ' + name); added++
    }
    let removed = 0
    for(const k of Object.keys(existing)) if(!jars.includes(k)){ console.log('- ' + k); removed++ }

    // ---- リソースパック (resourcepacks/*.zip → Release asset) ----
    const rpDir = path.join(INST, 'resourcepacks')
    const rpFiles = fs.existsSync(rpDir) ? fs.readdirSync(rpDir).filter(x => x.toLowerCase().endsWith('.zip')) : []
    const existingRP = {}; for(const m of allFile) if(isRP(m)) existingRP[m.artifact.path.replace('resourcepacks/','')] = m
    const rpMods = []; let rpAdded = 0, rpRemoved = 0
    for(const fn of rpFiles){
        if(existingRP[fn]){ rpMods.push(existingRP[fn]); continue }
        const buf = fs.readFileSync(path.join(rpDir, fn))
        const url = await uploadAsset(fn, buf)
        rpMods.push({ id:`rp:${fn.replace(/[^a-z0-9]/gi,'_')}`, name:fn, type:'File', artifact:{ size:buf.length, MD5:md5(buf), path:`resourcepacks/${fn}`, url } })
        console.log('+RP ' + fn); rpAdded++
    }
    for(const k of Object.keys(existingRP)) if(!rpFiles.includes(k)){ console.log('-RP ' + k); rpRemoved++ }

    // ---- 共有 options (リソパ有効化行 + キーバインド) → Release asset ----
    let sharedModule = srv.modules.find(m => m.type==='File' && isOpt(m)) || null
    let optChanged = false
    const optTxt = path.join(INST, 'options.txt')
    if(fs.existsSync(optTxt)){
        const keep = fs.readFileSync(optTxt,'utf8').split(/\r?\n/).filter(l => /^(resourcePacks:|incompatibleResourcePacks:|key_)/.test(l))
        const buf = Buffer.from(keep.join('\n') + '\n', 'utf8')
        const hash = md5(buf)
        if(!sharedModule || sharedModule.artifact.MD5 !== hash){
            const url = await uploadAsset(`shared-options-${hash.slice(0,8)}.txt`, buf)   // 内容ハッシュ付き名でURLを更新
            sharedModule = { id:'shared-options', name:'Shared options (resourcepacks + keybinds)', type:'File', artifact:{ size:buf.length, MD5:hash, path:'hachicrauncher-shared-options.txt', url } }
            console.log(`~OPTIONS 更新 (${keep.length} 行: リソパ有効化 + キーバインド)`); optChanged = true
        }
    }

    if(added+removed+rpAdded+rpRemoved+(optChanged?1:0) === 0){ console.log('変更なし。'); return }

    srv.modules = [...nonFile, ...fileMods, ...rpMods, ...(sharedModule ? [sharedModule] : [])]
    const p = (srv.version||'2.0.0').split('.'); p[2] = String(Number(p[2]||0)+1); srv.version = p.join('.')
    fs.writeFileSync(distPath, JSON.stringify(dist,null,4))
    console.log(`MOD ${fileMods.length}(+${added} -${removed}) | RP ${rpMods.length}(+${rpAdded} -${rpRemoved}) | options ${optChanged?'更新':'据置'} | v${srv.version}`)

    cp.execSync('git add -A', { cwd: DISTRO })
    cp.execSync(`git commit -m "sync m+${added}/-${removed} rp+${rpAdded}/-${rpRemoved} opt:${optChanged} v${srv.version}"`, { cwd: DISTRO, stdio: 'inherit' })
    cp.execSync('git push origin main', { cwd: DISTRO, stdio: 'inherit' })
    console.log('✅ pushed. プレイヤーは HachiCrauncher 再起動で同期される。')
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
