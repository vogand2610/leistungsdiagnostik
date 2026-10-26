import uebungenStart from './data/uebungen.json';
import {localStore} from './store.js';
import {readLegacyHtml} from './legacy.js';
import {cloud,cloudConfigured} from './cloud.js';

const TESTS=[
  {key:'sprung', name:'Standweitsprung', short:'Sprung', unit:'cm', dir:1, w:.20, area:'Sprungkraft'},
  {key:'shuttle',name:'Shuttle-Run', short:'Shuttle', unit:'min:s', dir:1, w:.10, time:true, area:'Ausdauer'},
  {key:'liege',  name:'Liegestütze', short:'Liegestütze', unit:'Anzahl', dir:1, w:.25, area:'Kraft'},
  {key:'wurf',   name:'Schlagwurf', short:'Wurf', unit:'km/h', dir:1, w:.20, area:'Wurf'},
  {key:'sprint', name:'20-m-Sprint', short:'Sprint', unit:'s', dir:-1, w:.25, dec:2, area:'Schnelligkeit'}
];
const RUMPF='Rumpf & Prävention';
/* Material: "Ball, Tor" = beides nötig; "Bank / Stuhl" oder "Kurz- oder Langhantel" = eines davon reicht */
const MAT_ALIAS={'kurzhanteln':'Kurzhantel','kettlebells':'Kettlebell','tore':'Tor','bälle':'Ball','ballgrößen':'Ball','markierungen':'Markierung','tennisbälle':'Tennisball','bänder':'Band'};
function canonMat(x){
  x=String(x).replace(/\(.*?\)/g,'').replace(/\d+([,.–-]\d+)?\s*kg/gi,'').replace(/^\d+\s+/,'').trim();
  if(!x||/^[–\-]+$/.test(x))return null;
  const k=x.toLowerCase();return MAT_ALIAS[k]||x.charAt(0).toUpperCase()+x.slice(1);
}
function matGroups(s){
  s=String(s||'').replace(/Kurz-\s*oder\s*Langhantel/i,'Kurzhantel / Langhantel');
  return s.split(/[,;+]|\s+und\s+/i).map(g=>g.split(/\s*\/\s*|\s+oder\s+/i).map(canonMat).filter(Boolean)).filter(g=>g.length);
}
function allMaterials(){const c={};DB.uebungen.forEach(e=>matGroups(e.material).flat().forEach(m=>c[m]=(c[m]||0)+1));
  return Object.keys(c).sort((a,b)=>c[b]-c[a]||a.localeCompare(b,'de')).map(m=>({m,n:c[m]}));}
function matOk(e,fehlt){return matGroups(e.material).every(g=>g.some(m=>!fehlt.has(m)));}
function halleById(id){return (DB.settings.hallen||[]).find(h=>h.id===id)||null;}
function fehltSet(id){const h=halleById(id);return new Set(h?h.fehlt:[]);}
function allBereiche(){return TESTS.map(t=>t.name).concat([RUMPF],(DB&&DB.settings.bereicheExtra)||[]);}
function addBereich(n){n=String(n||'').trim();if(!n||allBereiche().includes(n))return n;DB.settings.bereicheExtra.push(n);return n;}
const AKS=['E-Jugend','D-Jugend','C-Jugend','B-Jugend','A-Jugend','Aktive'];
const ORTE=['Zuhause','Halle/Platz','Fitnessstudio'];
const NIVEAUS=['Einsteiger','Fortgeschritten'];
/* DHB-Orientierungswerte Mädchen (Manual zur DHB-Sichtung 2025). Grenzen: weit über, über, durchschnittlich, unter. Shuttle in Sekunden. */
const NORMS={
  '13-15':{sprung:[231,215,184,168],shuttle:[683,615,445,362],liege:[36,26,10,3],wurf:[80,73,61,56],sprint:[3.07,3.23,3.53,3.71]},
  '15':   {sprung:[231,216,185,170],shuttle:[688,616,445,362],liege:[35,26,10,3],wurf:[80,73,62,58],sprint:[3.09,3.22,3.51,3.65]}
};
const CATS=['weit überdurchschnittlich','überdurchschnittlich','durchschnittlich','unterdurchschnittlich','weit unterdurchschnittlich'];
const CATS_SHORT=['weit über','über','Durchschnitt','unter','weit unter'];

let DB=null;
let dirty=false, saveErr=false, persisted=false, saveChain=Promise.resolve(), installPrompt=null;
/* Online-Mannschaft: team = Id auf dem Server (= meta.fileId), base = Server-Version des lokalen Stands */
const SYNC={team:null,name:'',role:null,base:0,pending:false,status:'',at:null};
let syncBusy=null, master=null, localTeams=[], ME=null;
const shareCache=new Map(), shareKeys=new Map();
const SEC={key:null,salt:null,pw:null};
const ui={tab:'team', pid:null, teamJg:new Set(), teamSort:'score',
  tt:{monat:thisMonth(), name:'', test:'sprung', jg:new Set(), vals:{}},
  tr:{sub:'plan', s1:'auto', s2:'auto', extra:'', halle:'', niveau:'alle', ort:'alle', variante:1, ak:'auto'},
  tp:{jg:new Set(), format:'integriert', ort:'auto', variante:1, halle:''}, matEdit:null, cmp:'',
  lib:{q:'', bereich:'', niveau:'', ort:'', ak:'', open:null}, mEmail:'',
  me:{dauer:30, ort:'alle', variante:1, fokus:'auto'}};

/* ---------- Hilfsfunktionen ---------- */
const $=(s,r=document)=>r.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const T=k=>TESTS.find(t=>t.key===k);
const TN=n=>TESTS.find(t=>t.name===n);
function thisMonth(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
function monthLabel(m){if(!m)return '–';const [y,mo]=m.split('-');return mo+'.'+y;}
function fmt(t,v){
  if(v==null||v==='')return '–';
  if(t.time){const s=Math.round(v);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
  if(t.dec)return v.toFixed(t.dec).replace('.',',');
  return String(Math.round(v*10)/10).replace('.',',');
}
function fmtDiff(t,d){
  d=Math.abs(d);
  if(t.time){const s=Math.ceil(d);return s>=60?Math.floor(s/60)+':'+String(s%60).padStart(2,'0')+' min':s+' s';}
  if(t.dec)return d.toFixed(2).replace('.',',')+' s';
  return Math.ceil(d)+' '+(t.key==='liege'?'Wdh.':t.unit);
}
function parseVal(t,str){
  str=String(str==null?'':str).trim().replace(',','.');
  if(!str)return null;
  if(t.time){
    const m=str.match(/^(\d{1,2})[:.](\d{1,2})$/);
    if(m){const s=+m[2];return s<60?(+m[1])*60+s:NaN;}
    return /^\d+$/.test(str)?+str:NaN;
  }
  const n=Number(str);return isFinite(n)&&n>=0?n:NaN;
}
function seasonYear(d){d=d||new Date();return d.getMonth()>=6?d.getFullYear():d.getFullYear()-1;}
function ageClass(jg){
  if(!jg)return '–';const a=seasonYear()-jg;
  if(a<=8)return 'F-Jugend';if(a<=10)return 'E-Jugend';if(a<=12)return 'D-Jugend';
  if(a<=14)return 'C-Jugend';if(a<=16)return 'B-Jugend';if(a<=18)return 'A-Jugend';return 'Aktive';
}
function akIdx(ak){const i=AKS.indexOf(ak);return i<0?0:i;}
function age(geb){if(!geb)return null;const b=new Date(geb),n=new Date();let a=n.getFullYear()-b.getFullYear();if(n.getMonth()<b.getMonth()||(n.getMonth()===b.getMonth()&&n.getDate()<b.getDate()))a--;return a;}
function normKey(p){return ['B-Jugend','A-Jugend','Aktive'].includes(ageClass(p.jahrgang))?'15':'13-15';}
function th(t,p){return NORMS[normKey(p)][t.key];}
function cat(t,v,p){
  if(v==null)return null;const u=t.dir*v,b=th(t,p);
  for(let i=0;i<4;i++)if(u>=t.dir*b[i]-1e-9)return i+1;
  return 5;
}
function score(t,v,p){
  if(v==null)return null;
  const [a,b,c,d]=th(t,p).map(x=>t.dir*x),u=t.dir*v;
  if(u>=a)return Math.min(100,80+20*(u-a)/(a-b));
  if(u>=b)return 60+20*(u-b)/(a-b);
  if(u>=c)return 40+20*(u-c)/(b-c);
  if(u>=d)return 20+20*(u-d)/(c-d);
  return Math.max(0,20-20*(d-u)/(c-d));
}
const scoreCat=s=>s==null?null:s>=80?1:s>=60?2:s>=40?3:s>=20?4:5;
const pById=id=>DB.players.find(p=>p.id===id);
const byName=(a,b)=>a.name.localeCompare(b.name,'de');
function mOf(pid){return DB.messungen.filter(m=>m.pid===pid).sort((a,b)=>a.monat.localeCompare(b.monat));}
function series(pid,k){return mOf(pid).filter(m=>m.w&&m.w[k]!=null).map(m=>({monat:m.monat,name:m.name,v:m.w[k]}));}
function lastOf(pid,k){const s=series(pid,k);return s[s.length-1]||null;}
function prevOf(pid,k){const s=series(pid,k);return s.length>1?s[s.length-2]:null;}
function firstOf(pid,k){return series(pid,k)[0]||null;}
function bestOf(pid,k){const t=T(k);let b=null;series(pid,k).forEach(x=>{if(b==null||t.dir*x.v>t.dir*b)b=x.v;});return b;}
function total(p){
  let sw=0,ss=0,n=0;
  TESTS.forEach(t=>{const l=lastOf(p.id,t.key);if(l){ss+=score(t,l.v,p)*t.w;sw+=t.w;n++;}});
  return n?{score:ss/sw,n}:null;
}
function rankInJg(p,t){
  const l=lastOf(p.id,t.key);if(!l)return null;
  const peers=DB.players.filter(x=>x.jahrgang===p.jahrgang).map(x=>lastOf(x.id,t.key)).filter(Boolean);
  return {rank:1+peers.filter(x=>t.dir*x.v>t.dir*l.v).length,n:peers.length};
}
function lastTest(pid){const ms=mOf(pid).filter(m=>TESTS.some(t=>m.w&&m.w[t.key]!=null));return ms.length?ms[ms.length-1].monat:null;}
function daysSince(monat){if(!monat)return null;const [y,m]=monat.split('-').map(Number);return Math.floor((Date.now()-new Date(y,m-1,15))/864e5);}
function initials(n){const parts=String(n).split(',').map(s=>s.trim()).filter(Boolean);return ((parts[1]||'')[0]||'')+((parts[0]||'')[0]||'');}
function avatar(p,cls){return p.foto?`<img class="${cls}" src="${esc(p.foto)}" alt="">`:`<div class="${cls}" aria-hidden="true">${esc(initials(p.name))}</div>`;}
function chip(c,short){return c?`<span class="chip c${c}">${(short?CATS_SHORT:CATS)[c-1]}</span>`:'<span class="chip plain">kein Wert</span>';}
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),2800);}
function opt(v,label,sel){return `<option value="${esc(v)}" ${String(v)===String(sel)?'selected':''}>${esc(label==null?v:label)}</option>`;}
/* reproduzierbarer Zufall für „Varianten“ */
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function rng(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function shuffled(arr,seed){const r=rng(hash(seed)),a=arr.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

/* ---------- Verschlüsselung (optional) ---------- */
const CRYPTO_OK=!!(window.crypto&&crypto.subtle&&window.TextEncoder);
const enc=new TextEncoder(),dec=new TextDecoder();
function b64(buf){const b=new Uint8Array(buf);let s='';for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));return btoa(s);}
function unb64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function deriveKey(pw,salt){
  const base=await crypto.subtle.importKey('raw',enc.encode(pw),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:250000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function encryptDB(obj){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},SEC.key,enc.encode(JSON.stringify(obj)));
  return {enc:1,kdf:'PBKDF2-SHA256-250000/AES-GCM',salt:b64(SEC.salt),iv:b64(iv),ct:b64(ct),fileId:obj.meta.fileId,rev:obj.meta.rev,updated:obj.meta.updated,theme:obj.settings.theme};
}
async function decryptWrap(w,pw){
  const salt=unb64(w.salt),key=await deriveKey(pw,salt);
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(w.iv)},key,unb64(w.ct));
  return {db:JSON.parse(dec.decode(pt)),key,salt};
}
async function setPassword(pw){
  SEC.salt=crypto.getRandomValues(new Uint8Array(16));SEC.key=await deriveKey(pw,SEC.salt);SEC.pw=pw;
}
const hex=buf=>[...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,'0')).join('');
/* Nachweis fürs Verbinden: aus Passwort und Mannschaftsname abgeleitet, unabhängig vom Datenschlüssel.
   Der Server speichert davon nur einen bcrypt-Hash. */
async function joinProof(pw,name){
  const base=await crypto.subtle.importKey('raw',enc.encode(pw),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode('ld-join-v1:'+String(name).trim().toLowerCase()),iterations:250000,hash:'SHA-256'},base,256));
}
/* Zugangscodes für Spielerinnen: 10 Zeichen aus 32 (50 Bit), ohne verwechselbare Zeichen */
const CODE_ABC='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(){const s=[...crypto.getRandomValues(new Uint8Array(10))].map(x=>CODE_ABC[x&31]).join('');return s.slice(0,5)+'-'+s.slice(5);}
const normCode=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
async function lookupOf(code){return hex(await crypto.subtle.digest('SHA-256',enc.encode('ld-lookup-v1:'+normCode(code))));}
async function shareKey(code){
  const c=normCode(code);
  if(!shareKeys.has(c)){const base=await crypto.subtle.importKey('raw',enc.encode(c),'PBKDF2',false,['deriveKey']);
    shareKeys.set(c,await crypto.subtle.deriveKey({name:'PBKDF2',salt:enc.encode('ld-share-v1'),iterations:150000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']));}
  return shareKeys.get(c);
}
async function sealWith(key,obj){const iv=crypto.getRandomValues(new Uint8Array(12));return {iv:b64(iv),ct:b64(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(JSON.stringify(obj))))};}
async function openWith(key,w){return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(w.iv)},key,unb64(w.ct))));}

/* ---------- Speichern: jede Änderung landet automatisch im Gerätespeicher ---------- */
async function payload(){return SEC.key?await encryptDB(DB):DB;}
function changed(){
  if(ME)return;
  DB.meta.updated=new Date().toISOString();
  dirty=true;updateState();
  clearTimeout(changed.t);changed.t=setTimeout(persist,400);
}
function persist(){
  clearTimeout(changed.t);
  saveChain=saveChain.then(async()=>{
    if(!dirty||!DB||ME)return;dirty=false;
    try{DB.meta.rev=(DB.meta.rev||0)+1;await localStore.save(DB.meta.fileId,await payload(),label());saveErr=false;
      if(SYNC.team){SYNC.pending=true;await saveSync();schedulePush();}}
    catch(e){console.error(e);dirty=true;saveErr=true;}
    updateState();
  });
  return saveChain;
}
const label=()=>DB.settings.mannschaft||SYNC.name||DB.settings.verein||'Mannschaft';

/* ---------- Abgleich mit der Online-Mannschaft ---------- */
async function saveSync(){
  if(DB)await localStore.setSyncState(DB.meta.fileId,SYNC.team?{team:SYNC.team,name:SYNC.name,role:SYNC.role,base:SYNC.base,pending:SYNC.pending}:null);
}
function setSync(st){SYNC.status=st;if(st==='ok')SYNC.at=new Date();updateState();}
function schedulePush(ms){clearTimeout(schedulePush.t);schedulePush.t=setTimeout(syncNow,ms==null?2000:ms);}
function cloudMsg(e){
  const m=String(e&&e.message||'');
  if(!navigator.onLine||/fetch|network/i.test(m))return 'Keine Verbindung zum Server.';
  if(/anonymous/i.test(m))return 'Die anonyme Anmeldung ist in Supabase noch nicht aktiviert.';
  if(/Signups not allowed|not found|Invalid login/i.test(m))return 'Für diese E-Mail-Adresse gibt es kein Konto.';
  return 'Online-Dienst meldet einen Fehler: '+m;
}
/* Holt neuere Stände vom Server und schickt eigene Änderungen. Bei gleichzeitigen Änderungen
   entscheidet die Nutzerin bzw. der Nutzer, welcher Stand gilt. */
