// gh_assets.js — 手動追加MODの jar を GitHub Release assets として配信するヘルパ
//   - git に大容量 jar をコミットしない（履歴肥大・100MB push制限を回避）
//   - 1リリース(tag=mods-host)に全 self-host MOD をアセットとしてぶら下げる
//   - distribution.json は各アセットの browser_download_url を参照する
const cp = require('child_process')
const OWNER = 'HachiMitsuki', REPO = 'hachicrauncher-distro', TAG = 'mods-host', UA = 'HachiCrauncher'
const API = `https://api.github.com/repos/${OWNER}/${REPO}`
const UP  = `https://uploads.github.com/repos/${OWNER}/${REPO}`

let _tok = null
function token(){
    if(_tok) return _tok
    if(process.env.GH_TOKEN){ return (_tok = process.env.GH_TOKEN) }
    try{
        const out = cp.execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
        const m = out.match(/^password=(.+)$/m)
        if(m) _tok = m[1].trim()
    }catch(e){ /* fallthrough */ }
    if(!_tok) throw new Error('GitHub トークン取得失敗（GH_TOKEN env か git credential helper を設定）')
    return _tok
}
const H = extra => ({ Authorization: 'Bearer ' + token(), 'User-Agent': UA, Accept: 'application/vnd.github+json', ...(extra||{}) })
const norm = s => s.replace(/[^A-Za-z0-9._-]/g, '.')   // GitHub のアセット名サニタイズ近似

let _rel = null
async function getRelease(){
    if(_rel) return _rel
    let r = await fetch(`${API}/releases/tags/${TAG}`, { headers: H() })
    if(r.ok){ _rel = await r.json(); _rel.assets = _rel.assets || []; return _rel }
    if(r.status !== 404) throw new Error('release lookup ' + r.status + ' ' + (await r.text()).slice(0,150))
    r = await fetch(`${API}/releases`, { method: 'POST', headers: H({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ tag_name: TAG, name: 'Self-hosted mod assets',
            body: '手動追加MODのホスティング用リリース。sync_mods.js が自動管理。手動編集しないこと。' }) })
    if(!r.ok) throw new Error('release create ' + r.status + ' ' + (await r.text()).slice(0,150))
    _rel = await r.json(); _rel.assets = _rel.assets || []
    return _rel
}

// jar を Release asset としてアップロードし、配信URL(browser_download_url)を返す。既存なら再利用。
async function uploadAsset(name, buf){
    const rel = await getRelease()
    const hit = (rel.assets||[]).find(a => a.name === name || norm(a.name) === norm(name))
    if(hit) return hit.browser_download_url
    const r = await fetch(`${UP}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
        { method: 'POST', headers: H({ 'Content-Type': 'application/java-archive' }), body: buf })
    if(r.status === 422){ // 既に同名アセット有り → 取り直して探す
        _rel = null
        const rel2 = await getRelease()
        const a = (rel2.assets||[]).find(a => a.name === name || norm(a.name) === norm(name))
        if(a) return a.browser_download_url
    }
    if(!r.ok) throw new Error('asset upload ' + r.status + ' ' + name + ' ' + (await r.text()).slice(0,200))
    const a = await r.json()
    rel.assets = rel.assets || []; rel.assets.push(a)
    return a.browser_download_url
}

async function deleteAsset(id){
    const r = await fetch(`${API}/releases/assets/${id}`, { method: 'DELETE', headers: H() })
    return r.status
}

module.exports = { token, getRelease, uploadAsset, deleteAsset, OWNER, REPO, TAG }
