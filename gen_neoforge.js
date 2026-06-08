// gen_neoforge.js — HachiCrauncher 用 NeoForge プロファイル再現生成スクリプト
// 2026-06 に検証した「Helios(ForgeHosted)で NeoForge 1.21.1 を起動する」完全な解法をエンコード。
//
// 仕組み（重要）:
//  - NeoForge installer から version.json を抽出してホスト（VersionManifest）
//  - installer --installClient を headless 実行し、patched client / srg / client-extra / universal を生成
//  - version.json の libraries(47) → Type.Library（classpath:true・元URL参照）= module-path/loader 用
//  - 下記4つは Type.Library + classpath:false（=launch -cp に載せず libraryDirectory にだけ置く。
//    FML の ProductionClientProvider が libraryDirectory から game layer に積む）:
//      net.neoforged:neoforge:<VER>:universal   (neoforge mod)
//      net.neoforged:neoforge:<VER>:client      (patched minecraft classes / additional content)
//      net.minecraft:client:<MC>-<NEOFORM>:srg  (SRG minecraft classes ← これが最後の必須ピース)
//      net.minecraft:client:<MC>-<NEOFORM>:extra (client-extra resources)
//  - CurseForge instance の MOD → Type.File（mods/ 直下・FMLのmods folder locatorが拾う）
//      allowModDistribution:false の MOD は Modrinth から取得
//  - distribution.json の対象サーバーを ForgeHosted ツリーで差し替え
//
// 使い方: node gen_neoforge.js
// 必要: adm-zip, Java(=.helioslauncher/runtime から自動探索), ネットワーク
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process')
const AdmZip = require('D:/Repos/HeliosLauncher/node_modules/adm-zip')

const CFG = {
    NEO_VER: '21.1.233',
    MC_VER: '1.21.1',
    SERVER_ID: 'hachi-neoforge-1.21.1',
    SERVER_NAME: 'NeoForge鯖',
    SERVER_ADDR: '172.237.20.45:25565',
    PAGES: 'https://hachimitsuki.github.io/hachicrauncher-distro/repo',
    DISTRO_DIR: 'D:/Repos/hachicrauncher-distro',
    INSTANCE: 'C:/Users/mitsu/curseforge/minecraft/Instances/test server/minecraftinstance.json',
    WORK: 'D:/claude/neoforge_work',
    UA: 'HachiCrauncher/1.0.0'
}
const REPO = path.join(CFG.DISTRO_DIR, 'repo')
const md5 = b => crypto.createHash('md5').update(b).digest('hex')
const SLUG = { 'Entity Culling': 'entityculling', 'EntityCulling': 'entityculling' }

async function dl(url){ const r=await fetch(url,{headers:{'User-Agent':CFG.UA}}); if(!r.ok) throw new Error(`DL ${r.status} ${url}`); return Buffer.from(await r.arrayBuffer()) }
async function getJson(url){ const r=await fetch(url,{headers:{'User-Agent':CFG.UA}}); if(!r.ok) throw new Error(`JSON ${r.status} ${url}`); return r.json() }
function save(rel,buf){ const d=path.join(REPO,rel); fs.mkdirSync(path.dirname(d),{recursive:true}); fs.writeFileSync(d,buf); return buf }
function mavenPath(id){ const p=id.split(':'); const cl=p[3]?('-'+p[3]):''; return `${p[0].replace(/\./g,'/')}/${p[1]}/${p[2]}/${p[1]}-${p[2]}${cl}.jar` }
function findJava(){
    const root='C:/Users/mitsu/AppData/Roaming/.helioslauncher/runtime'
    const stack=[root]; while(stack.length){ const d=stack.pop(); let es=[]; try{es=fs.readdirSync(d,{withFileTypes:true})}catch(_){continue}
        for(const e of es){ const f=path.join(d,e.name); if(e.isDirectory()) stack.push(f); else if(e.name==='java.exe') return f } }
    return 'java'
}
// libraryDirectory に置く（=classpath:false）& ホストする1ファイル
function hostedLib(srcAbs, id, classpath){
    const rel=mavenPath(id); const buf=fs.readFileSync(srcAbs); save(path.join('lib',rel),buf)
    const m={ id, name:id, type:'Library', artifact:{ size:buf.length, MD5:md5(buf), url:`${CFG.PAGES}/lib/${rel}` } }
    if(classpath===false) m.classpath=false
    return m
}