async function syncNow(){
  if(!SYNC.team||!DB||ME)return;
  if(syncBusy)return syncBusy;
  syncBusy=(async()=>{
    if(!navigator.onLine){setSync('offline');return;}
    setSync('busy');
    try{
      await saveChain;
      const rev=await cloud.rev(SYNC.team);
      if(rev!=null&&rev!==SYNC.base){
        const r=await cloud.pull(SYNC.team);
        if(!SYNC.pending||!keepLocal()){await adopt(r);return;}
        SYNC.base=r.rev;
      }
      await applyPlayerUpdates();
      if(SYNC.pending||rev==null){
        const mark=DB.meta.rev,res=await cloud.push(SYNC.team,rev==null?0:SYNC.base,await payload());
        if(res.conflict){setSync('busy');schedulePush(500);return;}
        SYNC.base=res.rev;if(DB.meta.rev===mark)SYNC.pending=false;
        await saveSync();
      }
      await publishShares();
      setSync('ok');
    }catch(e){console.error(e);setSync(navigator.onLine?'error':'offline');}
  })();
  try{await syncBusy;}finally{syncBusy=null;}
  if(SYNC.pending&&SYNC.status==='ok')schedulePush();
}
function keepLocal(){
  return !confirm('Die Mannschaft wurde auf einem anderen Gerät geändert, während hier auch Änderungen offen sind.\n\nOK: Stand vom anderen Gerät übernehmen (die Änderungen hier gehen verloren).\nAbbrechen: Änderungen von diesem Gerät behalten (überschreibt den anderen Stand).');
}
async function adopt(r){
  let d=r.payload,res=null;
  if(d&&d.enc){
    if(SEC.pw)try{res=await decryptWrap(d,SEC.pw);res.pw=SEC.pw;}catch(e){}
    while(!res){const pw=prompt('Das Mannschaftspasswort wurde geändert. Bitte das neue Passwort eingeben:');if(!pw){setSync('locked');return;}
      try{res=await decryptWrap(d,pw);res.pw=pw;}catch(e){toast('Passwort falsch.');}}
    SEC.key=res.key;SEC.salt=res.salt;SEC.pw=res.pw;d=res.db;
  }
  DB=normalize(d);DB.meta.fileId=SYNC.team;SYNC.base=r.rev;SYNC.pending=false;
  await localStore.save(DB.meta.fileId,await payload(),label());await saveSync();
  shareCache.clear();render();setSync('ok');
}
/* Freigaben: je Spielerin mit Code ein eigener Auszug, verschlüsselt mit ihrem Code */
async function publishShares(){
  if(SYNC.role!=='owner'&&SYNC.role!=='trainer')return;
  const rows=[],keep=[];
  for(const p of DB.players.filter(p=>p.code)){
    const lk=await lookupOf(p.code),data=sharePayload(p),sig=JSON.stringify(data);keep.push(lk);
    if(shareCache.get(lk)!==sig)rows.push({lookup:lk,data:await sealWith(await shareKey(p.code),data),sig});
  }
  await cloud.putShares(SYNC.team,rows);rows.forEach(r=>shareCache.set(r.lookup,r.sig));
  const ks=keep.join('|');if(shareCache.get('#keep')!==ks){await cloud.pruneShares(SYNC.team,keep);shareCache.set('#keep',ks);}
}
function sharePayload(p){
  const s=DB.settings,plan=planSections(p,PLAN_AUTO);
  const fokus=plan.secs.filter(x=>x.title.startsWith('Schwerpunkt')).map(x=>x.b);
  const akMax=akIdx(playerAk(p)),young=akMax<=2,pools={},exs=[];
  allBereiche().forEach(b=>{
    pools[b]=pickEx(b,{akMax,niveau:'alle',orte:null,ortPrio:young?['Zuhause','Halle/Platz','Fitnessstudio']:['Fitnessstudio','Zuhause','Halle/Platz'],seed:p.id+'|share',n:ME_POOL}).list.map(e=>{if(!exs.includes(e))exs.push(e);return e.nr;});
  });
  return {v:2,settings:{verein:s.verein,mannschaft:s.mannschaft,logoVerein:s.logoVerein,logoTeam:s.logoTeam,theme:s.theme},
    player:{id:p.id,name:p.name,jahrgang:p.jahrgang,geb:p.geb,position:p.position,foto:p.foto,edited:p.edited||''},
    messungen:mOf(p.id).map(m=>({id:m.id,pid:p.id,monat:m.monat,name:m.name,w:m.w})),
    fokus,pools,
    uebungen:exs.map(e=>Object.assign({},e,{videos:(e.videos||[]).filter(v=>v.typ==='link')}))};
}
/* Aenderungen von Spielerinnen (Geburtstag, Foto) übernehmen; verschlüsselt mit ihrem Code */
const validGeb=g=>g===''||(/^\d{4}-\d{2}-\d{2}$/.test(g)&&+g.slice(0,4)>=1950&&+g.slice(0,4)<=new Date().getFullYear());
const validFoto=f=>f===''||(/^data:image\/(jpeg|png|webp);base64,/.test(f)&&f.length<200000);
async function applyPlayerUpdates(){
  const rows=await cloud.playerUpdates(SYNC.team);if(!rows.length)return;
  const byLk=new Map();for(const p of DB.players.filter(p=>p.code))byLk.set(await lookupOf(p.code),p);
  let n=0;
  for(const r of rows){
    const p=byLk.get(r.lookup);
    if(p)try{const u=await openWith(await shareKey(p.code),r.data);
      if(u&&u.at&&(!p.edited||u.at>p.edited)){
        if(typeof u.geb==='string'&&validGeb(u.geb)){p.geb=u.geb;if(u.geb)p.jahrgang=+u.geb.slice(0,4);}
        if(typeof u.foto==='string'&&validFoto(u.foto))p.foto=u.foto;
        p.edited=u.at;n++;}}
      catch(e){console.error(e);}
    await cloud.deleteUpdate(r.lookup,r.created_at);
  }
  if(n){changed();await persist();render();toast(n+(n>1?' Änderungen':' Änderung')+' von Spielerinnen übernommen.');}
}
async function refreshAccount(){
  master=null;
  if(!cloudConfigured||!navigator.onLine)return;
  try{if(!localStorage.getItem('ld-auth'))return;}catch(e){return;}
  try{const u=await cloud.user();if(u&&!u.is_anonymous&&await cloud.isMaster())master=u.email||'Master';}catch(e){console.error(e);}
}
async function refreshLocalTeams(){try{localTeams=await localStore.list();}catch(e){localTeams=[];}}
async function connectTeam(name,pw){
  if(!navigator.onLine){toast('Zum Verbinden wird eine Internetverbindung gebraucht.');return;}
  toast('Verbinde …');
  try{
    await cloud.ensureUser();
    const r=await cloud.joinTeam(name,await joinProof(pw,name));
    if(!r||!r.ok){toast(r&&r.reason==='gesperrt'?'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.':'Mannschaftsname oder Passwort falsch.');return;}
    const d=await cloud.pull(r.team_id);
    if(!d){toast('Die Mannschaft hat noch keine Daten. Der Master muss sie zuerst einmal abgleichen.');return;}
    const res=d.payload.enc?await decryptWrap(d.payload,pw):{db:d.payload,key:null,salt:null};
    await persist();
    SEC.key=res.key;SEC.salt=res.salt;SEC.pw=res.key?pw:null;
    DB=normalize(res.db);DB.meta.fileId=r.team_id;
    Object.assign(SYNC,{team:r.team_id,name:r.name,role:r.role,base:d.rev,pending:false});
    await localStore.save(DB.meta.fileId,await payload(),label());await saveSync();
    shareCache.clear();$('#bannerSlot').innerHTML='';ui.pid=null;setSync('ok');go('team');
    toast('Verbunden mit „'+r.name+'“.');refreshLocalTeams();
  }catch(e){console.error(e);toast(/decrypt|OperationError/i.test(String(e&&e.name)+e)?'Die Daten ließen sich mit diesem Passwort nicht entschlüsseln.':cloudMsg(e));}
}

function updateState(){
  const s=$('#state');
  s.textContent=saveErr?'Speichern fehlgeschlagen':dirty?'Wird gespeichert …':(SEC.key?'Gespeichert, verschlüsselt':'Gespeichert');
  s.className='pill'+(saveErr||dirty?' dirty':SEC.key?' lock':'');
  $('#lockBtn').hidden=!SEC.key;
  const y=$('#sync'),st=SYNC.status;y.hidden=!SYNC.team;
  y.textContent=st==='busy'?'Abgleich …':st==='offline'?(SYNC.pending?'Offline, wird später abgeglichen':'Offline'):st==='error'?'Abgleich fehlgeschlagen':st==='locked'?'Passwort nötig':SYNC.pending?'Wartet auf Abgleich':'Abgeglichen';
  y.className='pill'+(st==='error'||st==='locked'||st==='offline'?' dirty':'');
  y.title=SYNC.at?'Zuletzt abgeglichen '+SYNC.at.toLocaleTimeString('de-DE'):'';
}
function downloadBlob(content,name,type){
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;
  document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);
}

/* ---------- Bilder ---------- */
function loadImg(file){return new Promise((res,rej)=>{const img=new Image(),url=URL.createObjectURL(file);img.onload=()=>{URL.revokeObjectURL(url);res(img);};img.onerror=()=>{URL.revokeObjectURL(url);rej();};img.src=url;});}
async function readSquare(file,S){
  const img=await loadImg(file),s=Math.min(img.width,img.height),c=document.createElement('canvas');c.width=c.height=S;
  c.getContext('2d').drawImage(img,(img.width-s)/2,(img.height-s)/2,s,s,0,0,S,S);return c.toDataURL('image/jpeg',.82);
}
async function readFit(file,max,png){
  if(file.type==='image/svg+xml'&&file.size<150000)return await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(file);});
  const img=await loadImg(file),k=Math.min(1,max/Math.max(img.width,img.height)),c=document.createElement('canvas');
  c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);c.getContext('2d').drawImage(img,0,0,c.width,c.height);
  return png?c.toDataURL('image/png'):c.toDataURL('image/jpeg',.8);
}
function pickFile(accept){
  return new Promise(res=>{const f=$('#filePick');f.value='';f.multiple=false;f.accept=accept;f.onchange=()=>res(f.files[0]||null);f.click();});
}
function readDataURL(file){return new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(file);});}
const isHttp=u=>/^https?:\/\/\S+$/i.test(String(u||'').trim());
function mb(n){return (n/1048576).toFixed(1).replace('.',',')+' MB';}
function applyTheme(){
  const t=(DB&&DB.settings.theme)||'hell';document.documentElement.dataset.theme=t;
  const dark=t==='dunkel'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
  const b=$('#themeBtn');if(b)b.textContent=dark?'Hell':'Dunkel';
}
function openMedia(title,html){
  const d=$('#media');d.innerHTML=`<div class="mbar"><span>${esc(title)}</span><button data-act="closeMedia">Schließen</button></div>${html}`;
  if(d.showModal)d.showModal();else d.setAttribute('open','');
}

/* ---------- Ansichten ---------- */
const VIEWS={team:renderTeam,profil:renderProfil,testtag:renderTesttag,training:renderTraining,kader:renderKader,daten:renderDaten,me:renderProfil};
const VIEW_TITLES={team:'Teamübersicht',profil:'Spielerinnenprofil',testtag:'Testtag',training:'Training',kader:'Kader',daten:'Daten',me:'Meine Werte'};
function logosHtml(){
  const s=DB.settings,l=[];
  if(s.logoVerein)l.push(`<img src="${esc(s.logoVerein)}" alt="Vereinslogo">`);
  if(s.logoTeam)l.push(`<img src="${esc(s.logoTeam)}" alt="Mannschaftslogo">`);
  return l.join('');
}
function subtitle(){return [DB.settings.verein,DB.settings.mannschaft].filter(Boolean).join(', ');}
function render(){
  applyTheme();
  $('#logos').innerHTML=logosHtml();
  $('#subtitle').textContent=subtitle();
  document.title='Leistungsdiagnostik'+(subtitle()?' – '+subtitle():'');
  document.querySelectorAll('#tabs button').forEach(b=>b.setAttribute('aria-current',b.dataset.tab===ui.tab?'true':'false'));
  let ttl=VIEW_TITLES[ui.tab];
  if((ui.tab==='profil'||ui.tab==='me')&&pById(ui.pid))ttl+=': '+pById(ui.pid).name;
  if(ui.tab==='training')ttl=ui.tr.sub==='plan'?'Trainingsplan'+(pById(ui.pid)?': '+pById(ui.pid).name:''):ui.tr.sub==='team'?'Teamprogramm':'Übungsbibliothek';
  $('#printHead').innerHTML=`${logosHtml()}<div><h1>${esc(ttl)}</h1><div>${esc(subtitle())}${subtitle()?', ':''}Stand ${new Date().toLocaleDateString('de-DE')}</div></div>`;
  $('#view').innerHTML=VIEWS[ui.tab]();
  if(ui.tab==='testtag')refreshTTFeedback();
  fitList();
}
function go(tab,pid){ui.tab=tab;if(pid)ui.pid=pid;render();window.scrollTo(0,0);}
function jahrgaenge(){return [...new Set(DB.players.map(p=>p.jahrgang).filter(Boolean))].sort();}
function jgToggle(set,act){
  return `<div class="toggle" role="group" aria-label="Jahrgang">
    <button data-act="${act}" data-v="" aria-pressed="${set.size===0}">alle</button>
    ${jahrgaenge().map(j=>`<button data-act="${act}" data-v="${j}" aria-pressed="${set.has(j)}">${j}</button>`).join('')}
  </div>`;
}
function legend(){return `<div class="legend"><span class="muted">DHB-Einordnung:</span>${[1,2,3,4,5].map(c=>`<span class="chip c${c}">${CATS_SHORT[c-1]}</span>`).join('')}</div>`;}
function scoreBar(s){const c=scoreCat(s);return `<div class="sbar"><b>${Math.round(s)}</b><i><span class="c${c}" style="width:${s}%"></span></i></div>`;}
function emptyState(){return `<div class="panel empty"><h2>Noch keine Spielerinnen</h2><p>Lege im Bereich Kader die erste Spielerin an oder übernimm deine bisherige Excel-Datei unter Daten.</p><div class="row" style="justify-content:center"><button class="btn primary" data-act="tab" data-v="kader">Zum Kader</button><button class="btn" data-act="tab" data-v="daten">Excel übernehmen</button></div></div>`;}

/* Team */
function renderTeam(){
  if(!DB.players.length)return emptyState();
  const ps=DB.players.filter(p=>!ui.teamJg.size||ui.teamJg.has(p.jahrgang));
  const rows=ps.map(p=>{
    const tot=total(p),cells={};
    TESTS.forEach(t=>{const l=lastOf(p.id,t.key),pr=prevOf(p.id,t.key);
      cells[t.key]={v:l?l.v:null,c:l?cat(t,l.v,p):null,s:l?score(t,l.v,p):null,tr:l&&pr?Math.sign(t.dir*(l.v-pr.v)):null};});
    const lt=lastTest(p.id),ds=daysSince(lt),flags=[];
    if(!lt)flags.push('noch nie getestet');
    else if(ds>DB.settings.overdueDays)flags.push('Test überfällig ('+Math.round(ds/30)+' Mon.)');
    const miss=TESTS.filter(t=>cells[t.key].v==null).length;
    if(lt&&miss)flags.push(miss+' Test'+(miss>1?'s fehlen':' fehlt'));
    return {p,tot,cells,flags};
  });
  const s=ui.teamSort;
  const sm=groupSummary(rows);
  rows.sort((a,b)=>{
    if(s==='name')return byName(a.p,b.p);
    const va=s==='score'?(a.tot?a.tot.score:null):a.cells[s].s, vb=s==='score'?(b.tot?b.tot.score:null):b.cells[s].s;
    if(va==null&&vb==null)return byName(a.p,b.p);if(va==null)return 1;if(vb==null)return -1;return vb-va;
  });
  const needs=TESTS.map(t=>{
    const cs=rows.map(r=>r.cells[t.key].c).filter(c=>c);
    const dist=[1,2,3,4,5].map(c=>cs.filter(x=>x===c).length);
    return {t,dist,n:cs.length,avg:cs.length?cs.reduce((a,b)=>a+b,0)/cs.length:null,low:dist[3]+dist[4]};
  }).sort((a,b)=>(b.avg||0)-(a.avg||0));
  const sortBtn=(k,label)=>`<button data-act="sort" data-v="${k}" aria-pressed="${s===k}">${label}</button>`;
  return `
  <div class="filters no-print">
    <div class="field">Jahrgang${jgToggle(ui.teamJg,'teamJg')}</div>
    ${legend()}
    <span style="flex:1"></span><button class="btn ghost" data-act="print">Drucken</button>
  </div>
  <div class="section-h" style="margin-top:6px"><h2>Wo die Gruppe Förderung braucht</h2><span class="hint">${rows.length} Spielerinnen, nach Ø DHB-Einordnung sortiert</span></div>
  <div class="needs">${needs.map((n,i)=>`
    <div class="need">
      <h3><span>${n.t.name}</span><span class="rank">${i+1}.</span></h3>
      <div class="dist" role="img" aria-label="${n.dist.map((d,c)=>d+' '+CATS[c]).join(', ')}">${n.dist.map((d,c)=>d?`<span class="c${c+1}" style="width:${d/n.n*100}%"></span>`:'').join('')}</div>
      <div class="hint">${n.n?`${n.low} von ${n.n} unter dem Durchschnitt`:'keine Werte'}</div>
    </div>`).join('')}</div>
  <div class="section-h"><h2>Letzte Werte</h2><span class="hint">Klick auf eine Spielerin öffnet ihr Profil. Pfeil = Veränderung zur Vormessung.</span></div>
  <div class="scroll listbox" id="teamList" tabindex="0" aria-label="Spielerinnenliste"><table class="hm">
    <thead><tr><th>${sortBtn('name','Name')}</th><th>${sortBtn('score','Athletik-Score')}</th>
      ${TESTS.map(t=>`<th class="t">${sortBtn(t.key,t.short)}<br><small>${t.unit}</small></th>`).join('')}<th>Hinweise</th></tr></thead>
    <tbody>${rows.map(r=>`<tr>
      <td class="name"><a href="#" data-act="open" data-v="${r.p.id}"><span>${esc(r.p.name)}</span><small>${r.p.jahrgang||''}, ${ageClass(r.p.jahrgang)}</small></a></td>
      <td class="score">${r.tot?scoreBar(r.tot.score):'<span class="muted">–</span>'}</td>
      ${TESTS.map(t=>{const c=r.cells[t.key];if(c.v==null)return '<td class="cell empty">–</td>';
        const tr=c.tr>0?'<span class="tr" title="besser als Vormessung">▲</span>':c.tr<0?'<span class="tr" title="schlechter als Vormessung">▼</span>':'';
        return `<td class="cell c${c.c}" title="${t.name}: ${CATS[c.c-1]}">${fmt(t,c.v)}${tr}</td>`;}).join('')}
      <td class="flags">${r.flags.map(esc).join('<br>')}</td></tr>`).join('')}</tbody>
    <tfoot><tr>
      <td class="name sum"><div><b>Ø Auswahl</b><small>${sm.n} Spielerinnen${ui.teamJg.size?', Jg. '+[...ui.teamJg].sort().join(', '):', alle Jahrgänge'}</small></div></td>
      <td class="score sum">${sm.score!=null?scoreBar(sm.score)+`<div class="dl">${deltaTxt(sm.scoreD,'pkt')}</div>`:'–'}</td>
      ${TESTS.map(t=>{const x=sm.tests[t.key];if(x.v==null)return '<td class="cell empty sum">–</td>';
        return `<td class="cell sum c${scoreCat(x.s)}" title="${t.name}: Ø von ${x.n} Spielerinnen. Entwicklung: Ø Veränderung je Spielerin von der ersten zur letzten Messung (${x.dn} mit Vergleich).">${fmt(t,x.v)}<div class="dl">${deltaTxt(x.d,'%')}</div></td>`;}).join('')}
      <td class="flags sum" style="color:var(--muted)">Entwicklung: Ø je Spielerin, erste → letzte Messung</td>
    </tr></tfoot>
  </table>
  <p class="hint">Athletik-Score: jeder Test wird an den DHB-Werten auf 0–100 umgerechnet (0–20 weit unter, 40–60 Durchschnitt, 80–100 weit über) und gewichtet gemittelt (Sprint und Liegestütze je 25 %, Sprung und Wurf je 20 %, Shuttle 10 %).</p></div>`;
}
/* Summenzeile: Ø der Auswahl und Ø Entwicklung (erste → letzte Messung je Spielerin) */
function groupSummary(rows){
  const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null,tests={};
  TESTS.forEach(t=>{
    const ls=rows.filter(r=>r.cells[t.key].v!=null);
    const d=rows.map(r=>{const f=firstOf(r.p.id,t.key),l=lastOf(r.p.id,t.key);return f&&l&&f.monat!==l.monat&&f.v?t.dir*(l.v-f.v)/f.v:null;}).filter(x=>x!=null);
    tests[t.key]={v:mean(ls.map(r=>r.cells[t.key].v)),s:mean(ls.map(r=>r.cells[t.key].s)),n:ls.length,d:mean(d),dn:d.length};
  });
  const sd=rows.map(r=>{let w=0,acc=0;TESTS.forEach(t=>{const f=firstOf(r.p.id,t.key),l=lastOf(r.p.id,t.key);
    if(f&&l&&f.monat!==l.monat){acc+=(score(t,l.v,r.p)-score(t,f.v,r.p))*t.w;w+=t.w;}});return w?acc/w:null;}).filter(x=>x!=null);
  return {n:rows.length,score:mean(rows.filter(r=>r.tot).map(r=>r.tot.score)),scoreD:mean(sd),tests};
}
function deltaTxt(d,unit){
  if(d==null)return '<span class="muted">keine Entwicklung</span>';
  const v=unit==='%'?d*100:d,a=Math.abs(v).toFixed(1).replace('.',',');
  if(Math.abs(v)<0.05)return '± 0'+(unit==='%'?' %':' Pkt.');
  const txt=(v>0?'▲ +':'▼ −')+a+(unit==='%'?' %':' Pkt.');return unit==='pkt'?`<span class="${v>0?'up':'down'}">${txt}</span>`:txt;
}
/* Team-Ansicht: Kopfbereich bleibt stehen, nur die Liste scrollt */
function fitList(){
  const el=$('#teamList');document.body.classList.remove('fit');
  if(!el)return;el.style.maxHeight='';
  const top=el.getBoundingClientRect().top+window.scrollY,avail=Math.floor(window.innerHeight-top-16);
  /* auf schmalen Bildschirmen scrollt die ganze Seite, ein kleines Listenfenster waere dort zu eng */
  if(avail>=260&&window.innerWidth>=700){el.style.maxHeight=avail+'px';document.body.classList.add('fit');}
}

