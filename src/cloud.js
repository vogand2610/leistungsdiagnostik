/* Zugriff auf Supabase. Die App kennt nur diese Funktionen; supabase-js wird erst bei Bedarf geladen,
   damit Start und Offline-Betrieb nicht davon abhaengen. Alle Nutzdaten kommen bereits verschluesselt an. */
const URL_=import.meta.env.VITE_SUPABASE_URL, KEY=import.meta.env.VITE_SUPABASE_KEY;
let sbP=null;

export const cloudConfigured=!!(URL_&&KEY);

function sb(){
  if(!sbP)sbP=import('@supabase/supabase-js').then(({createClient})=>createClient(URL_,KEY,{
    auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:'ld-auth'}}));
  return sbP;
}
function fail(error){const e=new Error(error.message||String(error));e.code=error.code;throw e;}

export const cloud={
  /* ---------- Anmeldung ---------- */
  async user(){const c=await sb();const {data}=await c.auth.getSession();return data.session?data.session.user:null;},
  /* Master: Anmeldung mit E-Mail und Passwort. Konten werden nur im Supabase-Dashboard angelegt. */
  async signInPassword(email,password){const c=await sb();const {data,error}=await c.auth.signInWithPassword({email,password});if(error)fail(error);return data.user;},
  /* Trainer: anonyme Anmeldung, die Berechtigung kommt allein aus dem Verbinden mit einer Mannschaft */
  async ensureUser(){const c=await sb();const u=await this.user();if(u)return u;
    const {data,error}=await c.auth.signInAnonymously();if(error)fail(error);return data.user;},
  async signOut(){const c=await sb();await c.auth.signOut();},
  async isMaster(){const c=await sb();const {data,error}=await c.rpc('is_master');if(error)fail(error);return !!data;},

  /* ---------- Mannschaften ---------- */
  async createTeam(id,name,proof){const c=await sb();const {error}=await c.rpc('create_team',{p_id:id,p_name:name,p_proof:proof});if(error)fail(error);},
  async joinTeam(name,proof){const c=await sb();const {data,error}=await c.rpc('join_team',{p_name:name,p_proof:proof});if(error)fail(error);return data;},
  async setSecret(id,proof){const c=await sb();const {error}=await c.rpc('set_team_secret',{p_team:id,p_proof:proof});if(error)fail(error);},
  async renameTeam(id,name,proof){const c=await sb();const {error}=await c.rpc('rename_team',{p_team:id,p_name:name,p_proof:proof});if(error)fail(error);},
  async role(id){const c=await sb();const {data,error}=await c.rpc('team_role',{p_team:id});if(error)fail(error);return data;},
  async members(id){const c=await sb();const {data,error}=await c.from('team_members').select('user_id,role,joined_at').eq('team_id',id).order('joined_at');if(error)fail(error);return data;},
  async removeMember(id,uid){const c=await sb();const {error}=await c.from('team_members').delete().eq('team_id',id).eq('user_id',uid);if(error)fail(error);},

  /* ---------- Daten-Dokument mit Versionszaehler ---------- */
  async rev(id){const c=await sb();const {data,error}=await c.from('team_docs').select('rev').eq('team_id',id).maybeSingle();if(error)fail(error);return data?data.rev:null;},
  async pull(id){const c=await sb();const {data,error}=await c.from('team_docs').select('rev,payload').eq('team_id',id).maybeSingle();if(error)fail(error);return data;},
  /* schreibt nur, wenn der Server noch auf Stand base ist; sonst {conflict:true} */
  async push(id,base,payload){
    const c=await sb();
    if(!base){const {error}=await c.from('team_docs').insert({team_id:id,rev:1,payload});
      if(error){if(error.code==='23505')return {conflict:true};fail(error);}return {rev:1};}
    const {data,error}=await c.from('team_docs').update({rev:base+1,payload}).eq('team_id',id).eq('rev',base).select('rev');
    if(error){if(error.code==='40001')return {conflict:true};fail(error);}
    return data.length?{rev:base+1}:{conflict:true};
  },

  /* ---------- Standard-Uebungsbibliothek (eine Zeile, unverschluesselt, schreiben nur Master) ---------- */
  async stdRev(){const c=await sb();const {data,error}=await c.from('std_library').select('rev').eq('id',1).maybeSingle();if(error)fail(error);return data?data.rev:null;},
  async stdPull(){const c=await sb();const {data,error}=await c.from('std_library').select('rev,payload').eq('id',1).maybeSingle();if(error)fail(error);return data;},
  /* wie push: schreibt nur, wenn der Server noch auf Stand base ist; sonst {conflict:true} */
  async stdPush(base,payload){
    const c=await sb();
    if(!base){const {error}=await c.from('std_library').insert({id:1,rev:1,payload});
      if(error){if(error.code==='23505')return {conflict:true};fail(error);}return {rev:1};}
    const {data,error}=await c.from('std_library').update({rev:base+1,payload}).eq('id',1).eq('rev',base).select('rev');
    if(error){if(error.code==='40001')return {conflict:true};fail(error);}
    return data.length?{rev:base+1}:{conflict:true};
  },

  /* ---------- Freigaben fuer Spielerinnen ---------- */
  async putShares(id,rows){if(!rows.length)return;const c=await sb();
    const {error}=await c.from('player_shares').upsert(rows.map(r=>({lookup:r.lookup,team_id:id,data:r.data,updated_at:new Date().toISOString()})));if(error)fail(error);},
  async pruneShares(id,keep){const c=await sb();let q=c.from('player_shares').delete().eq('team_id',id);
    if(keep.length)q=q.not('lookup','in','('+keep.join(',')+')');const {error}=await q;if(error)fail(error);},
  async getShare(lookup){const c=await sb();const {data,error}=await c.rpc('get_player_share',{p_lookup:lookup});if(error)fail(error);return data;},

  /* ---------- Aenderungen durch Spielerinnen ---------- */
  async submitUpdate(lookup,data){const c=await sb();const {data:ok,error}=await c.rpc('submit_player_update',{p_lookup:lookup,p_data:data});if(error)fail(error);return ok;},
  async playerUpdates(id){const c=await sb();const {data,error}=await c.from('player_updates').select('lookup,data,created_at').eq('team_id',id);if(error)fail(error);return data;},
  async deleteUpdate(lookup,createdAt){const c=await sb();const {error}=await c.from('player_updates').delete().eq('lookup',lookup).eq('created_at',createdAt);if(error)fail(error);}
};
