// HachiCrauncher 配信生成スクリプト（Fabric）
// - Modrinth API から各MODの Fabric 版を解決してDL
// - Fabric loader / version.json / 依存lib を fabricmc meta から取り込み
// - Helios distribution.json 形式で出力（repo/ にファイル実体、distribution.json にマニフェスト）
// 使い方: node generate-distro.js
// 注意: Fabric版が無いMODは自動スキップして最後に報告する（中断しない）。
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const CONFIG = {
    // GitHub Pages 配信ベース（HachiMitsuki/hachicrauncher-distro）
    baseFileUrl: 'https://hachimitsuki.github.io/hachicrauncher-distro/repo',
    outputDir: path.join(__dirname, 'repo'),
    userAgent: 'HachiCrauncher/1.0.0 (github.com/HachiMitsuki/HachiCrauncher)',
    discord: { clientId: '', smallImageText: 'HachiCrauncher', smallImageKey: 'hachi-icon' },
    servers: [
        {
            id: 'hachi-neoforge-1.21.1',
            name: 'NeoForge鯖',
            description: 'Arclight ハイブリッド (Fabricクライアントで接続)',
            address: '172.237.20.45:25565', // ← 実アドレスに差し替え
            mcVersion: '1.21.1',
            mainServer: true,
            // 元の NeoForge 13MOD の機能等価 Fabric セット
            mods: [
                { slug: 'sodium', required: true },
                { slug: 'lithium', required: true },
                { slug: 'iris', required: true },
                { slug: 'fabric-api', required: true },
                { slug: 'modernfix', required: false },
                { slug: 'ferrite-core', required: false },
                { slug: 'entityculling', required: false },
                { slug: 'immediatelyfast', required: false },
                { slug: 'badoptimizations', required: false },
                { slug: 'overflowing-bars', required: false }
            ]
        },
        {
            id: 'hachi-paper-1.21.11',
            name: 'Paper鯖',
            description: 'poe-server (Paper 1.21.11)',
            address: 'CHANGEME-paper.example.com:25565', // ← 実アドレスに差し替え
            mcVersion: '1.21.11',
            mainServer: false,
            mods: [
                { slug: 'sodium', required: true },
                { slug: 'lithium', required: true },
                { slug: 'iris', required: true },
                { slug: 'fabric-api', required: true },
                { slug: 'modernfix', required: false },
                { slug: 'ferrite-core', required: false },
                { slug: 'entityculling', required: false },
                { slug: 'immediatelyfast', required: false }
            ]
        }
    ]
}

const MODRINTH = 'https://api.modrinth.com/v2'
const FABRIC_META = 'https://meta.fabricmc.net/v2'

function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex') }

async function getJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': CONFIG.userAgent } })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
    return res.json()
}
async function download(url) {
    const res = await fetch(url, { headers: { 'User-Agent': CONFIG.userAgent } })
    if (!res.ok) throw new Error(`DL ${res.status} ${url}`)
    return Buffer.from(await res.arrayBuffer())
}
function saveFile(rel, buf) {
    const dest = path.join(CONFIG.outputDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, buf)
}
function mavenToPath(name) {
    const [g, a, v] = name.split(':')
    return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}.jar`
}

async function latestFabricLoader() {
    const loaders = await getJson(`${FABRIC_META}/versions/loader`)
    const stable = loaders.find(l => l.stable) || loaders[0]
    return stable.version
}

// Fabric loader / version.json / 依存lib をまとめた Fabric モジュールを生成（mcVersion ごと）
async function buildFabricModule(mcVersion, loaderVersion) {
    const versionJson = await getJson(`${FABRIC_META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`)
    const versionId = `${mcVersion}-fabric-${loaderVersion}`
    const vjBuf = Buffer.from(JSON.stringify(versionJson, null, 2))
    saveFile(path.join('versions', versionId, `${versionId}.json`), vjBuf)

    const loaderRel = `lib/net/fabricmc/fabric-loader/${loaderVersion}/fabric-loader-${loaderVersion}.jar`
    const loaderBuf = await download(`https://maven.fabricmc.net/net/fabricmc/fabric-loader/${loaderVersion}/fabric-loader-${loaderVersion}.jar`)
    saveFile(loaderRel, loaderBuf)

    const subModules = [{
        id: versionId,
        name: 'Fabric (version.json)',
        type: 'VersionManifest',
        artifact: { size: vjBuf.length, MD5: md5(vjBuf), url: `${CONFIG.baseFileUrl}/versions/${versionId}/${versionId}.json` }
    }]

    // Fabric 依存lib（vanilla libは url 無し & net.fabricmc以外 → Mojang側で処理されるので除外）
    for (const lib of (versionJson.libraries || [])) {
        if (!lib.url && !lib.name.startsWith('net.fabricmc')) continue
        const relPath = mavenToPath(lib.name)
        const base = (lib.url || 'https://maven.fabricmc.net/').replace(/\/$/, '')
        let buf
        try { buf = await download(`${base}/${relPath}`) }
        catch (e) {
            try { buf = await download(`https://repo1.maven.org/maven2/${relPath}`) }
            catch (e2) { console.log(`  [skip lib] ${lib.name}: ${e2.message}`); continue }
        }
        saveFile(`lib/${relPath}`, buf)
        subModules.push({
            id: lib.name,
            name: lib.name.split(':').slice(0, 2).join(':'),
            type: 'Library',
            artifact: { size: buf.length, MD5: md5(buf), url: `${CONFIG.baseFileUrl}/lib/${relPath}` }
        })
    }

    return {
        id: `net.fabricmc:fabric-loader:${loaderVersion}`,
        name: `Fabric Loader ${loaderVersion}`,
        type: 'Fabric',
        artifact: { size: loaderBuf.length, MD5: md5(loaderBuf), url: `${CONFIG.baseFileUrl}/${loaderRel}` },
        subModules
    }
}