/* Profil */
const COURT_SVG=`<svg class="court" viewBox="0 0 200 200" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 200 A80 80 0 0 1 180 200"/><path d="M-10 200 A110 110 0 0 1 210 200" stroke-dasharray="7 6"/><path d="M85 200 v-14 h30 v14"/></svg>`;
function radar(p,cmp){
  const S=260,c=S/2,R=92,n=TESTS.length;
  const pt=(i,r)=>{const a=-Math.PI/2+i*2*Math.PI/n;return [c+Math.cos(a)*r,c+Math.sin(a)*r];};
  const ring=r=>TESTS.map((_,i)=>pt(i,r).join(',')).join(' ');
  const vals=TESTS.map(t=>{const l=lastOf(p.id,t.key);return l?score(t,l.v,p):null;});
  const poly=vals.map((v,i)=>pt(i,R*(v==null?0:v)/100).join(',')).join(' ');
  return `<svg class="radar" viewBox="0 0 ${S} ${S}" role="img" aria-label="Netzdiagramm der Scores">
    ${[100,80,60,40,20].map(r=>`<polygon points="${ring(R*r/100)}" fill="${r===60?'rgba(255,255,255,.07)':'none'}" stroke="#fff" stroke-opacity="${r===60||r===40?.4:.18}" stroke-width="1"/>`).join('')}
    ${TESTS.map((_,i)=>{const [x,y]=pt(i,R);return `<line x1="${c}" y1="${c}" x2="${x}" y2="${y}" stroke="#fff" stroke-opacity=".18"/>`;}).join('')}
    ${cmp?`<polygon points="${TESTS.map((t,i)=>{const v=cmp.scores[t.key];return pt(i,R*(v==null?0:v)/100).join(',');}).join(' ')}" fill="#8FB4FF" fill-opacity=".10" stroke="#8FB4FF" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>`:''}
    <polygon points="${poly}" fill="#FFCE00" fill-opacity=".25" stroke="#FFCE00" stroke-width="2.5" stroke-linejoin="round"/>
    ${vals.map((v,i)=>v==null?'':`<circle cx="${pt(i,R*v/100)[0]}" cy="${pt(i,R*v/100)[1]}" r="5" fill="var(--c${scoreCat(v)})" stroke="#111418" stroke-width="1.5"/>`).join('')}
    ${TESTS.map((t,i)=>{const [x,y]=pt(i,R+22);const v=vals[i];
      return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" fill="#fff" font-size="13" font-family="Barlow Condensed,Arial Narrow,sans-serif" font-weight="700">${t.short}<tspan x="${x}" dy="14" font-weight="500" fill="#B9BEC7">${v==null?'–':Math.round(v)}</tspan></text>`;}).join('')}
  </svg>`;
}
function bandBar(t,p,cv){
  const [a,bb,c,d]=th(t,p).map(x=>t.dir*x);
  const lo=d-(c-d),hi=a+(a-bb),X=u=>Math.max(0,Math.min(100,(u-lo)/(hi-lo)*100));
  const zones=[[lo,d,5],[d,c,4],[c,bb,3],[bb,a,2],[a,hi,1]];
  const f=firstOf(p.id,t.key),l=lastOf(p.id,t.key);
  let marks='';
  if(f&&l&&f.monat!==l.monat){const x1=X(t.dir*f.v),x2=X(t.dir*l.v);
    marks+=`<span class="link" style="left:${Math.min(x1,x2)}%;width:${Math.abs(x2-x1)}%"></span><span class="dot first" style="left:${x1}%" title="erste Messung: ${fmt(t,f.v)}"></span>`;}
  if(cv!=null)marks+=`<span class="cmpm" style="left:${X(t.dir*cv)}%" title="Vergleich: ${fmt(t,cv)}"></span>`;
  if(l)marks+=`<span class="dot" style="left:${X(t.dir*l.v)}%" title="letzte Messung: ${fmt(t,l.v)}"></span>`;
  return `<div class="bbar" role="img" aria-label="${t.name}: ${l?fmt(t,l.v)+' '+t.unit:'kein Wert'} im Vergleich zu den DHB-Bereichen">
    <div class="zones">${zones.map(([u1,u2,cc])=>`<span class="c${cc}" style="width:${X(u2)-X(u1)}%"></span>`).join('')}</div>
    ${marks}
    <div class="ticks">${[d,c,bb,a].map(u=>`<span style="left:${X(u)}%">${fmt(t,t.dir*u)}</span>`).join('')}</div>
  </div>`;
}
function goalText(t,p){
  const l=lastOf(p.id,t.key);if(!l)return 'Noch nicht getestet.';
  const c=cat(t,l.v,p);if(c===1)return '<b>Spitzenbereich</b> der DHB-Werte erreicht.';
  const target=th(t,p)[c-2];
  return `Noch <b>${fmtDiff(t,target-l.v)}</b> bis „${CATS[c-2]}“.`;
}
function sparkline(t,pid){
  const s=series(pid,t.key);if(s.length<2)return '';
  const us=s.map(x=>t.dir*x.v),mn=Math.min(...us),mx=Math.max(...us),W=80,H=22;
  const pts=us.map((u,i)=>[i/(us.length-1)*W,mx===mn?H/2:H-(u-mn)/(mx-mn)*H]);
  const col=us[us.length-1]>=us[us.length-2]?'var(--up)':'var(--down)';
  return `<svg width="${W}" height="${H+4}" viewBox="0 -2 ${W} ${H+4}" aria-hidden="true"><polyline points="${pts.map(p=>p.join(',')).join(' ')}" fill="none" stroke="var(--muted)" stroke-width="1.5"/><circle cx="${pts[pts.length-1][0]}" cy="${pts[pts.length-1][1]}" r="3.5" fill="${col}"/></svg>`;
}
function playerPicker(list,p){
  const idx=list.indexOf(p);
  return `<button class="btn no-print" data-act="pstep" data-v="${list[(idx-1+list.length)%list.length].id}" aria-label="Vorherige Spielerin">‹</button>
    <select class="no-print" data-chg="pickPlayer" aria-label="Spielerin wählen">${list.map(x=>opt(x.id,x.name,p.id)).join('')}</select>
    <button class="btn no-print" data-act="pstep" data-v="${list[(idx+1)%list.length].id}" aria-label="Nächste Spielerin">›</button>`;
}
function cmpData(p){
  const v=ui.cmp;if(!v)return null;
  if(v.startsWith('p:')){const q=pById(v.slice(2));if(!q||q.id===p.id)return null;
    const vals={},scores={};TESTS.forEach(t=>{const l=lastOf(q.id,t.key);vals[t.key]=l?l.v:null;scores[t.key]=l?score(t,l.v,q):null;});
    const tq=total(q);const parts=q.name.split(',').map(s=>s.trim());
    return {label:(parts[1]?parts[1]+' '+parts[0]:q.name),short:parts[1]||parts[0],vals,scores,total:tq?tq.score:null,sub:q.jahrgang?'Jahrgang '+q.jahrgang:''};}
  const g=DB.players.filter(x=>x.id!==p.id&&(v==='team'||x.jahrgang===p.jahrgang));
  if(!g.length)return null;
  const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null,vals={},scores={};
  TESTS.forEach(t=>{const ls=g.map(x=>({x,l:lastOf(x.id,t.key)})).filter(o=>o.l);vals[t.key]=mean(ls.map(o=>o.l.v));scores[t.key]=mean(ls.map(o=>score(t,o.l.v,o.x)));});
  return {label:v==='jg'?'Ø Jahrgang '+p.jahrgang:'Ø Team',short:'Ø',vals,scores,total:mean(g.map(total).filter(Boolean).map(t=>t.score)),sub:g.length+' andere Spielerin'+(g.length>1?'nen':'')};
}
function cmpLine(t,v,cmp){
  const cv=cmp.vals[t.key],head=`<span style="color:var(--cmp)">◆</span> ${esc(cmp.label)}: `;
  if(cv==null)return head+'kein Wert';
  let tail='';
  if(v!=null){const d=t.dir*(v-cv),eq=Math.abs(v-cv)<(t.dec?0.005:t.time?0.5:0.05);
    tail=eq?', gleich':`, <span class="${d>0?'up':'down'}">${fmtDiff(t,v-cv)} ${d>0?'besser':'schlechter'}</span>`;}
  return `${head}<b>${fmt(t,cv)}</b>${tail}`;
}
function cmpText(t,v,cv){
  if(cv==null)return '<div class="cmpv">Vergleich: kein Wert</div>';
  if(v==null)return `<div class="cmpv">Vergleich: ${fmt(t,cv)}</div>`;
  const d=t.dir*(v-cv),eq=Math.abs(v-cv)<(t.dec?0.005:t.time?0.5:0.05);
  return `<div class="cmpv">Vergleich: ${fmt(t,cv)}<br>${eq?'gleich':`<span class="${d>0?'up':'down'}">${fmtDiff(t,v-cv)} ${d>0?'besser':'schlechter'}</span>`}</div>`;
}
function renderProfil(){
  if(!DB.players.length)return emptyState();
  const list=DB.players.slice().sort(byName);
  const p=pById(ui.pid)||list[0];ui.pid=p.id;
  const tot=total(p);
  const sc=TESTS.map(t=>{const l=lastOf(p.id,t.key);return {t,s:l?score(t,l.v,p):null};}).filter(x=>x.s!=null);
  const strong=sc.filter(x=>x.s>=60).sort((a,b)=>b.s-a.s);
  const weak=sc.filter(x=>x.s<40).sort((a,b)=>a.s-b.s).slice(0,2);
  const ms=mOf(p.id).slice().reverse(),ag=age(p.geb);
  const logo=DB.settings.logoTeam||DB.settings.logoVerein;
  if(ui.cmp==='p:'+p.id)ui.cmp='';
  const ro=!!ME,cmp=ro?null:cmpData(p);
  return `
  ${ro?`<div class="pick"><span style="flex:1"></span><button class="btn ghost no-print" data-act="print">Drucken</button><button class="btn ghost no-print" data-act="meLogout">Abmelden</button></div>`:`<div class="pick">${playerPicker(list,p)}
    <label class="field no-print" style="flex-direction:row;align-items:center;gap:8px;margin-left:8px">Vergleichen mit
      <select data-chg="cmp" style="font-size:16px;font-family:var(--body);font-weight:500">${opt('','–',ui.cmp)}${p.jahrgang?opt('jg','Ø Jahrgang '+p.jahrgang,ui.cmp):''}${opt('team','Ø Team (alle)',ui.cmp)}
        <optgroup label="Spielerin">${list.filter(x=>x.id!==p.id).map(x=>opt('p:'+x.id,x.name,ui.cmp)).join('')}</optgroup></select></label>
    <span style="flex:1"></span>
    <button class="btn no-print" data-act="toPlan">Trainingsplan</button>
    <button class="btn ghost no-print" data-act="print">Drucken</button>
  </div>`}
  <div class="profile">
    <div class="card">
      ${COURT_SVG}
      <div class="who"><label class="avatar-up${p.foto?'':' none'}" title="Foto ${p.foto?'ändern':'hinzufügen'}">${avatar(p,'avatar')}<span>${p.foto?'Ändern':'+ Foto'}</span><input type="file" accept="image/*" hidden data-chg="${ro?'mePhoto':'photo'}" data-id="${p.id}"></label><div><h2>${esc(p.name)}</h2>
        <div class="meta">${[p.jahrgang?'Jahrgang '+p.jahrgang:'',ageClass(p.jahrgang),ag!=null?ag+' Jahre':'',p.position].filter(Boolean).map(esc).join(', ')}</div></div></div>
      <div class="big"><b>${tot?Math.round(tot.score):'–'}</b><span>Athletik-Score<br>${tot?tot.n+' von 5 Tests':'noch keine Werte'}${cmp?`<br><span style="color:#8FB4FF">${esc(cmp.label)}: ${cmp.total!=null?Math.round(cmp.total):'–'}</span>`:''}</span>${logo?`<img class="clublogo" src="${esc(logo)}" alt="">`:''}</div>
      ${radar(p,cmp)}
      ${cmp?`<div class="rleg"><span><i></i>${esc(p.name.split(',').map(s=>s.trim())[1]||p.name)}</span><span><i class="c"></i>${esc(cmp.label)}</span></div>`:'<div class="rleg" style="visibility:hidden" aria-hidden="true"><span><i></i>&nbsp;</span></div>'}
      <div class="tags">${strong.map(x=>`<span class="chip c${scoreCat(x.s)}">Stärke: ${x.t.area}</span>`).join('')}${weak.map(x=>`<span class="chip c${scoreCat(x.s)}">Fördern: ${x.t.area}</span>`).join('')}</div>
    </div>
    <div class="panel">
      <div class="section-h" style="margin-top:0"><h2>Stand zu den DHB-Werten</h2><span class="hint">○ erste, ● letzte Messung, <span style="color:var(--cmp)">◆</span> Vergleich, rechts = stärker</span></div>
      <div class="bands">${TESTS.map(t=>{const l=lastOf(p.id,t.key),c=l?cat(t,l.v,p):null,pr=prevOf(p.id,t.key);
        const tr=l&&pr?Math.sign(t.dir*(l.v-pr.v)):0;return `
        <div class="band">
          <div class="lbl"><b>${t.name}</b><span>${l?'zuletzt '+monthLabel(l.monat):'kein Wert'}${tr>0?' <span class="up">▲</span>':tr<0?' <span class="down">▼</span>':''}</span><div>${sparkline(t,p.id)}</div></div>
          <div class="mid">${bandBar(t,p,cmp?cmp.vals[t.key]:null)}<div class="goal">${goalText(t,p)}</div><div class="cmpl">${cmp?cmpLine(t,l?l.v:null,cmp):''}</div></div>
          <div class="val"><b>${l?fmt(t,l.v):'–'}</b><small>${t.unit}</small><div style="margin-top:4px">${c?chip(c,true):''}</div></div>
        </div>`;}).join('')}</div>
      <p class="hint" style="margin-bottom:0">Vergleichswerte: DHB-Orientierungswerte Mädchen ${normKey(p)==='15'?'15 Jahre':'13–15 Jahre'}. Für jüngere Jahrgänge ist der Vergleich entsprechend streng.</p>
    </div>
  </div>
  ${ro?meData(p):''}
  <div class="section-h"><h2>Messungen</h2>${ro?'':'<button class="btn no-print" data-act="addM">Messung hinzufügen</button>'}</div>
  <div class="panel scroll" style="padding:8px 12px">
  ${ro?msReadonly(p,ms):ms.length?`<table class="ms"><thead><tr><th>Monat</th><th>Bezeichnung</th>${TESTS.map(t=>`<th>${t.short} (${t.unit})</th>`).join('')}<th>Bemerkung</th><th></th></tr></thead><tbody>
    ${ms.map(m=>`<tr>
      <td class="mo"><input type="month" value="${esc(m.monat)}" data-chg="mField" data-id="${m.id}" data-f="monat" aria-label="Monat"></td>
      <td><input value="${esc(m.name)}" data-chg="mField" data-id="${m.id}" data-f="name" aria-label="Bezeichnung"></td>
      ${TESTS.map(t=>{const c=m.w[t.key]==null?null:cat(t,m.w[t.key],p);return `<td class="v"><input inputmode="decimal" class="${c?'c'+c:''}" value="${m.w[t.key]==null?'':fmt(t,m.w[t.key])}" data-chg="mVal" data-id="${m.id}" data-k="${t.key}" aria-label="${t.name}" placeholder="${t.time?'m:ss':''}"></td>`;}).join('')}
      <td><input value="${esc(m.bem)}" data-chg="mField" data-id="${m.id}" data-f="bem" aria-label="Bemerkung"></td>
      <td><button class="btn ghost small danger no-print" data-act="delM" data-v="${m.id}" aria-label="Messung löschen">Löschen</button></td></tr>`).join('')}
  </tbody></table>`:'<div class="empty">Noch keine Messung. Werte kommen am schnellsten über den Testtag.</div>'}
  </div>${ro?mePlan():''}`;
}
function msReadonly(p,ms){
  if(!ms.length)return '<div class="empty">Noch keine Messung.</div>';
  return `<table class="ms"><thead><tr><th>Monat</th><th>Bezeichnung</th>${TESTS.map(t=>`<th>${t.short} (${t.unit})</th>`).join('')}</tr></thead><tbody>
    ${ms.map(m=>`<tr><td>${monthLabel(m.monat)}</td><td>${esc(m.name)}</td>${TESTS.map(t=>{const v=m.w[t.key],c=v==null?null:cat(t,v,p);
      return `<td class="v num">${v==null?'–':`<span class="chip${c?' c'+c:' plain'}">${fmt(t,v)}</span>`}</td>`;}).join('')}</tr>`).join('')}
  </tbody></table>`;
}
function meData(p){
  let pend=false;try{const x=JSON.parse(localStorage.getItem('ld-me-pending')||'null');pend=!!(x&&x.code===ME.code&&!x.sent);}catch(e){}
  return `<div class="panel no-print" style="margin-top:18px"><h3>Meine Angaben</h3>
    <div class="row"><label class="field">Geburtstag<input type="date" min="1950-01-01" max="${new Date().toISOString().slice(0,10)}" value="${esc(p.geb||'')}" data-chg="meGeb"></label>
      <label class="btn" style="align-self:flex-end">${p.foto?'Foto ändern':'Foto hinzufügen'}<input type="file" accept="image/*" hidden data-chg="mePhoto"></label>
      ${p.foto?'<button class="btn ghost" data-act="meDelPhoto" style="align-self:flex-end">Foto entfernen</button>':''}</div>
    <p class="hint">${pend?'Noch nicht gesendet, wird beim nächsten Öffnen mit Internet erneut versucht. ':''}Änderungen übernimmt dein Trainerteam automatisch beim nächsten Abgleich.</p></div>`;
}
/* Eigener Trainingsplan der Spielerin: Dauer wählbar, Übungen aus der Auswahl des Trainerteams */
const DAUERN=[15,30,45,60],ME_POOL=15;
const exMin=b=>b===RUMPF?3:5;
function meBlocks(){
  const o=ui.me,D=o.dauer,warm=D<=15?3:D<=30?5:D<=45?7:8,cool=D<=15?2:D<=30?3:5;
  const pools=ME.pools||{},f=o.fokus!=='auto'&&pools[o.fokus]?(o.fokus===RUMPF?[]:[o.fokus]):(ME.fokus||[]).filter(Boolean);
  const pat=f.length>1?[f[0],RUMPF,f[1],f[0],f[1],RUMPF]:f.length?[f[0],RUMPF,f[0]]:[RUMPF];
  const q={};Object.keys(pools).forEach(b=>{q[b]=shuffled(pools[b].map(exByNr).filter(e=>e&&(o.ort==='alle'||e.ort===o.ort)),ME.player.id+'|'+o.variante+'|'+b);});
  let left=D-warm-cool,more=true;const blocks=[];
  while(more){more=false;
    for(const b of pat){const l=q[b],m=exMin(b);if(l&&l.length&&m<=left){blocks.push({b,e:l.shift(),min:m});left-=m;more=true;}}}
  return {warm,cool,blocks,sum:D-left};
}
function mePlan(){
  const o=ui.me,r=meBlocks();
  return `<div class="section-h"><h2>Mein Trainingsplan</h2><span class="hint">${r.blocks.length?'≈ '+r.sum+' Minuten':''}</span></div>
  <div class="opts no-print">
    <div class="field">Dauer<div class="toggle" role="group" aria-label="Dauer">${DAUERN.map(d=>`<button data-act="meDauer" data-v="${d}" aria-pressed="${o.dauer===d}">${d} min</button>`).join('')}</div></div>
    <label class="field">Schwerpunkt<select data-chg="meFokus">${opt('auto','meine Förderschwerpunkte'+((ME.fokus||[]).length?' ('+ME.fokus.join(', ')+')':''),o.fokus)}${Object.keys(ME.pools||{}).filter(b=>ME.pools[b].length).map(b=>opt(b,b,o.fokus)).join('')}</select></label>
    <label class="field">Ort<select data-chg="meOrt">${opt('alle','alle',o.ort)}${ORTE.map(n=>opt(n,'nur '+n,o.ort)).join('')}</select></label>
    <div class="field">Übungen<button class="btn" data-act="meReroll">Andere Übungen</button></div>
  </div>
  ${r.blocks.length?`
  <div class="panel" style="margin-bottom:14px"><b>Aufwärmen, ${r.warm} min:</b> lockeres Einlaufen oder Hampelmänner, Armkreisen, Ausfallschritte, Skippings, ein paar kurze Antritte.</div>
  <div class="exlist">${r.blocks.map((x,i)=>exCard(x.e,`<span>Zeit <b>≈ ${x.min} min</b></span><span>Bereich <b>${esc(x.b)}</b></span>`)).join('')}</div>
  <div class="panel" style="margin-top:14px"><b>Cool-down, ${r.cool} min:</b> locker auslaufen oder gehen, dann die beanspruchten Muskeln ruhig dehnen.</div>`
  :'<div class="panel empty">Für diese Auswahl gibt es keine passenden Übungen. Anderen Ort wählen.</div>'}
  ${PLAN_HINTS}`;
}
async function meSubmit(){
  const p=DB.players[0],upd={geb:p.geb||'',foto:p.foto||'',at:new Date().toISOString()};
  const save=sent=>{try{localStorage.setItem('ld-me-pending',JSON.stringify({code:ME.code,upd,sent}));}catch(e){}};
  save(false);render();
  try{await cloud.submitUpdate(await lookupOf(ME.code),await sealWith(await shareKey(ME.code),upd));save(true);render();
    toast('Gespeichert. Dein Trainerteam übernimmt die Änderung beim nächsten Abgleich.');}
  catch(e){console.error(e);toast(navigator.onLine?'Senden fehlgeschlagen. Bitte später erneut versuchen.':'Keine Internetverbindung. Wird beim nächsten Öffnen erneut gesendet.');}
}

/* Testtag */
function renderTesttag(){
  if(!DB.players.length)return emptyState();
  const tt=ui.tt,t=T(tt.test);
  const ps=DB.players.filter(p=>!tt.jg.size||tt.jg.has(p.jahrgang)).sort(byName);
  return `
  <div class="filters">
    <label class="field">Monat<input type="month" value="${tt.monat}" data-chg="ttMonat"></label>
    <label class="field">Bezeichnung<input value="${esc(tt.name)}" placeholder="z. B. Test 5" data-chg="ttName"></label>
    <div class="field">Jahrgang${jgToggle(tt.jg,'ttJg')}</div>
  </div>
  <div class="field" style="margin-bottom:6px">Station</div>
  <div class="stations" role="group" aria-label="Test wählen">${TESTS.map(x=>{
    const n=ps.filter(p=>{const v=tt.vals[p.id+'|'+x.key];return v!=null&&v!=='';}).length;
    return `<button data-act="ttTest" data-v="${x.key}" aria-pressed="${x.key===tt.test}"><b>${x.name}</b><small>${x.unit}${n?', '+n+' eingetragen':''}</small></button>`;}).join('')}</div>
  <p class="hint">${t.time?'Shuttle-Run als Minuten:Sekunden eintragen, z. B. 6:20. ':''}Eingabe springt mit Enter zur nächsten Spielerin. Die Werte landen in der Messung des gewählten Monats; gibt es dort schon eine, wird sie ergänzt.</p>
  <div class="tt">${ps.map(p=>{const k=p.id+'|'+t.key,b=bestOf(p.id,t.key);return `
    <div class="ttrow">
      <div class="n"><b>${esc(p.name)}</b><small>${p.jahrgang||''}${b!=null?', Bestwert '+fmt(t,b):''}</small></div>
      <input inputmode="decimal" data-inp="ttVal" data-k="${k}" value="${esc(tt.vals[k]||'')}" aria-label="${esc(p.name)}: ${t.name}" placeholder="${t.time?'m:ss':t.unit}" autocomplete="off">
      <div class="fb" data-fb="${k}"></div>
    </div>`;}).join('')}</div>
  <div class="sticky-act"><div class="panel"><span class="hint" id="ttCount"></span>
    <button class="btn ghost" data-act="ttClear">Leeren</button>
    <button class="btn primary" data-act="ttApply">Werte übernehmen</button></div></div>`;
}
function refreshTTFeedback(){
  const cnt=$('#ttCount');if(cnt){const n=Object.values(ui.tt.vals).filter(v=>v!=null&&v!=='').length;cnt.textContent=n+(n===1?' Wert':' Werte')+' erfasst';}
  document.querySelectorAll('[data-fb]').forEach(el=>{
    const [pid,k]=el.dataset.fb.split('|'),t=T(k),p=pById(pid),raw=ui.tt.vals[el.dataset.fb];
    const inp=el.parentNode.querySelector('input');
    if(raw==null||raw===''){el.innerHTML='';inp.classList.remove('bad');return;}
    const v=parseVal(t,raw);
    if(v==null||isNaN(v)){inp.classList.add('bad');el.innerHTML='<span class="down">Wert nicht lesbar</span>';return;}
    inp.classList.remove('bad');
    const c=cat(t,v,p),b=bestOf(pid,k),pb=b!=null&&t.dir*v>t.dir*b;
    el.innerHTML=`${chip(c,true)}${pb?'<span class="pb">▲ Neuer Bestwert!</span>':b==null?'<span class="muted">erster Wert</span>':''}`;
  });
}
function applyTesttag(){
  const tt=ui.tt;
  if(!/^\d{4}-\d{2}$/.test(tt.monat)){toast('Bitte zuerst einen Monat wählen.');return;}
  const entries=[];let bad=0;
  Object.entries(tt.vals).forEach(([k,raw])=>{
    if(raw==null||raw==='')return;
    const [pid,key]=k.split('|'),v=parseVal(T(key),raw);
    if(v==null||isNaN(v)){bad++;return;}
    if(pById(pid))entries.push({pid,key,v});
  });
  if(bad){toast(bad+' Wert'+(bad>1?'e sind':' ist')+' nicht lesbar. Bitte rot markierte Felder prüfen.');return;}
  if(!entries.length){toast('Noch keine Werte eingetragen.');return;}
  const conflicts=entries.filter(e=>{const m=DB.messungen.find(m=>m.pid===e.pid&&m.monat===tt.monat);return m&&m.w[e.key]!=null&&m.w[e.key]!==e.v;});
  if(conflicts.length&&!confirm(conflicts.length+' Wert(e) gibt es für '+monthLabel(tt.monat)+' schon mit anderem Ergebnis. Überschreiben?'))return;
  entries.forEach(e=>{
    let m=DB.messungen.find(m=>m.pid===e.pid&&m.monat===tt.monat);
    if(!m){m={id:uid('m'),pid:e.pid,monat:tt.monat,name:tt.name||'',w:{},bem:''};DB.messungen.push(m);}
    if(!m.name&&tt.name)m.name=tt.name;
    m.w[e.key]=e.v;
  });
  tt.vals={};changed();render();
  toast(entries.length+' Werte übernommen.');
}

/* Kader */
function renderKader(){
  const list=DB.players.slice().sort(byName);
  return `
  <div class="panel" style="margin-bottom:18px">
    <h3>Neue Spielerin</h3>
    <div class="row">
      <label class="field">Name (Nachname, Vorname)<input id="newName" placeholder="Muster, Lena"></label>
      <label class="field">Jahrgang<input id="newJg" type="number" min="1990" max="2030" style="width:110px" placeholder="${new Date().getFullYear()-12}"></label>
      <button class="btn primary" data-act="addP" style="align-self:flex-end">Spielerin anlegen</button>
    </div>
  </div>
  ${list.length?`<div class="panel scroll" style="padding:8px 12px"><table class="kd"><thead><tr><th>Foto</th><th>Name</th><th>Jahrgang</th><th>Geburtsdatum</th><th>Position</th><th>Notiz</th><th>Messungen</th><th>Zugang</th><th></th></tr></thead><tbody>
  ${list.map(p=>`<tr>
    <td style="white-space:nowrap"><label class="phl"><span class="ph">${p.foto?`<img src="${esc(p.foto)}" alt="">`:esc(initials(p.name))}</span><span class="btn small">${p.foto?'Ändern':'Foto hinzufügen'}</span><input type="file" accept="image/*" hidden data-chg="photo" data-id="${p.id}"></label></td>
    <td><input value="${esc(p.name)}" data-chg="pField" data-id="${p.id}" data-f="name" aria-label="Name"></td>
    <td style="width:100px"><input type="number" value="${esc(p.jahrgang)}" data-chg="pField" data-id="${p.id}" data-f="jahrgang" aria-label="Jahrgang"></td>
    <td style="width:160px"><input type="date" value="${esc(p.geb)}" data-chg="pField" data-id="${p.id}" data-f="geb" aria-label="Geburtsdatum"></td>
    <td><input value="${esc(p.position)}" data-chg="pField" data-id="${p.id}" data-f="position" aria-label="Position"></td>
    <td><input value="${esc(p.notiz)}" data-chg="pField" data-id="${p.id}" data-f="notiz" aria-label="Notiz"></td>
    <td class="muted" style="white-space:nowrap">${mOf(p.id).length} <button class="btn ghost small" data-act="open" data-v="${p.id}">Profil</button></td>
    <td style="white-space:nowrap">${p.code?`<button class="btn ghost small" data-act="codeShow" data-v="${p.id}">Code zeigen</button>`:`<button class="btn small" data-act="codeNew" data-v="${p.id}">Code erzeugen</button>`}</td>
    <td style="white-space:nowrap">${p.foto?`<button class="btn ghost small" data-act="delPhoto" data-v="${p.id}">Foto entfernen</button>`:''}<button class="btn ghost small danger" data-act="delP" data-v="${p.id}">Löschen</button></td>
  </tr>`).join('')}</tbody></table></div>`:''}
  <p class="hint">Fotos werden beim Einfügen auf 240 × 240 Pixel verkleinert, damit die Datei klein bleibt.</p>
  <p class="hint">Zugang: Mit ihrem Code sieht eine Spielerin nur ihre eigenen Werte und ihren Trainingsplan, ohne Notizen und Bemerkungen.${SYNC.team?'':' Die Codes funktionieren, sobald die Mannschaft online ist (Daten → Online-Mannschaft).'}</p>`;
}

/* Daten */
function logoSlot(key,label){
  const v=DB.settings[key];
  return `<div class="logo-slot"><label class="lp" title="${label} wählen">${v?`<img src="${esc(v)}" alt="">`:'Bild wählen'}<input type="file" accept="image/*" hidden data-chg="logo" data-k="${key}"></label>
    <div><b>${label}</b><div class="hint">PNG mit transparentem Hintergrund oder SVG eignen sich am besten.</div>${v?`<button class="btn ghost small" data-act="delLogo" data-v="${key}">Entfernen</button>`:''}</div></div>`;
}
function renderOnline(){
  if(!cloudConfigured)return '';
  let h='<div class="panel" id="onlinePanel"><h3>Online-Mannschaft</h3>';
  if(SYNC.team){
    h+=`<p><span class="chip c1">verbunden</span> „${esc(SYNC.name)}“ als ${SYNC.role==='owner'?'Master':'Trainer/in'}.${SYNC.at?' Zuletzt abgeglichen um '+SYNC.at.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})+'.':''}</p>
      <p class="hint">Änderungen werden automatisch mit allen verbundenen Geräten abgeglichen. Offline Erfasstes wird übertragen, sobald wieder Internet da ist.</p>
      <div class="row"><button class="btn" data-act="syncNow">Jetzt abgleichen</button><button class="btn ghost" data-act="disconnect">Verbindung trennen</button></div>`;
    if(SYNC.role==='owner')h+=`<details style="margin-top:14px"><summary class="hint" style="cursor:pointer">Mannschaft umbenennen</summary>
      <div class="row"><input id="renameName" value="${esc(SYNC.name)}" placeholder="Neuer Mannschaftsname" autocomplete="off" aria-label="Neuer Mannschaftsname"><button class="btn" data-act="renameTeam">Umbenennen</button></div>
      <p class="hint">Verbundene Geräte bleiben verbunden. Neue Geräte verbinden sich danach mit dem neuen Namen und dem bisherigen Passwort.</p></details>`;
  }else{
    h+=`<p>Mit einer Mannschaft verbinden. Mannschaftsname und Passwort bekommst du vom Master.</p>
      <div class="row"><input id="joinName" placeholder="Mannschaftsname" autocomplete="off" aria-label="Mannschaftsname"><input type="password" id="joinPw" placeholder="Passwort" autocomplete="current-password" aria-label="Passwort"></div>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="join">Verbinden</button></div>
      <p class="hint">Die Mannschaft wird zusätzlich auf diesem Gerät gespeichert und bleibt danach automatisch aktuell.</p>`;
    if(master)h+=`<h4 style="margin:18px 0 6px">Diese Daten als Mannschaft online anlegen</h4>
      <div class="row"><input id="teamName" value="${esc(DB.settings.mannschaft)}" placeholder="Mannschaftsname, z. B. HSG wD1" aria-label="Mannschaftsname"></div>
      ${SEC.key?'<p class="hint">Das bestehende Passwort wird zum Mannschaftspasswort.</p>':`<div class="row" style="margin-top:8px"><input type="password" id="tpw1" placeholder="Mannschaftspasswort (mind. 8 Zeichen)" autocomplete="new-password"><input type="password" id="tpw2" placeholder="Wiederholen" autocomplete="new-password"></div>`}
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="createTeam">Online anlegen</button></div>`;
  }
  if(master)h+=`<p class="hint" style="margin-top:14px">Angemeldet als Master (${esc(master)}). <button class="btn ghost small" data-act="signOut">Abmelden</button> <button class="btn ghost small" data-act="newTeam">Neue leere Mannschaft</button></p>`;
  else h+=`<details style="margin-top:14px"><summary class="hint" style="cursor:pointer">Master-Anmeldung</summary>
      <div class="row"><input id="mEmail" type="email" autocomplete="username" placeholder="E-Mail-Adresse" aria-label="E-Mail-Adresse" value="${esc(ui.mEmail)}"><input id="mPw" type="password" autocomplete="current-password" placeholder="Passwort" aria-label="Passwort"><button class="btn" data-act="mLogin">Anmelden</button></div></details>`;
  if(localTeams.length>1)h+=`<div class="row" style="margin-top:14px"><label class="field" style="flex:1">Mannschaft auf diesem Gerät<select id="teamSel">${localTeams.map(t=>opt(t.id,t.label||t.id,DB.meta.fileId)).join('')}</select></label><button class="btn" data-act="openTeam" style="align-self:flex-end">Öffnen</button></div>`;
  return h+'</div>';
}
function renderDaten(){
  return `<div class="grid2">
    ${renderOnline()}
    <div class="panel"><h3>Verein und Mannschaft</h3>
      <div class="row" style="margin-bottom:14px">
        <label class="field">Vereinsname<input value="${esc(DB.settings.verein)}" data-chg="setS" data-k="verein"></label>
        <label class="field">Mannschaft<input value="${esc(DB.settings.mannschaft)}" placeholder="z. B. weibliche D-Jugend" data-chg="setS" data-k="mannschaft"></label>
      </div>
      <div style="display:grid;gap:12px">${logoSlot('logoVerein','Vereinslogo')}${logoSlot('logoTeam','Mannschaftslogo')}</div>
      <p class="hint">Die Logos erscheinen in der Kopfzeile, auf der Spielerinnenkarte und auf jedem Ausdruck.</p>
    </div>
    <div class="panel"><h3>Speicherung</h3>
      <p>Jede Änderung wird sofort automatisch auf diesem Gerät gespeichert${SEC.key?', verschlüsselt':''}. Einen Speichern-Knopf braucht es nicht mehr.</p>
      <p class="hint">Die Daten liegen nur auf diesem Gerät${persisted?', der Browser hält sie dauerhaft vor':''}. Bis zum geräteübergreifenden Abgleich bitte regelmäßig unten „Daten sichern“ nutzen.</p>
    </div>
    <div class="panel"><h3>Passwortschutz</h3>
      ${SYNC.team?(SYNC.role==='owner'?`
        <p><span class="chip c1">aktiv</span> Das Mannschaftspasswort verschlüsselt alle Daten, auch auf dem Server. Wer es kennt, kann sich mit der Mannschaft verbinden.</p>
        <div class="row"><input type="password" id="pw1" placeholder="Neues Mannschaftspasswort" autocomplete="new-password"><input type="password" id="pw2" placeholder="Wiederholen" autocomplete="new-password"></div>
        <div class="row" style="margin-top:10px"><button class="btn" data-act="setPw">Passwort ändern</button></div>
        <p class="hint">Nach einer Änderung müssen verbundene Geräte einmal das neue Passwort eingeben.</p>`
        :'<p><span class="chip c1">aktiv</span> Die Daten sind mit dem Mannschaftspasswort verschlüsselt. Ändern kann es nur der Master.</p>'):!CRYPTO_OK?'<p>Dieser Browser unterstützt die Verschlüsselung nicht. Öffne die Datei in einem aktuellen Chrome, Edge, Firefox oder Safari.</p>':SEC.key?`
        <p><span class="chip c1">aktiv</span> Die Daten werden verschlüsselt gespeichert (AES-256). Beim Öffnen der App wird das Passwort abgefragt.</p>
        <div class="row"><input type="password" id="pw1" placeholder="Neues Passwort" autocomplete="new-password"><input type="password" id="pw2" placeholder="Wiederholen" autocomplete="new-password"></div>
        <div class="row" style="margin-top:10px"><button class="btn" data-act="setPw">Passwort ändern</button><button class="btn danger" data-act="removePw">Schutz entfernen</button></div>`:`
        <p>Optional. Mit Passwort werden alle Daten inklusive Fotos verschlüsselt gespeichert, z. B. auf einem gemeinsam genutzten Gerät.</p>
        <div class="row"><input type="password" id="pw1" placeholder="Passwort (mind. 6 Zeichen)" autocomplete="new-password"><input type="password" id="pw2" placeholder="Wiederholen" autocomplete="new-password"></div>
        <div class="row" style="margin-top:10px"><button class="btn" data-act="setPw">Passwort festlegen</button></div>`}
      ${SYNC.team?'':'<p class="hint">Wichtig: Ein vergessenes Passwort kann niemand zurücksetzen, auch nicht über eine Sicherung.</p>'}
    </div>
    <div class="panel" id="appPanel"><h3>Als App installieren</h3>
      ${matchMedia('(display-mode: standalone)').matches?'<p><span class="chip c1">installiert</span> Die Leistungsdiagnostik läuft als eigene App und funktioniert auch offline.</p>':`
      <p>Einmal installiert startet die Leistungsdiagnostik wie eine normale App, ohne Adressleiste, und funktioniert auch offline in der Halle.</p>
      ${installPrompt?'<div class="row"><button class="btn primary" data-act="install">Jetzt installieren</button></div>':`<ol class="steps">
        <li><b>iPad/iPhone (Safari):</b> Teilen-Symbol, dann „Zum Home-Bildschirm“.</li>
        <li><b>Android (Chrome):</b> Menü ⋮, dann „App installieren“.</li>
        <li><b>Windows/Mac (Chrome, Edge):</b> Installieren-Symbol rechts in der Adressleiste.</li></ol>`}`}
    </div>
    <div class="panel"><h3>Bisherige Datei übernehmen</h3>
      <p>Daten aus einer gespeicherten <b>Leistungsdiagnostik.html</b> übernehmen, auch wenn sie mit Passwort geschützt ist. Die aktuellen Daten werden dabei ersetzt.</p>
      <div class="row"><button class="btn" data-act="htmlIn">HTML-Datei übernehmen</button></div>
    </div>
    <div class="panel"><h3>Excel</h3>
      <p>Bisherige Datei übernehmen: Kader, alle Messungen und die Übungsbibliothek aus der alten Leistungsdiagnostik (.xlsm). Das passiert nur hier im Browser.</p>
      <div class="row"><button class="btn" data-act="xlsxIn">Excel-Datei übernehmen</button><button class="btn" data-act="xlsxOut">Als Excel exportieren</button></div>
      <p class="hint">Beide Funktionen laden beim ersten Mal ein Excel-Modul aus dem Internet, alles andere läuft offline.</p>
    </div>
    <div class="panel"><h3>Einstellungen</h3>
      <div class="row">
        <label class="field">Darstellung<select data-chg="setS" data-k="theme">${opt('hell','Hell',DB.settings.theme)}${opt('dunkel','Dunkel',DB.settings.theme)}${opt('system','wie Gerät',DB.settings.theme)}</select></label>
        <label class="field">Test überfällig nach (Tagen)<input type="number" min="30" value="${DB.settings.overdueDays}" data-chg="setOverdue" style="width:120px"></label>
      </div>
      <p class="hint">Datenmenge zurzeit etwa ${mb(JSON.stringify(DB).length)}. Fotos und vor allem Videos in der Übungsbibliothek machen sie größer.</p>
    </div>
    <div class="panel"><h3>Sicherung und Neuanfang</h3>
      <p>Alle Daten als JSON-Datei sichern, z. B. als Backup oder um sie auf ein anderes Gerät zu übertragen.</p>
      <div class="row"><button class="btn" data-act="jsonOut">Daten sichern (JSON)</button><button class="btn" data-act="jsonIn">Daten einspielen</button><button class="btn danger" data-act="wipe">Spielerinnen und Messungen löschen</button></div>
      <p class="hint">Stand: ${DB.meta.updated?new Date(DB.meta.updated).toLocaleString('de-DE'):'–'}, ${DB.players.length} Spielerinnen, ${DB.messungen.length} Messungen, ${DB.uebungen.length} Übungen.${SEC.key?' Achtung: Die JSON-Sicherung ist unverschlüsselt.':''}</p>
    </div>
  </div>`;
}

/* ---------- Training ---------- */
function renderTraining(){
  const s=ui.tr.sub;
  return `<div class="seg no-print" role="tablist">
    <button data-act="trSub" data-v="plan" aria-current="${s==='plan'}">Trainingsplan</button>
    <button data-act="trSub" data-v="team" aria-current="${s==='team'}">Teamprogramm</button>
    <button data-act="trSub" data-v="lib" aria-current="${s==='lib'}">Übungsbibliothek</button>
  </div>`+(s==='plan'?renderPlan():s==='team'?renderTeamProg():renderLib());
}
/* Übungsauswahl: Bereich, Altersklasse, Niveau, Ort; gemischt je Variante, dann nach Ort-Priorität sortiert */
function pickEx(bereich,o){
  let pool=DB.uebungen.filter(e=>e.bereich===bereich&&akIdx(e.ak)<=o.akMax);
  if(o.kraft)pool=pool.filter(e=>e.kraft);
  if(o.niveau&&o.niveau!=='alle')pool=pool.filter(e=>e.niveau===o.niveau);
  if(o.orte)pool=pool.filter(e=>o.orte.includes(e.ort));
  if(o.fehlt&&o.fehlt.size)pool=pool.filter(e=>matOk(e,o.fehlt));
  const total=pool.length;
  pool=shuffled(pool,o.seed+'|'+bereich);
  const pr=o.ortPrio||ORTE;
  pool.sort((a,b)=>pr.indexOf(a.ort)-pr.indexOf(b.ort));
  return {list:pool.slice(0,o.n),total};
}
function mediaHtml(e){
  const bs=e.bilder||[],vs=e.videos||[];
  const gal=bs.length>1?`<div class="gal">${bs.slice(1).map((b,i)=>`<button data-act="showImg" data-nr="${e.nr}" data-i="${i+1}" aria-label="Bild ${i+2} vergrößern"><img src="${esc(b)}" alt=""></button>`).join('')}</div>`:'';
  const vid=vs.length?`<div class="vids">${vs.map((v,i)=>v.typ==='link'
    ?`<a class="vbtn" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${esc(v.titel||'Video')}</a>`
    :`<button class="vbtn" data-act="showVid" data-nr="${e.nr}" data-i="${i}">${esc(v.titel||'Video')}</button>`).join('')}</div>`:'';
  return gal+vid;
}
function cover(e){const b=(e.bilder||[])[0];return b?`<button class="cover" data-act="showImg" data-nr="${e.nr}" data-i="0" aria-label="Bild vergrößern"><img src="${esc(b)}" alt=""></button>`:'';}
function exCard(e,extra){
  return `<article class="ex">
    ${cover(e)}
    <h3><span>${esc(e.name)}</span><small>Nr. ${e.nr}</small></h3>
    <div class="tagsrow"><span class="chip plain">${esc(e.ort)}</span><span class="chip plain">${esc(e.niveau)}</span>${e.faehigkeit?`<span class="chip plain">${esc(e.faehigkeit)}</span>`:''}</div>
    <p>${esc(e.text)}</p>
    <div class="facts"><span>Umfang <b>${esc(e.umfang||'–')}</b></span>${extra||''}<span>Material <b>${esc(e.material||'–')}</b></span></div>
    ${e.tipp?`<div class="tipp">${esc(e.tipp)}</div>`:''}
    ${mediaHtml(e)}
  </article>`;
}
function halleSelect(scope,val){
  const hs=DB.settings.hallen||[];
  return `<label class="field" style="grid-column:span 2">Halle / Material<span class="row" style="gap:6px;flex-wrap:nowrap"><select data-chg="${scope}" data-k="halle" style="flex:1;min-width:0">${opt('','Alles vorhanden',val)}${hs.map(h=>opt(h.id,h.name,val)).join('')}<option value="__neu">Neues Materialprofil …</option></select>
    ${val&&halleById(val)?`<button class="btn small" data-act="matEdit" data-v="${val}">Bearbeiten</button>`:''}</span></label>`;
}
function matEditor(){
  const h=halleById(ui.matEdit);if(!h)return '';
  const f=new Set(h.fehlt),ms=allMaterials();
  return `<div class="panel no-print" style="margin:6px 0 14px">
    <div class="section-h" style="margin:0 0 8px"><h2>Material in „${esc(h.name)}“</h2>
      <span class="row"><button class="btn small" data-act="halleRename" data-v="${h.id}">Umbenennen</button><button class="btn small danger" data-act="halleDel" data-v="${h.id}">Löschen</button><button class="btn small primary" data-act="matEdit" data-v="">Fertig</button></span></div>
    <p class="hint" style="margin-top:0">Antippen, was in dieser Halle <b>fehlt</b>. Übungen, die dieses Material brauchen, werden dann nicht mehr vorgeschlagen. Bei Angaben wie „Bank / Stuhl“ reicht eines davon.</p>
    <div class="matgrid">${ms.map(x=>`<button data-act="matToggle" data-v="${esc(x.m)}" aria-pressed="${!f.has(x.m)}" title="${x.n} Übung${x.n>1?'en':''}">${esc(x.m)} <small>${x.n}</small></button>`).join('')}</div>
    <p class="hint" style="margin-bottom:0">${f.size?f.size+' Material'+(f.size>1?'ien':'')+' fehlen, '+DB.uebungen.filter(e=>!matOk(e,f)).length+' Übungen ausgeblendet.':'Alles vorhanden.'}</p>
  </div>`;
}
function playerAk(p){const ak=ageClass(p.jahrgang);return ak==='F-Jugend'?'E-Jugend':ak;}
function priorities(p){
  return TESTS.map(t=>{const l=lastOf(p.id,t.key),r=rankInJg(p,t);
    return {t,l,c:l?cat(t,l.v,p):null,r,key:l?cat(t,l.v,p)+(r?r.rank/(r.n+1):0)*.99:-1};})
    .sort((a,b)=>b.key-a.key).map((x,i)=>Object.assign(x,{prio:x.l?i+1:null}));
}
function renderPlan(){
  if(!DB.players.length)return emptyState();
  const list=DB.players.slice().sort(byName);
  const p=pById(ui.pid)||list[0];ui.pid=p.id;
  const o=ui.tr,{pri,autoAk,ak,secs}=planSections(p,o);
  const testOpts=sel=>opt('auto','automatisch',sel)+TESTS.map(t=>opt(t.name,t.name,sel)).join('');
  return `
  <div class="pick">${playerPicker(list,p)}<span style="flex:1"></span>
    <button class="btn no-print" data-act="open" data-v="${p.id}">Profil</button><button class="btn ghost no-print" data-act="print">Drucken</button></div>
  <div class="panel scroll">
    <table class="pr"><thead><tr><th>Förder&shy;priorität</th><th>Test</th><th>Letzter Wert</th><th>DHB-Einordnung</th><th>Rang im Jahrgang</th></tr></thead><tbody>
    ${pri.map(x=>`<tr><td class="pnum">${x.prio||'–'}</td><td><b>${x.t.name}</b></td><td class="num" style="font-size:19px">${x.l?fmt(x.t,x.l.v)+' <small class="muted">'+x.t.unit+'</small>':'–'}</td><td>${chip(x.c)}</td><td>${x.r?x.r.rank+' von '+x.r.n:'–'}</td></tr>`).join('')}
    </tbody></table>
    <p class="hint" style="margin-bottom:0">Priorität 1 = größter Förderbedarf: schwächste DHB-Einordnung, bei Gleichstand entscheidet der Rang im Jahrgang.</p>
  </div>
  <div class="section-h no-print"><h2>Plan einstellen</h2><button class="btn" data-act="reroll">Andere Übungen</button></div>
  <div class="opts no-print">
    <label class="field">Schwerpunkt 1<select data-chg="tr" data-k="s1">${testOpts(o.s1)}</select></label>
    <label class="field">Schwerpunkt 2<select data-chg="tr" data-k="s2">${testOpts(o.s2)}</select></label>
    <label class="field">Zusatzbereich<select data-chg="tr" data-k="extra">${opt('','keiner',o.extra)}${allBereiche().filter(b=>b!==RUMPF).map(b=>opt(b,b,o.extra)).join('')}</select></label>
    <label class="field">Niveau<select data-chg="tr" data-k="niveau">${opt('alle','alle',o.niveau)}${NIVEAUS.map(n=>opt(n,n,o.niveau)).join('')}</select></label>
    <label class="field">Ort<select data-chg="tr" data-k="ort">${opt('alle','alle passenden',o.ort)}${ORTE.map(n=>opt(n,'nur '+n,o.ort)).join('')}</select></label>
    ${halleSelect('tr',o.halle)}
    <label class="field">Altersklasse<select data-chg="tr" data-k="ak">${opt('auto','automatisch ('+autoAk+')',o.ak)}${AKS.map(n=>opt(n,n,o.ak)).join('')}</select></label>
  </div>
  ${matEditor()}
  <p class="hint no-print">${o.halle&&halleById(o.halle)?'Material: „'+esc(halleById(o.halle).name)+'“, Übungen mit fehlendem Material sind ausgeblendet. ':''}Vorgeschlagen werden nur Übungen bis zur ${ak}. „Alle passenden“: bis C-Jugend Hometraining zuerst, ab B-Jugend Fitnessstudio zuerst. Variante ${o.variante}.</p>
  ${secs.map(s=>{const r=s.r;return `
    <div class="section-h"><h2>${esc(s.title)}</h2><span class="hint">${r.total} passende Übungen in der Bibliothek</span></div>
    ${r.list.length?`<div class="exlist">${r.list.map(e=>exCard(e)).join('')}</div>`:'<div class="panel empty">Keine passende Übung. Filter lockern oder in der Übungsbibliothek ergänzen.</div>'}`;}).join('')}
  ${PLAN_HINTS}`;
}
const PLAN_AUTO={s1:'auto',s2:'auto',extra:'',halle:'',niveau:'alle',ort:'alle',variante:1,ak:'auto'};
function planSections(p,o){
  const pri=priorities(p),withVal=pri.filter(x=>x.l);
  const autoAk=playerAk(p),ak=o.ak==='auto'?autoAk:o.ak,akMax=akIdx(ak);
  const s1=o.s1==='auto'?(withVal[0]&&withVal[0].t.name):o.s1;
  let s2=o.s2==='auto'?(withVal.find(x=>x.t.name!==s1)||{}).t:null;s2=o.s2==='auto'?(s2&&s2.name):o.s2;
  const young=akMax<=2;
  const ortMap={'alle':null,'Zuhause':['Zuhause'],'Halle/Platz':['Halle/Platz'],'Fitnessstudio':['Fitnessstudio']};
  const base={akMax,niveau:o.niveau,orte:ortMap[o.ort],ortPrio:young?['Zuhause','Halle/Platz','Fitnessstudio']:['Fitnessstudio','Zuhause','Halle/Platz'],seed:p.id+'|'+o.variante,fehlt:fehltSet(o.halle)};
  const secs=[];
  if(s1)secs.push({title:'Schwerpunkt 1: '+s1,b:s1,n:6});
  if(s2&&s2!==s1)secs.push({title:'Schwerpunkt 2: '+s2,b:s2,n:4});
  secs.push({title:'Immer dabei: '+RUMPF,b:RUMPF,n:3});
  if(o.extra&&o.extra!==s1&&o.extra!==s2&&o.extra!==RUMPF&&allBereiche().includes(o.extra))secs.push({title:'Zusatz: '+o.extra,b:o.extra,n:3});
  secs.forEach(s=>{s.r=pickEx(s.b,Object.assign({},base,{n:s.n}));});
  return {pri,autoAk,ak,secs};
}
const PLAN_HINTS=`<div class="section-h"><h2>Allgemeine Hinweise</h2></div>
  <div class="panel"><ul style="margin:0;padding-left:20px">
    <li>E- bis C-Jugend: 2–3 kurze Einheiten pro Woche (15–20 min) als Hometraining mit Körpergewicht, Mini- und Therabändern.</li>
    <li>Ab B-Jugend: 2 Krafteinheiten pro Woche im Fitnessstudio sinnvoll. Technik zuerst mit leichtem Gewicht, Steigerung nur bei sauberer Ausführung, am besten mit Trainerin oder Trainer.</li>
    <li>Immer aufwärmen. Technik vor Tempo, Tempo vor Last. Bei Schmerzen abbrechen.</li>
    <li>Sprint- und Sprungübungen nur ausgeruht und mit vollen Pausen, Qualität zählt.</li>
    <li>Nach 6–8 Wochen erneut testen. Der Plan passt sich automatisch an die neuen Werte an.</li>
  </ul></div>`;

/* Teamprogramm */
function renderTeamProg(){
  if(!DB.players.length)return emptyState();
  const o=ui.tp;
  const ps=DB.players.filter(p=>!o.jg.size||o.jg.has(p.jahrgang));
  if(!ps.length)return `<div class="filters">${jgToggle(o.jg,'tpJg')}</div><div class="panel empty">Keine Spielerinnen in dieser Auswahl.</div>`;
  const youngest=Math.max(...ps.map(p=>p.jahrgang||0));
  const ak=ps.some(p=>p.jahrgang)?(ageClass(youngest)==='F-Jugend'?'E-Jugend':ageClass(youngest)):'E-Jugend',akMax=akIdx(ak);
  const stats=TESTS.map(t=>{
    const cs=ps.map(p=>{const l=lastOf(p.id,t.key);return l?cat(t,l.v,p):null;}).filter(Boolean);
    const avg=cs.length?cs.reduce((a,b)=>a+b,0)/cs.length:null,low=cs.filter(c=>c>=4).length;
    return {t,n:cs.length,avg,low,prio:t.key==='shuttle'||avg==null?-1:avg+.5*low/cs.length};
  });
  const ranked=stats.filter(s=>s.prio>=0).sort((a,b)=>b.prio-a.prio);
  ranked.forEach((s,i)=>s.rank=i+1);
  const integ=o.format==='integriert';
  const ortAuto=integ||akMax<=2?'Halle/Platz':'Fitnessstudio';
  const ort=o.ort==='auto'?ortAuto:o.ort;
  const orte=ort==='Fitnessstudio'?ORTE:['Zuhause','Halle/Platz'];
  const ortPrio=ort==='Fitnessstudio'?['Fitnessstudio','Halle/Platz','Zuhause']:['Halle/Platz','Zuhause'];
  const base={akMax,kraft:true,orte,ortPrio,seed:'team|'+[...o.jg].sort().join(',')+'|'+o.variante+'|'+o.format,fehlt:fehltSet(o.halle)};
  const P=i=>ranked[i]?ranked[i].t.name:null;
  const plan=integ?[[P(0),2,'Station'],[P(1),1,'Station'],[P(2),1,'Station'],[RUMPF,1,'Station']]
                  :[[P(0),3,'A'],[P(1),2,'B'],[P(2),2,'C'],[RUMPF,3,'D']];
  const used=new Set(),blocks=[];let st=0;
  plan.forEach(([b,n,label])=>{if(!b)return;
    const r=pickEx(b,Object.assign({},base,{n:n+6}));
    r.list.filter(e=>!used.has(e.nr)).slice(0,n).forEach(e=>{used.add(e.nr);st++;
      blocks.push({label:integ?'Station '+st:label,sub:b,e,
        umfang:integ?'40 s Belastung, 20 s Wechsel, 2 Runden':e.umfang,
        pause:integ?'20 s Wechsel':b===RUMPF?'30 s':'60–90 s zwischen den Sätzen',
        min:integ?2:b===RUMPF?3:5});});
  });
  const start={label:'Start',h:integ?'Aktivierung':'Aufwärmen',p:integ?'Stationen aufbauen, kurz erklären, Spielerinnen paarweise auf die 5 Stationen verteilen. Direkt nach dem Handball-Aufwärmen starten.':'Einlaufen und Mobilisation, dann präventives Aufwärmen: Sprünge mit stabiler Landung, Ausfallschritte, Kniebeugen, Stützübungen, Schulter mit Band.',min:integ?2:10};
  const ende={label:'Ende',h:integ?'Abbau':'Cool-down',p:integ?'Material wegräumen, weiter mit dem Handballtraining.':'Lockeres Auslaufen, Dehnen der beanspruchten Muskulatur (Beine, Hüfte, Schulter).',min:integ?1:5};
  const sum=start.min+ende.min+blocks.reduce((a,b)=>a+b.min,0);
  return `
  <div class="filters no-print"><div class="field">Jahrgänge${jgToggle(o.jg,'tpJg')}</div><span style="flex:1"></span><button class="btn ghost" data-act="print">Drucken</button></div>
  <div class="opts no-print">
    <label class="field">Format<select data-chg="tp" data-k="format">${opt('integriert','Integriert (max. 15 min)',o.format)}${opt('kraft','Krafttraining (45–60 min)',o.format)}</select></label>
    <label class="field">Ort<select data-chg="tp" data-k="ort">${opt('auto','automatisch ('+ortAuto+')',o.ort)}${opt('Halle/Platz','Halle/Platz',o.ort)}${opt('Fitnessstudio','Fitnessstudio',o.ort)}</select></label>
    ${halleSelect('tp',o.halle)}
    <div class="field">Übungen<button class="btn" data-act="tpReroll">Andere Übungen</button></div>
  </div>
  ${matEditor()}
  <p class="hint">${o.halle&&halleById(o.halle)?'Material: „'+esc(halleById(o.halle).name)+'“. ':''}${ps.length} Spielerinnen in der Gruppe. Übungen bis zur ${ak} (jüngster Jahrgang), nur Übungen, die in der Bibliothek als Kräftigung markiert sind.</p>
  <div class="panel scroll">
    <table class="pr"><thead><tr><th>Team&shy;priorität</th><th>Test</th><th>Mit Wert</th><th>Ø DHB-Einordnung</th><th>Unter dem Durchschnitt</th></tr></thead><tbody>
    ${stats.slice().sort((a,b)=>(a.rank||99)-(b.rank||99)).map(s=>`<tr><td class="pnum">${s.rank||'–'}</td><td><b>${s.t.name}</b></td><td>${s.n}</td><td>${s.avg?chip(Math.round(s.avg)):'–'}</td>
      <td>${s.t.key==='shuttle'?'<span class="muted">Ausdauer separat trainieren</span>':s.n?`<span class="${s.low?'down':''}">${s.low} von ${s.n}</span>`:'–'}</td></tr>`).join('')}
    </tbody></table>
    <p class="hint" style="margin-bottom:0">Teampriorität: Ø DHB-Einordnung plus Anteil der Spielerinnen unter dem Durchschnitt. Ausdauer gehört nicht ins Kräftigungsprogramm.</p>
  </div>
  <div class="section-h"><h2>Kräftigungsprogramm: ${integ?'integriert, max. 15 min':'Krafttraining, 45–60 min'}</h2><span class="hint">Gesamtdauer ca. ${sum} min</span></div>
  <div class="panel" style="padding:6px 16px">
    <div class="blk"><div class="bl">${start.label}</div><div><h4>${start.h}</h4><p>${start.p}</p></div><div class="tm">${start.min}′</div></div>
    ${blocks.map(b=>`<div class="blk"><div class="bl">${b.label}<small>${esc(b.sub)}</small></div>
      <div><h4>${esc(b.e.name)}</h4><p>${esc(b.e.text)}</p>
        <p class="hint">Umfang: <b>${esc(b.umfang)}</b>. Pause: ${esc(b.pause)}. Material: ${esc(b.e.material||'–')}. Ort: ${esc(b.e.ort)}.</p>
        ${b.e.tipp?`<div class="tipp" style="font-size:14px;border-left:4px solid #FFCE00;padding-left:10px">${esc(b.e.tipp)}</div>`:''}
        ${(b.e.bilder||[]).length?`<div class="gal" style="margin-top:6px">${b.e.bilder.map((x,i)=>`<button data-act="showImg" data-nr="${b.e.nr}" data-i="${i}" aria-label="Bild vergrößern"><img src="${esc(x)}" alt=""></button>`).join('')}</div>`:''}
        ${(b.e.videos||[]).length?`<div style="margin-top:6px">${mediaHtml({nr:b.e.nr,videos:b.e.videos})}</div>`:''}</div>
      <div class="tm">${b.min}′</div></div>`).join('')}
    <div class="blk"><div class="bl">${ende.label}</div><div><h4>${ende.h}</h4><p>${ende.p}</p></div><div class="tm">${ende.min}′</div></div>
  </div>
  <div class="section-h"><h2>Hinweise für das Trainerteam</h2></div>
  <div class="panel"><ul style="margin:0;padding-left:20px">
    ${integ?'<li>Zirkel: 5 Stationen, je 2 Spielerinnen pro Station. 40 s arbeiten, 20 s zur nächsten Station wechseln, nach 5 Stationen zweite Runde.</li><li>Ideal direkt nach dem Aufwärmen (frisch für Sprung- und Wurfübungen) oder als Abschluss, 1–2 Mal pro Woche.</li>'
      :'<li>Blöcke nacheinander: A (Schwerpunkt 1), B, C, dann D (Rumpf und Prävention als Zirkel). Spielerinnen in 2er- oder 3er-Gruppen, Sätze im Wechsel.</li><li>Gewichte und Bänder individuell wählen: Die letzte Wiederholung soll anstrengend, aber noch sauber sein. 1–2 Mal pro Woche, nicht direkt vor einem Spiel.</li>'}
    <li>Bis zur C-Jugend mit Körpergewicht, Mini- und Therabändern und leichten Medizinbällen arbeiten; Langhantelübungen erst ab B-Jugend nach Technikschulung.</li>
    <li>Technik vor Last, bei Schmerzen abbrechen. Nach 6–8 Wochen neu testen, das Programm passt sich an die neuen Werte an.</li>
  </ul></div>`;
}

/* Übungsbibliothek */
function renderLib(){
  const f=ui.lib,q=f.q.trim().toLowerCase(),extra=DB.settings.bereicheExtra;
  const list=DB.uebungen.filter(e=>(!f.bereich||e.bereich===f.bereich)&&(!f.niveau||e.niveau===f.niveau)&&(!f.ort||e.ort===f.ort)&&(!f.ak||e.ak===f.ak)
    &&(!q||(e.name+' '+e.faehigkeit+' '+e.text+' '+e.material).toLowerCase().includes(q))).sort((a,b)=>a.nr-b.nr);
  const sel=(k,label,vals)=>`<label class="field">${label}<select data-chg="lib" data-k="${k}">${opt('','alle',f[k])}${vals.map(v=>opt(v,v,f[k])).join('')}</select></label>`;
  const withMedia=e=>((e.bilder||[]).length?', '+e.bilder.length+' Bild'+(e.bilder.length>1?'er':''):'')+((e.videos||[]).length?', '+e.videos.length+' Video'+(e.videos.length>1?'s':''):'');
  return `
  <div class="panel no-print" style="margin-bottom:16px">
    <h3>Sammlung erweitern</h3>
    <div class="row">
      <button class="btn primary" data-act="addEx">Neue Übung anlegen</button>
      <button class="btn" data-act="importEx">Übungen aus Excel oder CSV hinzufügen</button>
      <button class="btn ghost" data-act="exTemplate">Vorlage herunterladen</button>
      <button class="btn ghost" data-act="exExport">Bibliothek exportieren</button>
    </div>
    <p class="hint">Vorlage ausfüllen, dann hinzufügen: Neue Übungen werden angehängt, Übungen mit gleichem Namen übersprungen. Bilder und Videos hängst du danach direkt an der Übung an.</p>
    <div class="bchips"><span class="hint">Eigene Bereiche:</span>${extra.map(b=>`<span class="chip plain">${esc(b)} <button data-act="delBereich" data-v="${esc(b)}" aria-label="Bereich ${esc(b)} entfernen" title="entfernen">×</button></span>`).join('')||'<span class="hint">noch keine</span>'}
      <button class="btn small" data-act="addBereich">Bereich hinzufügen</button></div>
  </div>
  <div class="opts no-print">
    <label class="field">Suche<input type="search" value="${esc(f.q)}" data-chg="lib" data-k="q" placeholder="Name, Fähigkeit, Material"></label>
    ${sel('bereich','Bereich',allBereiche())}${sel('niveau','Niveau',NIVEAUS)}${sel('ort','Ort',ORTE)}${sel('ak','ab Altersklasse',AKS)}
  </div>
  <div class="section-h"><h2>${list.length} von ${DB.uebungen.length} Übungen</h2></div>
  <div class="panel" style="padding:4px 12px">${list.map(e=>`<div class="libitem">
    <button data-act="libOpen" data-v="${e.nr}" aria-expanded="${f.open===e.nr}"><span class="nr">${e.nr}</span>
      <span class="nm"><b>${esc(e.name)}</b><small>${esc(e.bereich)}, ${esc(e.faehigkeit||'–')}, ${esc(e.niveau)}, ab ${esc(e.ak)}${withMedia(e)}</small></span>
      <span class="chip plain">${esc(e.ort)}${e.kraft?', Kräftigung':''}</span></button>
    ${f.open===e.nr?libEdit(e):''}</div>`).join('')||'<div class="empty">Keine Übung passt zu diesen Filtern.</div>'}</div>
  <p class="hint">„Kräftigung“ = für das Teamprogramm geeignet. Eigene Bereiche (z. B. Koordination) erscheinen im Trainingsplan als „Zusatzbereich“.</p>`;
}
function libEdit(e){
  const inp=(k,label,cls)=>`<label class="field ${cls||''}">${label}<input value="${esc(e[k])}" data-chg="exF" data-nr="${e.nr}" data-k="${k}"></label>`;
  const sel=(k,label,vals,more)=>`<label class="field">${label}<select data-chg="exF" data-nr="${e.nr}" data-k="${k}">${vals.map(v=>opt(v,v,e[k])).join('')}${more||''}</select></label>`;
  const bs=e.bilder||[],vs=e.videos||[];
  return `<div class="libedit">
    ${inp('name','Übung','wide')}
    ${sel('bereich','Bereich',allBereiche(),'<option value="__neu">Neuer Bereich …</option>')}${inp('faehigkeit','Fähigkeit')}${sel('niveau','Niveau',NIVEAUS)}${sel('ak','ab Altersklasse',AKS)}${sel('ort','Ort',ORTE)}
    <label class="field">Kräftigung<select data-chg="exF" data-nr="${e.nr}" data-k="kraft">${opt('1','ja',e.kraft?'1':'0')}${opt('0','nein',e.kraft?'1':'0')}</select></label>
    <label class="field wide">Beschreibung<textarea data-chg="exF" data-nr="${e.nr}" data-k="text" rows="4">${esc(e.text)}</textarea></label>
    ${inp('umfang','Umfang')}${inp('material','Material')}${inp('tipp','Coaching-Tipp','wide')}
    <div class="media-edit">
      <div><b>Bilder</b> <span class="hint">das erste Bild erscheint groß im Trainingsplan</span></div>
      <div class="thumbs">${bs.map((b,i)=>`<div class="th"><img src="${esc(b)}" alt="Bild ${i+1}"><button data-act="exImgDel" data-v="${e.nr}" data-i="${i}" aria-label="Bild ${i+1} entfernen">×</button></div>`).join('')}
        <label class="btn small" style="align-self:center">Bilder hinzufügen<input type="file" accept="image/*" multiple hidden data-chg="exImg" data-nr="${e.nr}"></label></div>
      <div><b>Videos</b> <span class="hint">Links (YouTube, Vimeo, Cloud) halten die Datei klein; Videodateien bis 20 MB werden direkt eingebettet</span></div>
      ${vs.map((v,i)=>`<div class="vl"><span class="chip plain">${v.typ==='link'?'Link':'Datei, '+mb(v.size||0)}</span>
        ${v.typ==='link'?`<a href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${esc(v.titel||v.url)}</a>`:`<button class="btn ghost small" data-act="showVid" data-nr="${e.nr}" data-i="${i}">${esc(v.titel||'Video')} abspielen</button>`}
        <button class="btn ghost small danger" data-act="delVid" data-v="${e.nr}" data-i="${i}">Entfernen</button></div>`).join('')}
      <div class="row">
        <input id="vidUrl" type="url" placeholder="https://… Video-Link" style="flex:2;min-width:220px">
        <input id="vidTitle" placeholder="Titel (optional)" style="flex:1;min-width:140px">
        <button class="btn small" data-act="addVidLink" data-v="${e.nr}">Link hinzufügen</button>
        <label class="btn small">Videodatei hinzufügen<input type="file" accept="video/*" hidden data-chg="exVid" data-nr="${e.nr}"></label>
      </div>
    </div>
    <div class="row wide">
      <button class="btn small" data-act="dupEx" data-v="${e.nr}">Duplizieren</button>
      <span style="flex:1"></span><button class="btn ghost small danger" data-act="delEx" data-v="${e.nr}">Übung löschen</button>
    </div></div>`;
}

/* ---------- Excel ---------- */
function loadXLSX(){
  if(window.XLSX)return Promise.resolve(window.XLSX);
  return new Promise((res,rej)=>{const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload=()=>{res(window.XLSX);s.remove();};s.onerror=()=>{s.remove();rej(new Error('offline'));};document.head.appendChild(s);});
}
function serialToDate(s){return new Date(Math.round((s-25569)*864e5)).toISOString().slice(0,10);}
function importXlsx(buf){
  const wb=XLSX.read(buf,{type:'array'});
  const sh=wb.Sheets['DB_Messwerte'];
  if(!sh){toast('In der Datei fehlt das Blatt „DB_Messwerte“.');return;}
  const players={},ms=[],num=x=>typeof x==='number'?x:null;
  const kader=wb.Sheets['Kader'];
  if(kader){
    const rows=XLSX.utils.sheet_to_json(kader,{header:1,raw:true});
    const h=rows.findIndex(r=>String(r[0]||'').startsWith('Name'));
    rows.slice(h+1).forEach(r=>{const n=String(r[0]||'').trim();if(n&&n.includes(',')&&typeof r[1]==='number')
      players[n]={id:uid('p'),name:n,jahrgang:r[1],geb:typeof r[2]==='number'?serialToDate(r[2]):'',position:'',notiz:'',foto:''};});
  }
  XLSX.utils.sheet_to_json(sh,{header:1,raw:true}).slice(1).forEach(r=>{
    const n=String(r[0]||'').trim();if(!n||typeof r[1]!=='number')return;
    if(!players[n])players[n]={id:uid('p'),name:n,jahrgang:num(r[9]),geb:'',position:'',notiz:'',foto:''};
    const s=num(r[4]);
    ms.push({id:uid('m'),pid:players[n].id,monat:serialToDate(r[1]).slice(0,7),name:String(r[2]||''),bem:'',
      w:{sprung:num(r[3]),shuttle:s==null?null:(s<1?Math.round(s*86400):s),liege:num(r[5]),wurf:num(r[6]),sprint:num(r[7])}});
  });
  /* Positionen stehen in den Einzelblättern (Zeile „Position“) */
  Object.values(players).forEach(p=>{const ws=wb.Sheets[p.name];if(!ws)return;
    const rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,range:0}).slice(0,12);
    rows.forEach(r=>{const i=r.findIndex(x=>x==='Position');if(i>=0&&typeof r[i+1]==='string'&&r[i+1]!=='–')p.position=r[i+1];});});
  let ex=null;const us=wb.Sheets['Übungen'];
  if(us){ex=[];XLSX.utils.sheet_to_json(us,{header:1,raw:true}).forEach(r=>{if(typeof r[0]!=='number'||!r[1])return;
    ex.push({nr:r[0],name:String(r[1]),bereich:r[2]?addBereich(String(r[2])):RUMPF,faehigkeit:r[3]||'',niveau:NIVEAUS.includes(r[4])?r[4]:'Einsteiger',
      ak:AKS.includes(r[5])?r[5]:'E-Jugend',ort:ORTE.includes(r[6])?r[6]:'Zuhause',text:r[7]||'',umfang:r[8]||'',material:r[9]||'',tipp:r[10]||'',kraft:r[12]==='ja',bilder:[],videos:[]});});
    if(!ex.length)ex=null;}
  const P=Object.values(players);
  if(!P.length){toast('Keine Spielerinnen in der Datei gefunden.');return;}
  if(!confirm(`Gefunden: ${P.length} Spielerinnen, ${ms.length} Messungen${ex?' und '+ex.length+' Übungen':''}. Die aktuellen Daten werden dabei ersetzt. Fortfahren?`))return;
  DB.players=P;DB.messungen=ms;if(ex)DB.uebungen=ex;ui.pid=null;changed();go('team');
  toast('Excel übernommen. Fotos bitte im Kader ergänzen.');
}
async function exportXlsx(){
  let X;try{X=await loadXLSX();}catch(e){toast('Für den Excel-Export wird einmalig eine Internetverbindung gebraucht.');return;}
  const ps=DB.players.slice().sort(byName);
  const kader=ps.map(p=>({Name:p.name,Jahrgang:p.jahrgang,Geburtsdatum:p.geb,Altersklasse:ageClass(p.jahrgang),Position:p.position,Notiz:p.notiz}));
  const mess=[];
  ps.forEach(p=>mOf(p.id).forEach(m=>{const r={Name:p.name,Jahrgang:p.jahrgang,Monat:m.monat,Bezeichnung:m.name};
    TESTS.forEach(t=>{r[t.name+' ('+(t.time?'s':t.unit)+')']=m.w[t.key]==null?null:m.w[t.key];});
    r['Shuttle-Run (m:ss)']=m.w.shuttle==null?null:fmt(T('shuttle'),m.w.shuttle);r.Bemerkung=m.bem;mess.push(r);}));
  const ex=exRows();
  const wb=X.utils.book_new();
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(kader),'Kader');
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(mess),'Messungen');
  X.utils.book_append_sheet(wb,X.utils.json_to_sheet(ex),'Übungen');
  X.writeFile(wb,'Leistungsdiagnostik_Export.xlsx');
}

const EX_HEAD=['Nr.','Übung','Bereich','Fähigkeit','Niveau','ab Altersklasse','Ort','Beschreibung','Umfang','Material','Coaching-Tipp','Kräftigung','Video-Links'];
function exRows(){return DB.uebungen.slice().sort((a,b)=>a.nr-b.nr).map(e=>{const r={};const v=[e.nr,e.name,e.bereich,e.faehigkeit,e.niveau,e.ak,e.ort,e.text,e.umfang,e.material,e.tipp,e.kraft?'ja':'nein',
  (e.videos||[]).filter(x=>x.typ==='link').map(x=>x.url).join(' ')];EX_HEAD.forEach((h,i)=>r[h]=v[i]);return r;});}
async function exTemplate(){
  let X;try{X=await loadXLSX();}catch(e){toast('Für die Vorlage wird einmalig eine Internetverbindung gebraucht.');return;}
  const ws=X.utils.aoa_to_sheet([EX_HEAD.slice(1),
    ['Beispiel: Sternlauf mit Ball',TESTS[4].name,'Richtungswechsel','Einsteiger','D-Jugend','Halle/Platz','1) Vier Hütchen im Quadrat. 2) Von der Mitte aus jedes Hütchen antippen und zurück. 3) Ball dabei prellen.','4 × 30 s','Hütchen, Ball','Tiefer Körperschwerpunkt beim Wenden.','nein','https://www.youtube.com/watch?v=…']]);
  ws['!cols']=[{wch:30},{wch:18},{wch:18},{wch:14},{wch:14},{wch:14},{wch:60},{wch:12},{wch:16},{wch:40},{wch:10},{wch:40}];
  const n=Math.max(allBereiche().length,AKS.length,ORTE.length);
  const ref=[['Bereich','Niveau','ab Altersklasse','Ort','Kräftigung']];
  for(let i=0;i<n;i++)ref.push([allBereiche()[i]||'',NIVEAUS[i]||'',AKS[i]||'',ORTE[i]||'',['ja','nein'][i]||'']);
  ref.push([],['Neue Bereiche sind erlaubt und werden beim Hinzufügen angelegt.'],['Zeilen, die mit „Beispiel:“ beginnen, werden ignoriert.'],['Mehrere Video-Links durch Leerzeichen trennen.']);
  const wb=X.utils.book_new();X.utils.book_append_sheet(wb,ws,'Übungen');X.utils.book_append_sheet(wb,X.utils.aoa_to_sheet(ref),'Auswahlwerte');
  X.writeFile(wb,'Uebungen_Vorlage.xlsx');
}
async function exExport(){
  let X;try{X=await loadXLSX();}catch(e){toast('Für den Export wird einmalig eine Internetverbindung gebraucht.');return;}
  const wb=X.utils.book_new();X.utils.book_append_sheet(wb,X.utils.json_to_sheet(exRows(),{header:EX_HEAD}),'Übungen');X.writeFile(wb,'Uebungsbibliothek.xlsx');
}
async function importEx(){
  let X;try{X=await loadXLSX();}catch(e){toast('Für den Import wird einmalig eine Internetverbindung gebraucht.');return;}
  const f=await pickFile('.xlsx,.xlsm,.xls,.csv');if(!f)return;
  let rows;
  try{const wb=X.read(await f.arrayBuffer(),{type:'array'});const ws=wb.Sheets['Übungen']||wb.Sheets[wb.SheetNames[0]];rows=X.utils.sheet_to_json(ws,{header:1,raw:true,defval:''});}
  catch(e){toast('Die Datei konnte nicht gelesen werden.');return;}
  const norm=x=>String(x==null?'':x).trim().toLowerCase();
  const hi=rows.findIndex(r=>r.some(c=>norm(c)==='übung'||norm(c)==='uebung'));
  if(hi<0){toast('Keine Spalte „Übung“ gefunden. Am besten die Vorlage verwenden.');return;}
  const H=rows[hi].map(norm),col=(...n)=>H.findIndex(h=>n.some(x=>h.startsWith(x)));
  const C={name:col('übung','uebung'),bereich:col('bereich'),faehigkeit:col('fähigkeit','faehigkeit'),niveau:col('niveau'),ak:col('ab altersklasse','altersklasse'),ort:col('ort'),
    text:col('beschreibung'),umfang:col('umfang'),material:col('material'),tipp:col('coaching','tipp'),kraft:col('kräftigung','kraeftigung'),vid:col('video')};
  const get=(r,k)=>C[k]<0?'':String(r[C[k]]==null?'':r[C[k]]).trim();
  const known=new Set(DB.uebungen.map(e=>norm(e.name))),neuB=new Set(),add=[];let dup=0;
  rows.slice(hi+1).forEach(r=>{
    const name=get(r,'name');if(!name||/^beispiel:/i.test(name))return;
    if(known.has(norm(name))){dup++;return;}known.add(norm(name));
    let b=get(r,'bereich')||RUMPF;const hit=allBereiche().find(x=>norm(x)===norm(b));if(hit)b=hit;else neuB.add(b);
    const nv=/^fort/i.test(get(r,'niveau'))?'Fortgeschritten':'Einsteiger';
    const akRaw=get(r,'ak');const ak=AKS.find(a=>norm(a)===norm(akRaw))||AKS.find(a=>akRaw&&a[0]===akRaw.toUpperCase()[0]&&akRaw.length<=2)||(/aktiv/i.test(akRaw)?'Aktive':'E-Jugend');
    const o=get(r,'ort');const ort=/studio|fitness/i.test(o)?'Fitnessstudio':/halle|platz/i.test(o)?'Halle/Platz':'Zuhause';
    const vids=get(r,'vid').split(/\s+/).filter(isHttp).map(u=>({typ:'link',url:u,titel:'Video'}));
    add.push({name,bereich:b,faehigkeit:get(r,'faehigkeit'),niveau:nv,ak,ort,text:get(r,'text'),umfang:get(r,'umfang'),material:get(r,'material'),tipp:get(r,'tipp'),
      kraft:/^(ja|x|1|true|yes)$/i.test(get(r,'kraft')),bilder:[],videos:vids});
  });
  if(!add.length){toast(dup?'Alle '+dup+' Übungen gibt es schon.':'Keine Übungen in der Datei gefunden.');return;}
  if(!confirm(`${add.length} neue Übungen hinzufügen?${dup?' '+dup+' mit gleichem Namen werden übersprungen.':''}${neuB.size?' Neue Bereiche: '+[...neuB].join(', ')+'.':''}`))return;
  let nr=DB.uebungen.reduce((m,e)=>Math.max(m,e.nr),0);
  neuB.forEach(addBereich);add.forEach(e=>{e.nr=++nr;DB.uebungen.push(e);});
  Object.assign(ui.lib,{q:'',bereich:'',niveau:'',ort:'',ak:'',open:null});changed();render();toast(add.length+' Übungen hinzugefügt.');
}

/* ---------- Aktionen ---------- */
const exByNr=nr=>DB.uebungen.find(e=>e.nr===+nr);
const ACT={
  tab:a=>go(a.dataset.v),
  lock:async()=>{await persist();location.reload();},
  install:async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;render();},
  open:(a,e)=>{e.preventDefault();go('profil',a.dataset.v);},
  toPlan:()=>{ui.tr.sub='plan';go('training');},
  pstep:a=>{ui.pid=a.dataset.v;render();},
  print:()=>window.print(),
  sort:a=>{ui.teamSort=a.dataset.v;render();},
  teamJg:a=>{toggleJg(ui.teamJg,a.dataset.v);render();},
  ttJg:a=>{toggleJg(ui.tt.jg,a.dataset.v);render();},
  tpJg:a=>{toggleJg(ui.tp.jg,a.dataset.v);render();},
  ttTest:a=>{ui.tt.test=a.dataset.v;render();const f=document.querySelector('.ttrow input');if(f)f.focus();},
  ttClear:()=>{if(confirm('Alle noch nicht übernommenen Eingaben verwerfen?')){ui.tt.vals={};render();}},
  ttApply:()=>applyTesttag(),
  trSub:a=>{ui.tr.sub=a.dataset.v;render();},
  reroll:()=>{ui.tr.variante=ui.tr.variante%9+1;render();},
  tpReroll:()=>{ui.tp.variante=ui.tp.variante%9+1;render();},
  libOpen:a=>{const n=+a.dataset.v;ui.lib.open=ui.lib.open===n?null:n;render();},
  addEx:()=>{const nr=DB.uebungen.reduce((m,e)=>Math.max(m,e.nr),0)+1;
    DB.uebungen.push({nr,name:'Neue Übung',bereich:ui.lib.bereich||TESTS[0].name,faehigkeit:'',niveau:'Einsteiger',ak:'E-Jugend',ort:'Zuhause',text:'',umfang:'',material:'',tipp:'',kraft:true,bilder:[],videos:[]});
    Object.assign(ui.lib,{q:'',niveau:'',ort:'',ak:'',open:nr});changed();render();
    const el=document.querySelector('.libedit input');if(el){el.focus();el.select();el.scrollIntoView({block:'center'});}},
  delEx:a=>{const e=exByNr(a.dataset.v);if(e&&confirm('Übung „'+e.name+'“ löschen?')){DB.uebungen=DB.uebungen.filter(x=>x!==e);ui.lib.open=null;changed();render();}},
  exImgDel:a=>{exByNr(a.dataset.v).bilder.splice(+a.dataset.i,1);changed();render();},
  delVid:a=>{exByNr(a.dataset.v).videos.splice(+a.dataset.i,1);changed();render();},
  addVidLink:a=>{const u=$('#vidUrl').value.trim(),t=$('#vidTitle').value.trim();
    if(!isHttp(u)){toast('Bitte einen vollständigen Link eintragen, der mit https:// beginnt.');return;}
    exByNr(a.dataset.v).videos.push({typ:'link',url:u,titel:t||'Video'});changed();render();},
  showImg:a=>{const e=exByNr(a.dataset.nr);if(!e)return;const i=+a.dataset.i;openMedia(e.name+(e.bilder.length>1?' ('+(i+1)+'/'+e.bilder.length+')':''),`<img src="${esc(e.bilder[i])}" alt="">`);},
  showVid:a=>{const e=exByNr(a.dataset.nr),v=e&&e.videos[+a.dataset.i];if(!v)return;
    if(v.typ==='link'){window.open(v.url,'_blank','noopener');return;}
    openMedia(e.name+': '+(v.titel||'Video'),`<video src="${esc(v.data)}" controls autoplay playsinline></video>`);},
  closeMedia:()=>{const d=$('#media');if(d.close)d.close();else d.removeAttribute('open');},
  dupEx:a=>{const e=exByNr(a.dataset.v);if(!e)return;const nr=DB.uebungen.reduce((m,x)=>Math.max(m,x.nr),0)+1;
    const c=JSON.parse(JSON.stringify(e));c.nr=nr;c.name=e.name+' (Kopie)';DB.uebungen.push(c);ui.lib.open=nr;Object.assign(ui.lib,{q:'',bereich:'',niveau:'',ort:'',ak:''});changed();render();
    const el=document.querySelector('.libedit input');if(el){el.focus();el.select();el.scrollIntoView({block:'center'});}toast('Kopie angelegt.');},
  addBereich:()=>{const n=prompt('Name des neuen Bereichs (z. B. Koordination, Beweglichkeit):');if(!n||!n.trim())return;
    if(allBereiche().includes(n.trim())){toast('Den Bereich gibt es schon.');return;}addBereich(n);changed();render();toast('Bereich „'+n.trim()+'“ angelegt.');},
  delBereich:a=>{const b=a.dataset.v,n=DB.uebungen.filter(e=>e.bereich===b).length;
    if(n){toast(n+' Übung'+(n>1?'en nutzen':' nutzt')+' diesen Bereich noch. Erst umstellen oder löschen.');return;}
    DB.settings.bereicheExtra=DB.settings.bereicheExtra.filter(x=>x!==b);changed();render();},
  matEdit:a=>{ui.matEdit=a.dataset.v&&ui.matEdit!==a.dataset.v?a.dataset.v:null;render();},
  matToggle:a=>{const h=halleById(ui.matEdit);if(!h)return;const m=a.dataset.v,i=h.fehlt.indexOf(m);if(i<0)h.fehlt.push(m);else h.fehlt.splice(i,1);changed();render();},
  halleRename:a=>{const h=halleById(a.dataset.v);if(!h)return;const n=prompt('Neuer Name:',h.name);if(n&&n.trim()){h.name=n.trim();changed();render();}},
  halleDel:a=>{const h=halleById(a.dataset.v);if(!h||!confirm('Materialprofil „'+h.name+'“ löschen?'))return;
    DB.settings.hallen=DB.settings.hallen.filter(x=>x!==h);if(ui.tr.halle===h.id)ui.tr.halle='';if(ui.tp.halle===h.id)ui.tp.halle='';ui.matEdit=null;changed();render();},
  copyTxt:async a=>{const el=$('#'+a.dataset.v);if(!el)return;const t=el.textContent;
    try{await navigator.clipboard.writeText(t);toast('Kopiert.');}
    catch(e){const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);toast('Markiert, jetzt mit Strg+C kopieren.');}},
  importEx:()=>importEx(), exTemplate:()=>exTemplate(), exExport:()=>exExport(),
  theme:()=>{const dark=document.documentElement.dataset.theme==='dunkel'||(document.documentElement.dataset.theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
    DB.settings.theme=dark?'hell':'dunkel';changed();render();},
  addM:()=>{DB.messungen.push({id:uid('m'),pid:ui.pid,monat:thisMonth(),name:'',w:{},bem:''});changed();render();},
  delM:a=>{if(confirm('Diese Messung löschen?')){DB.messungen=DB.messungen.filter(m=>m.id!==a.dataset.v);changed();render();}},
  addP:()=>{const n=$('#newName').value.trim(),jg=parseInt($('#newJg').value,10);
    if(!n){toast('Bitte einen Namen eintragen.');return;}
    if(DB.players.some(p=>p.name.toLowerCase()===n.toLowerCase())){toast('„'+n+'“ gibt es schon.');return;}
    DB.players.push({id:uid('p'),name:n,jahrgang:isNaN(jg)?null:jg,geb:'',position:'',notiz:'',foto:''});changed();render();toast(n+' angelegt.');},
  delP:a=>{const p=pById(a.dataset.v);if(p&&confirm(p.name+' und alle '+mOf(p.id).length+' Messungen löschen?')){
    DB.players=DB.players.filter(x=>x.id!==p.id);DB.messungen=DB.messungen.filter(m=>m.pid!==p.id);changed();render();}},
  delPhoto:a=>{pById(a.dataset.v).foto='';changed();render();},
  delLogo:a=>{DB.settings[a.dataset.v]='';changed();render();},
  setPw:async()=>{const a=$('#pw1').value,b=$('#pw2').value;
    if(a.length<(SYNC.team?8:6)){toast('Das Passwort braucht mindestens '+(SYNC.team?8:6)+' Zeichen.');return;}
    if(a!==b){toast('Die beiden Passwörter stimmen nicht überein.');return;}
    if(SYNC.team){if(SYNC.role!=='owner')return;
      try{await cloud.setSecret(SYNC.team,await joinProof(a,SYNC.name));}catch(e){console.error(e);toast(cloudMsg(e));return;}}
    const had=!!SEC.key;await setPassword(a);changed();render();
    toast(had?'Passwort geändert.':'Passwort festgelegt. Die Daten werden jetzt verschlüsselt gespeichert.');},
  removePw:()=>{if(!confirm('Passwortschutz entfernen? Die Daten werden dann unverschlüsselt gespeichert.'))return;
    SEC.key=SEC.salt=SEC.pw=null;changed();render();toast('Schutz entfernt.');},
  jsonOut:()=>downloadBlob(JSON.stringify(DB,null,1),'Leistungsdiagnostik_Daten_'+new Date().toISOString().slice(0,10)+'.json','application/json'),
  jsonIn:async()=>{const f=await pickFile('.json,application/json');if(!f)return;
    try{const d=JSON.parse(await f.text());if(!Array.isArray(d.players)||!Array.isArray(d.messungen))throw 0;
      if(!confirm(`${d.players.length} Spielerinnen und ${d.messungen.length} Messungen einspielen? Die aktuellen Daten werden ersetzt.`))return;
      const keep=DB.meta.fileId,lib=DB.uebungen;DB=normalize(d);DB.meta.fileId=keep;if(!d.uebungen)DB.uebungen=lib;changed();go('team');toast('Daten eingespielt.');}
    catch(e){toast('Die Datei enthält keine gültige Leistungsdiagnostik-Sicherung.');}},
  wipe:()=>{if(confirm('Wirklich alle Spielerinnen und Messungen löschen? Übungen und Logos bleiben.')){DB.players=[];DB.messungen=[];changed();go('kader');}},
  xlsxIn:async()=>{let X;try{X=await loadXLSX();}catch(e){toast('Für die Übernahme wird einmalig eine Internetverbindung gebraucht.');return;}
    const f=await pickFile('.xlsx,.xlsm,.xls');if(!f)return;
    try{importXlsx(await f.arrayBuffer());}catch(e){console.error(e);toast('Die Excel-Datei konnte nicht gelesen werden.');}},
  xlsxOut:()=>exportXlsx(),
  htmlIn:async()=>{const f=await pickFile('.html,.htm,text/html');if(!f)return;
    let d;try{d=readLegacyHtml(await f.text());}catch(e){toast('In dieser Datei wurden keine Leistungsdiagnostik-Daten gefunden.');return;}
    let r=null;
    if(d.enc){if(!CRYPTO_OK){toast('Dieser Browser kann die Datei nicht entschlüsseln.');return;}
      const pw=prompt('Die Datei ist mit einem Passwort geschützt. Passwort:');if(!pw)return;
      try{r=await decryptWrap(d,pw);r.pw=pw;d=r.db;}catch(e){toast('Passwort falsch.');return;}}
    if(!Array.isArray(d.players)){toast('In dieser Datei wurden keine Leistungsdiagnostik-Daten gefunden.');return;}
    if(!confirm(`${d.players.length} Spielerinnen und ${(d.messungen||[]).length} Messungen übernehmen? Die aktuellen Daten werden ersetzt.`))return;
    if(r){SEC.key=r.key;SEC.salt=r.salt;SEC.pw=r.pw;}
    DB=normalize(d);ui.pid=null;$('#bannerSlot').innerHTML='';changed();applyTheme();go('team');
    toast(r?'Datei übernommen. Das Passwort der Datei schützt jetzt auch die Daten in der App.':'Datei übernommen.');},
  join:async()=>{const n=$('#joinName').value.trim(),pw=$('#joinPw').value;
    if(!n||!pw){toast('Bitte Mannschaftsname und Passwort eingeben.');return;}
    await connectTeam(n,pw);},
  createTeam:async()=>{const n=$('#teamName').value.trim();
    if(n.length<2){toast('Bitte einen Mannschaftsnamen eingeben.');return;}
    if(!SEC.key){const a=$('#tpw1').value,b=$('#tpw2').value;
      if(a.length<8){toast('Das Mannschaftspasswort braucht mindestens 8 Zeichen.');return;}
      if(a!==b){toast('Die beiden Passwörter stimmen nicht überein.');return;}}
    else if(!SEC.pw){toast('Bitte die App einmal sperren und mit dem Passwort neu öffnen.');return;}
    try{toast('Lege Mannschaft an …');
      const pw=SEC.key?SEC.pw:$('#tpw1').value;
      await cloud.createTeam(DB.meta.fileId,n,await joinProof(pw,n));
      if(!SEC.key)await setPassword(pw);
      Object.assign(SYNC,{team:DB.meta.fileId,name:n,role:'owner',base:0,pending:true});
      if(!DB.settings.mannschaft)DB.settings.mannschaft=n;
      changed();await persist();await syncNow();refreshLocalTeams();render();
      toast('„'+n+'“ ist online. Trainer verbinden sich mit Mannschaftsname und Passwort.');}
    catch(e){console.error(e);toast(e.code==='23505'?'Diesen Mannschaftsnamen gibt es schon.':e.code==='42501'?'Nur der Master darf Mannschaften anlegen.':cloudMsg(e));}},
  renameTeam:async()=>{const n=$('#renameName').value.trim();
    if(n.length<2){toast('Bitte einen Mannschaftsnamen eingeben.');return;}
    if(n===SYNC.name)return;
    if(!SEC.pw){toast('Bitte die App einmal sperren und mit dem Passwort neu öffnen.');return;}
    try{await cloud.renameTeam(SYNC.team,n,await joinProof(SEC.pw,n));
      SYNC.name=n;await saveSync();render();toast('Die Mannschaft heißt jetzt „'+n+'“.');}
    catch(e){console.error(e);toast(e.code==='23505'?'Diesen Mannschaftsnamen gibt es schon.':e.code==='42501'?'Nur der Master darf die Mannschaft umbenennen.':cloudMsg(e));}},
  syncNow:async()=>{await syncNow();render();toast(SYNC.status==='ok'?'Abgeglichen.':'Abgleich gerade nicht möglich.');},
  disconnect:async()=>{if(!confirm('Abgleich auf diesem Gerät beenden? Die Daten bleiben hier erhalten, Änderungen werden aber nicht mehr übertragen.'))return;
    Object.assign(SYNC,{team:null,name:'',role:null,base:0,pending:false,status:''});await saveSync();updateState();render();},
  mLogin:async()=>{const m=$('#mEmail').value.trim(),p=$('#mPw').value;
    if(!m||!p){toast('Bitte E-Mail-Adresse und Passwort eingeben.');return;}
    ui.mEmail=m;
    try{await cloud.signInPassword(m,p);await refreshAccount();render();toast(master?'Als Master angemeldet.':'Angemeldet, dieses Konto ist aber kein Master.');}
    catch(e){console.error(e);toast(/Invalid login/i.test(e.message)?'E-Mail-Adresse oder Passwort falsch.':cloudMsg(e));}},
  signOut:async()=>{if(SYNC.team&&!confirm('Nach dem Abmelden wird der Abgleich auf diesem Gerät beendet. Fortfahren?'))return;
    try{await cloud.signOut();}catch(e){}master=null;
    if(SYNC.team){Object.assign(SYNC,{team:null,name:'',role:null,base:0,pending:false,status:''});await saveSync();updateState();}
    render();toast('Abgemeldet.');},
  openTeam:async()=>{const id=$('#teamSel').value;if(id===DB.meta.fileId)return;await persist();await localStore.setCurrent(id);location.reload();},
  newTeam:async()=>{if(!confirm('Neue, leere Mannschaft anlegen? Die aktuelle bleibt auf diesem Gerät gespeichert.'))return;
    await persist();await localStore.setCurrent('');location.reload();},
  codeNew:a=>{const p=pById(a.dataset.v);if(!p)return;p.code=newCode();changed();render();ACT.codeShow(a);},
  codeShow:a=>{const p=pById(a.dataset.v);if(!p||!p.code)return;
    const link=location.origin+location.pathname+'#s='+normCode(p.code);
    openMedia('Zugang für '+p.name,`<div class="panel" style="margin:0 10px 10px;max-width:520px">
      <p>Mit diesem Code sieht die Spielerin ihre eigenen Werte und ihren Trainingsplan.</p>
      <div class="code" id="codeTxt">${esc(p.code)}</div>
      <div class="codebox"><code id="codeLink">${esc(link)}</code><button class="btn small" data-act="copyTxt" data-v="codeLink">Link kopieren</button></div>
      <p class="hint">${SYNC.team?'Der Zugang ist nach dem nächsten Abgleich aktiv.':'Noch nicht aktiv: Die Mannschaft ist nicht online.'} Den Code nur an die Spielerin bzw. ihre Eltern weitergeben.</p>
      <div class="row"><button class="btn small" data-act="codeRenew" data-v="${p.id}">Neuer Code</button><button class="btn ghost small danger" data-act="codeDel" data-v="${p.id}">Zugang entfernen</button></div></div>`);},
  codeRenew:a=>{const p=pById(a.dataset.v);if(!p||!confirm('Neuen Code erzeugen? Der bisherige Code funktioniert dann nicht mehr.'))return;
    p.code=newCode();changed();render();ACT.codeShow(a);},
  codeDel:a=>{const p=pById(a.dataset.v);if(!p||!confirm('Zugang für '+p.name+' entfernen?'))return;
    delete p.code;changed();ACT.closeMedia();render();},
  meStart:()=>showCodeForm(),
  meDauer:a=>{ui.me.dauer=+a.dataset.v;render();},
  meReroll:()=>{ui.me.variante=ui.me.variante%9+1;render();},
  meDelPhoto:()=>{if(!ME||!confirm('Foto entfernen?'))return;DB.players[0].foto='';meSubmit();},
  meLogout:()=>{try{localStorage.removeItem('ld-me');localStorage.removeItem('ld-me-pending');}catch(e){}location.hash='';location.reload();},
  connectHow:()=>{$('#bannerSlot').innerHTML='';go('daten');},
  welcomeOff:()=>{$('#bannerSlot').innerHTML='';try{localStorage.setItem('ld-welcome-off','1');}catch(e){}}
};
function newHalle(scope){const n=prompt('Name der Halle oder des Materialprofils (z. B. Sporthalle Nord):');
  if(!n||!n.trim()){render();return;}const h={id:uid('h'),name:n.trim(),fehlt:[]};DB.settings.hallen.push(h);ui[scope].halle=h.id;ui.matEdit=h.id;changed();render();
  toast('Jetzt antippen, welches Material dort fehlt.');}
function toggleJg(set,v){if(!v){set.clear();return;}const n=+v;set.has(n)?set.delete(n):set.add(n);}
const CHG={
  pickPlayer:el=>{ui.pid=el.value;render();},
  mField:el=>{const m=DB.messungen.find(x=>x.id===el.dataset.id);if(!m)return;
    if(el.dataset.f==='monat'&&!el.value){el.value=m.monat;return;}
    m[el.dataset.f]=el.value;changed();if(el.dataset.f==='monat')render();},
  mVal:el=>{const m=DB.messungen.find(x=>x.id===el.dataset.id),t=T(el.dataset.k);if(!m)return;
    const v=parseVal(t,el.value);
    if(v!=null&&isNaN(v)){el.classList.add('bad');toast(t.name+': Wert nicht lesbar'+(t.time?' (Format m:ss)':'')+'.');return;}
    m.w[t.key]=v;changed();render();},
  pField:el=>{const p=pById(el.dataset.id);if(!p)return;let v=el.value.trim();
    if(el.dataset.f==='name'&&!v){el.value=p.name;return;}
    if(el.dataset.f==='jahrgang')v=v?parseInt(v,10):null;
    p[el.dataset.f]=v;changed();},
  photo:async el=>{const f=el.files[0];if(!f)return;try{pById(el.dataset.id).foto=await readSquare(f,240);changed();render();}catch(e){toast('Das Bild konnte nicht gelesen werden.');}},
  logo:async el=>{const f=el.files[0];if(!f)return;try{DB.settings[el.dataset.k]=await readFit(f,320,true);changed();render();}catch(e){toast('Das Bild konnte nicht gelesen werden.');}},
  exImg:async el=>{const fs=[...el.files];if(!fs.length)return;const e=exByNr(el.dataset.nr);let ok=0;
    for(const f of fs){try{e.bilder.push(await readFit(f,800,false));ok++;}catch(x){}}
    if(ok){changed();render();}if(ok<fs.length)toast((fs.length-ok)+' Bild(er) konnten nicht gelesen werden.');},
  exVid:async el=>{const f=el.files[0];if(!f)return;
    if(f.size>20*1048576){toast('Das Video ist '+mb(f.size)+' groß. Maximal 20 MB, für größere Videos bitte einen Link verwenden.');return;}
    if(f.size>5*1048576&&!confirm('Das Video ist '+mb(f.size)+' groß und macht die Datei entsprechend größer. Trotzdem einbetten?'))return;
    try{const data=await readDataURL(f);exByNr(el.dataset.nr).videos.push({typ:'datei',data,size:f.size,titel:f.name.replace(/\.[^.]+$/,'')});changed();render();toast('Video eingebettet.');}
    catch(x){toast('Das Video konnte nicht gelesen werden.');}},
  exF:el=>{const e=exByNr(el.dataset.nr);if(!e)return;const k=el.dataset.k;let v=el.value;
    if(k==='kraft')v=v==='1';else if(k==='name'&&!v.trim()){el.value=e.name;return;}
    if(k==='bereich'&&v==='__neu'){const n=prompt('Name des neuen Bereichs:');if(!n||!n.trim()){el.value=e.bereich;return;}v=addBereich(n);}
    e[k]=v;changed();if(['name','bereich','niveau','ak','ort','kraft','faehigkeit'].includes(k))render();},
  lib:el=>{ui.lib[el.dataset.k]=el.value;ui.lib.open=null;render();},
  tr:el=>{if(el.dataset.k==='halle'&&el.value==='__neu'){newHalle('tr');return;}ui.tr[el.dataset.k]=el.value;if(el.dataset.k==='halle')ui.matEdit=null;render();},
  tp:el=>{if(el.dataset.k==='halle'&&el.value==='__neu'){newHalle('tp');return;}ui.tp[el.dataset.k]=el.value;if(el.dataset.k==='halle')ui.matEdit=null;render();},
  cmp:el=>{ui.cmp=el.value;render();},
  meOrt:el=>{ui.me.ort=el.value;render();},
  meFokus:el=>{ui.me.fokus=el.value;render();},
  meGeb:el=>{if(!ME)return;const g=el.value;if(!validGeb(g)){toast('Bitte ein gültiges Datum eingeben.');el.value=DB.players[0].geb||'';return;}
    DB.players[0].geb=g;meSubmit();},
  mePhoto:async el=>{if(!ME)return;const f=el.files[0];if(!f)return;
    try{DB.players[0].foto=await readSquare(f,240);}catch(e){toast('Das Bild konnte nicht gelesen werden.');return;}meSubmit();},
  ttMonat:el=>{ui.tt.monat=el.value;},
  ttName:el=>{ui.tt.name=el.value;},
  setS:el=>{DB.settings[el.dataset.k]=el.value.trim();changed();render();},
  setOverdue:el=>{const n=parseInt(el.value,10);if(n>0){DB.settings.overdueDays=n;changed();}}
};
document.addEventListener('click',e=>{
  const tb=e.target.closest('#tabs button');if(tb){go(tb.dataset.tab);return;}
  const a=e.target.closest('[data-act]');if(a&&ACT[a.dataset.act])ACT[a.dataset.act](a,e);
});
document.addEventListener('change',e=>{const el=e.target.closest('[data-chg]');if(el&&CHG[el.dataset.chg])CHG[el.dataset.chg](el);});
document.addEventListener('input',e=>{const el=e.target;if(el.dataset&&el.dataset.inp==='ttVal'){ui.tt.vals[el.dataset.k]=el.value;refreshTTFeedback();}});
document.addEventListener('keydown',e=>{
  if(DB&&(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(document.activeElement)document.activeElement.blur();setTimeout(()=>persist().then(()=>toast(saveErr?'Speichern fehlgeschlagen.':'Gespeichert.')),0);return;}
  if(e.key==='Enter'&&(e.target.id==='mEmail'||e.target.id==='mPw')){e.preventDefault();
    if(e.target.id==='mEmail')$('#mPw').focus();else ACT.mLogin();return;}
  if(e.key==='Enter'&&e.target.dataset&&e.target.dataset.inp==='ttVal'){e.preventDefault();
    const all=[...document.querySelectorAll('[data-inp="ttVal"]')],i=all.indexOf(e.target);if(all[i+1])all[i+1].focus();else $('[data-act="ttApply"]').focus();}
});
window.addEventListener('beforeunload',e=>{if(dirty){persist();e.preventDefault();e.returnValue='';}});
/* Tablets beenden Apps im Hintergrund oft ohne beforeunload */
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&dirty)persist();
  if(document.visibilityState==='visible')syncNow();});
window.addEventListener('online',()=>syncNow());
window.addEventListener('offline',()=>{if(SYNC.team)setSync('offline');});
setInterval(()=>{if(document.visibilityState==='visible')syncNow();},60000);
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;if(DB&&ui.tab==='daten')render();});
window.addEventListener('appinstalled',()=>{installPrompt=null;});

/* ---------- Start ---------- */
function normalize(d){
  d.meta=d.meta||{};d.settings=d.settings||{};d.players=d.players||[];d.messungen=d.messungen||[];d.uebungen=d.uebungen||[];
  if(!d.settings.overdueDays)d.settings.overdueDays=180;
  ['verein','mannschaft','logoVerein','logoTeam'].forEach(k=>{if(d.settings[k]==null)d.settings[k]='';});
  d.messungen.forEach(m=>{m.w=m.w||{};});
  if(!d.settings.theme)d.settings.theme='hell';if(!Array.isArray(d.settings.bereicheExtra))d.settings.bereicheExtra=[];if(!Array.isArray(d.settings.hallen))d.settings.hallen=[];
  d.uebungen.forEach(e=>{if(!Array.isArray(e.bilder))e.bilder=e.bild?[e.bild]:[];delete e.bild;if(!Array.isArray(e.videos))e.videos=[];});
  d.meta.schema=2;
  return d;
}
function start(){
  DB=normalize(DB);
  if(!DB.meta.fileId)DB.meta.fileId='ld-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  document.body.classList.remove('locked');
  updateState();render();
  let off=false;try{off=!!localStorage.getItem('ld-welcome-off');}catch(e){}
  if(!DB.players.length&&!off)
    $('#bannerSlot').innerHTML='<div class="banner" style="background:var(--sunk);border:1px solid var(--line)"><span>Willkommen!</span>'
      +(cloudConfigured?'<button class="btn small primary" data-act="connectHow">Mit Mannschaft verbinden</button><button class="btn small" data-act="meStart">Ich bin Spielerin</button>':'')
      +'<button class="btn small" data-act="htmlIn">Bisherige HTML-Datei übernehmen</button><button class="btn small" data-act="xlsxIn">Aus Excel</button><button class="btn small ghost" data-act="welcomeOff">Leer starten</button></div>';
  localStore.persist().then(ok=>{persisted=ok;});
  refreshLocalTeams();
  refreshAccount().then(()=>{if(ui.tab==='daten')render();});
  localStore.syncState(DB.meta.fileId).then(st=>{if(st&&st.team){Object.assign(SYNC,st);updateState();syncNow();}}).catch(e=>console.error(e));
  let rt;window.addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(fitList,120);});
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fitList);
  const md=$('#media');md.addEventListener('click',ev=>{if(ev.target===md)ACT.closeMedia();});md.addEventListener('close',()=>{md.innerHTML='';});
}
function showLock(w){
  document.body.classList.add('locked');document.documentElement.dataset.theme=w.theme||'hell';
  $('#view').innerHTML=`<form class="lockbox panel" id="lockForm">
    <h2>Geschützte Datei</h2><p class="muted">Diese Leistungsdiagnostik ist mit einem Passwort verschlüsselt.</p>
    <input type="password" id="unlockPw" autocomplete="current-password" aria-label="Passwort" autofocus>
    <button class="btn primary" style="width:100%">Öffnen</button>
    <p class="hint" id="lockMsg" style="min-height:1.4em"></p></form>`;
  if(!CRYPTO_OK){$('#lockMsg').textContent='Dieser Browser kann die Datei nicht entschlüsseln. Bitte einen aktuellen Browser verwenden.';return;}
  $('#unlockPw').focus();
  $('#lockForm').addEventListener('submit',async ev=>{ev.preventDefault();
    const pw=$('#unlockPw').value;$('#lockMsg').textContent='Wird entschlüsselt …';
    try{const r=await decryptWrap(w,pw);SEC.key=r.key;SEC.salt=r.salt;SEC.pw=pw;DB=r.db;start();}
    catch(e){$('#lockMsg').textContent='Passwort falsch.';$('#unlockPw').select();}});
}
async function boot(){
  if(cloudConfigured&&await bootPlayer())return;
  let w=null;
  try{const id=await localStore.current();if(id)w=await localStore.load(id);}
  catch(e){console.error(e);toast('Der Gerätespeicher ist nicht verfügbar (privates Fenster?). Änderungen gehen beim Schließen verloren.');}
  if(w&&w.enc){showLock(w);return;}
  DB=w||{meta:{},settings:{},players:[],messungen:[],uebungen:structuredClone(uebungenStart)};
  start();
}
/* ---------- Ansicht für Spielerinnen (Zugang per Code) ---------- */
async function openShare(code){
  const c=normCode(code);if(c.length<10)return false;
  let w,cached=null;
  try{cached=JSON.parse(localStorage.getItem('ld-me')||'null');}catch(e){}
  try{w=await cloud.getShare(await lookupOf(c));
    if(!w){try{localStorage.removeItem('ld-me');}catch(e){}return false;}
    try{localStorage.setItem('ld-me',JSON.stringify({code:c,w}));}catch(e){}}
  catch(e){console.error(e);if(!cached||cached.code!==c)throw e;w=cached.w;}
  ME=await openWith(await shareKey(c),w);ME.code=c;
  let pend=null;try{pend=JSON.parse(localStorage.getItem('ld-me-pending')||'null');}catch(e){}
  if(pend&&pend.code===c&&pend.upd){
    if(ME.player.edited&&ME.player.edited>=pend.upd.at){try{localStorage.removeItem('ld-me-pending');}catch(e){}pend=null;}
    else{ME.player.geb=pend.upd.geb;ME.player.foto=pend.upd.foto;}}
  DB=normalize({meta:{},settings:Object.assign({},ME.settings),players:[ME.player],messungen:ME.messungen,uebungen:ME.uebungen||[]});
  ui.tab='me';ui.pid=ME.player.id;
  document.body.classList.remove('locked');document.body.classList.add('player');
  $('#bannerSlot').innerHTML='';render();
  if(pend&&!pend.sent&&navigator.onLine)meSubmit();
  return true;
}
function showCodeForm(msg){
  document.body.classList.add('locked','player');$('#bannerSlot').innerHTML='';
  $('#view').innerHTML=`<form class="lockbox panel" id="codeForm">
    <h2>Meine Werte</h2><p class="muted">Gib den Zugangscode ein, den du von deinem Trainerteam bekommen hast.</p>
    <input id="meCode" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX" aria-label="Zugangscode">
    <button class="btn primary" style="width:100%">Öffnen</button>
    <p class="hint" id="codeMsg" style="min-height:1.4em">${esc(msg||'')}</p>
    <button type="button" class="btn ghost small" data-act="meLogout">Zurück</button></form>`;
  $('#meCode').focus();
  $('#codeForm').addEventListener('submit',async ev=>{ev.preventDefault();$('#codeMsg').textContent='Wird geladen …';
    try{if(!(await openShare($('#meCode').value)))$('#codeMsg').textContent='Code unbekannt oder nicht mehr gültig.';}
    catch(e){$('#codeMsg').textContent=navigator.onLine?'Code unbekannt oder nicht mehr gültig.':'Keine Internetverbindung.';}});
}
async function bootPlayer(){
  const hm=location.hash.match(/^#s=([A-Za-z0-9-]+)/);
  if(hm){history.replaceState(null,'',location.pathname+location.search);
    try{if(await openShare(hm[1]))return true;}catch(e){}
    showCodeForm('Code unbekannt oder nicht mehr gültig.');return true;}
  let me=null;try{me=JSON.parse(localStorage.getItem('ld-me')||'null');}catch(e){}
  if(me&&me.code){try{if(await openShare(me.code))return true;}catch(e){}
    showCodeForm();return true;}
  return false;
}
boot();