async function main(){
    fs.mkdirSync(CFG.WORK,{recursive:true})
    const NEO=CFG.NEO_VER
    // 1) installer + version.json
    const instJar=path.join(CFG.WORK,'installer.jar')
    if(!fs.existsSync(instJar)) fs.writeFileSync(instJar, await dl(`https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEO}/neoforge-${NEO}-installer.jar`))
    const zip=new AdmZip(instJar)
    const vjText=zip.readAsText('version.json'); const vj=JSON.parse(vjText); const vjId=vj.id
    const vjBuf=save(`versions/${vjId}/${vjId}.json`, Buffer.from(vjText))
    const NEOFORM = vj.id // not used; mc-neoform parsed below
    // mc-neoform version (e.g. 1.21.1-20240808.144430) from arguments.game --fml.neoFormVersion
    const gargs=(vj.arguments&&vj.arguments.game)||[]
    const nf = gargs[gargs.indexOf('--fml.neoFormVersion')+1]
    const MCNF = `${CFG.MC_VER}-${nf}`
    console.log('version.json id', vjId, '| mc-neoform', MCNF, '| libs', vj.libraries.length)

    // 2) installer --installClient (patched client / srg / extra / universal を生成)
    const inst=path.join(CFG.WORK,'install')
    const cli=path.join(inst,'libraries/net/neoforged/neoforge',NEO,`neoforge-${NEO}-client.jar`)
    if(!fs.existsSync(cli)){
        fs.mkdirSync(inst,{recursive:true})
        fs.writeFileSync(path.join(inst,'launcher_profiles.json'),'{"profiles":{},"selectedProfile":"","clientToken":"x"}')
        const java=findJava(); console.log('java:',java,'\nrunning --installClient ...')
        cp.execFileSync(java,['-jar',instJar,'--installClient',inst],{stdio:'inherit'})
    }
    const libDir=path.join(inst,'libraries')

    // 3) version.json libraries(47) → Library (classpath:true, 元URL参照, MD5実DL)
    const libMods=[]
    for(const lib of vj.libraries){ const a=lib.downloads&&lib.downloads.artifact; if(!a||!a.url) continue
        const buf=await dl(a.url); libMods.push({ id:lib.name, name:lib.name, type:'Library', artifact:{ size:buf.length, MD5:md5(buf), url:a.url } }) }
    console.log('version.json libs hashed:', libMods.length)

    // 4) game-layer 4ファイル: classpath:false + ホスト
    const gameMods=[
        hostedLib(path.join(libDir,mavenPath(`net.neoforged:neoforge:${NEO}:universal`)), `net.neoforged:neoforge:${NEO}:universal`, false),
        hostedLib(path.join(libDir,mavenPath(`net.neoforged:neoforge:${NEO}:client`)),    `net.neoforged:neoforge:${NEO}:client`,    false),
        hostedLib(path.join(libDir,mavenPath(`net.minecraft:client:${MCNF}:srg`)),         `net.minecraft:client:${MCNF}:srg`,        false),
        hostedLib(path.join(libDir,mavenPath(`net.minecraft:client:${MCNF}:extra`)),       `net.minecraft:client:${MCNF}:extra`,      false),
    ]

    // 5) ForgeHosted 本体(artifact = universal の中身, neoforge-VER.jar = ignoreList対象なので無害)
    const uniBuf=fs.readFileSync(path.join(libDir,mavenPath(`net.neoforged:neoforge:${NEO}:universal`)))
    const forgeHosted={ id:`net.neoforged:neoforge:${NEO}`, name:`NeoForge ${NEO}`, type:'ForgeHosted',
        artifact:{ size:uniBuf.length, MD5:md5(uniBuf), url:`https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEO}/neoforge-${NEO}-universal.jar` },
        subModules:[ { id:vjId, name:'NeoForge Version Manifest', type:'VersionManifest', artifact:{ size:vjBuf.length, MD5:md5(vjBuf), url:`${CFG.PAGES}/versions/${vjId}/${vjId}.json` } }, ...libMods, ...gameMods ] }

    // 6) MOD: instance の mods/ フォルダを正として走査（CFアプリ管理外の手動MODも拾う）
    //    CFアプリ管理(installedAddons)に在れば CF/Modrinth URL 参照、無ければローカルjarを自前ホスト
    const inst2=JSON.parse(fs.readFileSync(CFG.INSTANCE,'utf8'))
    const byFile={}; for(const a of (inst2.installedAddons||[])){ const f=a.installedFile||{}; if(f.fileName) byFile[f.fileName]={url:f.downloadUrl,dist:a.allowModDistribution,name:a.name} }
    const modsDir=path.join(path.dirname(CFG.INSTANCE),'mods')
    const jars=fs.existsSync(modsDir)?fs.readdirSync(modsDir).filter(x=>x.toLowerCase().endsWith('.jar')):[]
    const modMods=[]
    for(const fname of jars){ const a=byFile[fname]||{}; let url=a.url, name=fname
        if(a.dist===false){ try{ const slug=SLUG[a.name]||fname.toLowerCase().replace(/-(neoforge|fabric|forge|mc).*/,'').replace(/[^a-z0-9]+/g,'-')
            const vs=await getJson(`https://api.modrinth.com/v2/project/${slug}/version?loaders=["neoforge"]&game_versions=["${CFG.MC_VER}"]`)
            const v=vs.find(x=>x.version_type==='release')||vs[0]; const file=v.files.find(x=>x.primary)||v.files[0]; url=file.url; name=url.split('/').pop() }catch(e){ console.log('SKIP(modrinth)',fname,e.message); continue } }
        let buf
        if(url){ buf=await dl(url) }                                                       // CF/Modrinth 参照
        else { buf=fs.readFileSync(path.join(modsDir,fname)); save(path.join('mods',fname),buf); url=`${CFG.PAGES}/mods/${fname}` }  // 手動MOD → 自前ホスト
        modMods.push({ id:`mod:${fname.replace(/[^a-z0-9]/gi,'_')}`, name:a.name||name, type:'File', artifact:{ size:buf.length, MD5:md5(buf), path:`mods/${name}`, url } }); console.log('mod ok:',name) }

    // 7) distribution.json 差し替え
    const distPath=path.join(CFG.DISTRO_DIR,'distribution.json')
    const dist=JSON.parse(fs.readFileSync(distPath,'utf8'))
    const entry={ id:CFG.SERVER_ID, name:CFG.SERVER_NAME, description:`NeoForge ${NEO} / MC ${CFG.MC_VER}`, icon:'', version:'2.0.3',
        address:CFG.SERVER_ADDR, minecraftVersion:CFG.MC_VER, discord:{shortId:CFG.SERVER_NAME,largeImageText:CFG.SERVER_NAME,largeImageKey:CFG.SERVER_ID},
        mainServer:true, autoconnect:true, modules:[forgeHosted, ...modMods] }
    const i=dist.servers.findIndex(s=>s.id===CFG.SERVER_ID); if(i>=0) dist.servers[i]=entry; else dist.servers.push(entry)
    fs.writeFileSync(distPath, JSON.stringify(dist,null,4))
    console.log(`\n✅ done. libs:${libMods.length} game:${gameMods.length} mods:${modMods.length}`)
}
main().catch(e=>{ console.error('FATAL',e); process.exit(1) })