async function resolveMod(slug, mcVersion) {
    const versions = await getJson(`${MODRINTH}/project/${slug}/version?loaders=["fabric"]&game_versions=["${mcVersion}"]`)
    if (!versions.length) throw new Error('Fabric版なし')
    const v = versions.find(x => x.version_type === 'release') || versions[0]
    const file = v.files.find(f => f.primary) || v.files[0]
    return { version: v, file }
}

async function main() {
    console.log('=== HachiCrauncher distro generator (Fabric) ===\n')
    const loaderVersion = await latestFabricLoader()
    console.log(`Fabric loader: ${loaderVersion}\n`)

    const fabricCache = {}
    const summary = []
    const servers = []

    for (const srv of CONFIG.servers) {
        console.log(`--- ${srv.name} (${srv.id}) MC ${srv.mcVersion} ---`)
        if (!fabricCache[srv.mcVersion]) {
            fabricCache[srv.mcVersion] = await buildFabricModule(srv.mcVersion, loaderVersion)
        }
        const fabricModule = JSON.parse(JSON.stringify(fabricCache[srv.mcVersion]))

        for (const mod of srv.mods) {
            try {
                const { version, file } = await resolveMod(mod.slug, srv.mcVersion)
                const buf = await download(file.url)
                saveFile(path.join('mods', 'fabric', file.filename), buf)
                fabricModule.subModules.push({
                    id: `${mod.slug}:${mod.slug}:${version.version_number}@jar`,
                    name: mod.slug,
                    type: 'FabricMod',
                    required: { value: mod.required, def: true },
                    artifact: { size: buf.length, MD5: md5(buf), path: file.filename, url: `${CONFIG.baseFileUrl}/mods/fabric/${file.filename}` }
                })
                console.log(`  [ok]   ${mod.slug} -> ${file.filename}`)
                summary.push(`${srv.id}\tok\t${mod.slug}\t${file.filename}`)
            } catch (e) {
                console.log(`  [SKIP] ${mod.slug}: ${e.message}`)
                summary.push(`${srv.id}\tSKIP\t${mod.slug}\t${e.message}`)
            }
        }

        servers.push({
            id: srv.id,
            name: srv.name,
            description: srv.description,
            icon: '',
            version: '1.0.0',
            address: srv.address,
            minecraftVersion: srv.mcVersion,
            discord: { shortId: srv.name, largeImageText: srv.name, largeImageKey: srv.id },
            mainServer: !!srv.mainServer,
            autoconnect: true,
            modules: [fabricModule]
        })
        console.log('')
    }

    const distribution = { version: '1.0.0', discord: CONFIG.discord, rss: '', servers }
    fs.writeFileSync(path.join(__dirname, 'distribution.json'), JSON.stringify(distribution, null, 4))

    console.log('=== SUMMARY ===')
    summary.forEach(s => console.log(s))
    console.log('\n✅ distribution.json + repo/ を生成しました。')
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
