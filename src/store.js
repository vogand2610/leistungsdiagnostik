import {get,set,del,keys,createStore} from 'idb-keyval';

/* Speicher-Schicht im Geraet: ein Dokument je Mannschaft plus Abgleich-Status.
   Der Abgleich mit dem Server (cloud.js) setzt darauf auf und aendert hier nichts am Format. */
const idb=createStore('leistungsdiagnostik','kv');

export const localStore={
  /* Id der zuletzt geoeffneten Mannschaft */
  async current(){return (await get('current',idb))||null;},
  async setCurrent(id){await set('current',id,idb);},
  /* gespeicherte Nutzlast: Datenbank-Objekt oder verschluesselter Umschlag ({enc:1,...}) */
  async load(id){const r=await get('doc:'+id,idb);return r?r.payload:null;},
  /* label = Mannschaftsname im Klartext, damit die Auswahl auch verschluesselte Dokumente benennen kann */
  async save(id,payload,label){
    await set('doc:'+id,{payload,label:label||'',saved:new Date().toISOString()},idb);
    await set('current',id,idb);
  },
  async remove(id){await del('doc:'+id,idb);await del('sync:'+id,idb);},
  async list(){
    const ks=(await keys(idb)).filter(k=>String(k).startsWith('doc:'));
    const out=[];for(const k of ks){const r=await get(k,idb);out.push({id:k.slice(4),label:r.label||'',saved:r.saved});}
    return out.sort((a,b)=>a.label.localeCompare(b.label,'de'));
  },
  /* Abgleich-Status je Mannschaft: {team,name,role,base,pending} */
  async syncState(id){return (await get('sync:'+id,idb))||null;},
  async setSyncState(id,s){if(s)await set('sync:'+id,s,idb);else await del('sync:'+id,idb);},
  /* Offline-Kopie der Standard-Uebungsbibliothek: {rev,payload} */
  async std(){return (await get('std',idb))||null;},
  async setStd(s){await set('std',s,idb);},
  /* bittet den Browser, die Daten nicht bei Speicherknappheit zu loeschen */
  async persist(){
    try{
      if(!navigator.storage||!navigator.storage.persist)return false;
      return (await navigator.storage.persisted())||(await navigator.storage.persist());
    }catch(e){return false;}
  }
};
