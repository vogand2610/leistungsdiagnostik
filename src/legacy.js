/* Liest den eingebetteten Datenblock aus einer frueher gespeicherten Leistungsdiagnostik.html.
   Ergebnis ist die Datenbank oder ein verschluesselter Umschlag ({enc:1,...}). */
export function readLegacyHtml(html){
  const m=String(html).match(/<script type="application\/json" id="ld-db">([\s\S]*?)<\/script>/);
  if(!m)throw new Error('kein Datenblock');
  const d=JSON.parse(m[1]);
  if(!d||typeof d!=='object')throw new Error('leerer Datenblock');
  return d;
}
