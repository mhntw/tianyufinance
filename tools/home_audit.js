// 检测 Home.js refreshHome 实际会写到哪些 DOM id，哪些在 index.html 中不存在
const fs=require('fs'),path=require('path');
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}};
global.window=global; global.navigator={sendBeacon:()=>true};
// stub document：记录所有被访问的 id
const touchedIds={}; let missing=[];
global.document={ getElementById:id=>{ touchedIds[id]=true; if(!existingIds.has(id)) missing.push(id); return null; }, addEventListener(){}, querySelector(){return null;}, querySelectorAll(){return [];} };
// 先解析 index.html 拿到真实存在的 id
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const existingIds=new Set(); let m; const re=/id="([^"]+)"/g; while((m=re.exec(html))) existingIds.add(m[1]);
global.$ = id=>{ touchedIds[id]=true; if(!existingIds.has(id)) missing.push(id); return null; };
global.fetch=()=>Promise.reject(new Error('off'));
global.XMLHttpRequest=function(){this.open=()=>{};this.setRequestHeader=()=>{};this.send=()=>{};this.status=200;};
global.addEventListener=()=>{}; global.setTimeout=setTimeout; global.clearTimeout=clearTimeout;

// 加载 store 并喂入第一个账套
require(path.join(__dirname,'..','js','store.js'));
const S=global.S;
const booksDir=path.join(__dirname,'..','data','books');
const file=fs.readdirSync(booksDir).filter(f=>f.endsWith('.json')&&!f.endsWith('.bak'))[0];
const st=JSON.parse(fs.readFileSync(path.join(booksDir,file),'utf8'));
S.state=st; S._glCache={}; S.normalizeState(); S.ensureCashFlowFields();

// 桥接层 H（最小）
const H={$:global.$,S:S,money:x=>'¥'+Number(x||0).toFixed(2),fmt:(x)=>Number(x||0).toFixed(2),signed:x=>String(x),round2:x=>Number(x||0).toFixed(2),esc:x=>x,currentPeriod:()=>{const vs=S.subjects();return null;}};
// currentPeriod：取最近凭证月
const months=[...new Set((st.vouchers||[]).map(v=>(v.date||'').slice(0,7)).filter(x=>x.length===7))].sort(); H.currentPeriod=()=>months[months.length-1]||'2026-07';

globalThis.__TY_HELPERS__=H;
// 动态导入 Home.js 并调用 refreshHome
(async()=>{
  const Home=await import('file://'+path.join(__dirname,'..','js','pages','home','Home.js')+'?v='+Date.now());
  try{ Home.refreshHome(); }catch(e){ console.log('refreshHome 抛异常:', e.message); }
  console.log('首页 refreshHome 引用的 id 总数:', Object.keys(touchedIds).length);
  console.log('其中在 index.html 中【不存在】的 id:', missing.length?missing.join(', '):'(无)');
})();
