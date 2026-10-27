# Leistungsdiagnostik (PWA)

Leistungsdiagnostik für Handball-Mannschaften als installierbare Web-App. Läuft auf Desktop und Tablet, auch offline. Jede Änderung wird automatisch im Gerät gespeichert (IndexedDB) und, wenn die Mannschaft online ist, mit allen verbundenen Geräten abgeglichen (Supabase).

## Rollen

- **Master**: meldet sich mit E-Mail-Adresse und Passwort an und ist der Einzige, der Mannschaften online anlegen darf.
- **Trainer/in**: verbindet sich ohne Konto mit Mannschaftsname und Passwort und kann danach alles bearbeiten.
- **Spielerin**: öffnet mit ihrem Zugangscode (oder dem Link `…/#s=CODE`) nur ihre eigenen Werte, ohne Notizen und Bemerkungen. Sie kann
  - ihren **Geburtstag** und ihr **Foto** ändern. Die Änderung übernimmt ein Gerät des Trainerteams beim nächsten Abgleich automatisch (Jahrgang folgt dem Geburtsjahr).
  - eigene **Trainingspläne mit 15, 30, 45 oder 60 Minuten** erstellen, inklusive Aufwärmen und Cool-down, wahlweise nur für Zuhause, Halle/Platz oder Fitnessstudio, und mit „Andere Übungen“ neu mischen. Als Schwerpunkt gelten automatisch ihre Förderschwerpunkte; sie kann aber auch jeden anderen Bereich wählen (z. B. Schlagwurf oder Rumpf & Prävention). Die Übungen stammen aus einer Auswahl von bis zu 15 je Bereich, passend zu ihrer Altersklasse.

## Sicherheit

- Die Mannschaftsdaten werden im Browser mit dem Mannschaftspasswort verschlüsselt (AES-256-GCM, PBKDF2). Supabase speichert nur verschlüsselte Daten.
- Beim Verbinden prüft der Server einen aus Passwort und Mannschaftsname abgeleiteten Nachweis (bcrypt-gehasht). Fehlversuche werden je Mannschaft gebremst (20 in 15 Minuten).
- Jede Spielerin bekommt einen eigenen, mit ihrem Code verschlüsselten Auszug. Abrufbar nur mit dem exakten Code (SHA-256 als Schlüssel), ein Auflisten ist nicht möglich.
- Änderungen der Spielerin (Geburtstag, Foto) werden ebenfalls mit ihrem Code verschlüsselt abgelegt. Nur Geräte des Trainerteams kennen den Code, übernehmen die Änderung und löschen den Eintrag danach. Je Spielerin gibt es höchstens eine offene Änderung.
- Ein vergessenes Mannschaftspasswort kann niemand wiederherstellen. Lokale Sicherung über „Daten sichern (JSON)“.

## Supabase einrichten (einmalig)

1. **Region prüfen**: Project Settings → General. Für Daten Minderjähriger möglichst eine EU-Region (z. B. Frankfurt).
2. **Datenbank**: SQL Editor → nacheinander den Inhalt von `supabase/migrations/001_init.sql`, `002_player_updates.sql`, `003_rename_team.sql` und `004_std_library.sql` einfügen → jeweils Run. Bereits ausgeführte Dateien nicht wiederholen, nur die neuen.
3. **Anmeldung**: Authentication → Sign In / Providers
   - „Allow new users to sign up“: an (wird für die anonyme Anmeldung gebraucht)
   - „Allow anonymous sign-ins“: an
   - Email: an. „Confirm email“ kann an bleiben. Ein eigener SMTP-Server ist nicht nötig, die App verschickt keine E-Mails.
4. **Master-Konto anlegen**: Authentication → Users → Add user → „Create new user“ mit deiner E-Mail-Adresse und einem sicheren Passwort, „Auto Confirm User“ an.
5. **Als Master eintragen**: SQL Editor:
   ```sql
   insert into public.app_admins (user_id)
   select id from auth.users where email = 'DEINE-E-MAIL';
   ```
6. **Später beim Hosting**: Authentication → URL Configuration → „Site URL“ auf die Adresse der App setzen.

Empfehlung: Unter Authentication → Attack Protection eine CAPTCHA-Prüfung für anonyme Anmeldungen aktivieren, sobald die App öffentlich erreichbar ist.

## Übungsbibliothek

- **Standardübungen** gelten für alle Mannschaften. Sie liegen einmal zentral in Supabase (`std_library`, unverschlüsselt, nur Übungen, keine Spielerdaten) und offline auf jedem Gerät. Ändern, anlegen und löschen kann sie nur der Master; Änderungen gelten sofort für alle.
- **Eigene Übungen** einer Mannschaft liegen verschlüsselt im Mannschaftsdokument (Nummern ab 100001).
- Trainer können Standardübungen für ihre Mannschaft **deaktivieren**. Deaktivierte Übungen erscheinen weder im Trainingsplan noch bei den Spielerinnen dieser Mannschaft. „Als eigene Übung kopieren“ legt eine eigene Fassung an und deaktiviert die Standardfassung.
- **Einrichten:** Als Master unter Training → Übungsbibliothek „Als Standard veröffentlichen“. Bestehende Mannschaften stellen sich danach automatisch um: Übungen wie im Standard entfallen aus der Mannschaft, selbst geänderte bleiben als eigene Übung erhalten.

## Ablauf

1. Master: App öffnen → Daten → Online-Mannschaft → Master-Anmeldung (E-Mail-Adresse und Passwort).
2. Bisherige Daten übernehmen (HTML-Datei oder Excel) oder neu erfassen.
3. „Online anlegen“: Mannschaftsname und Passwort festlegen. Beides an das Trainerteam geben.
4. Trainer/in: App öffnen → „Mit Mannschaft verbinden“ → Name und Passwort.
5. Kader → „Code erzeugen“ je Spielerin → Code oder Link weitergeben.

## Entwicklung

```bash
npm install
npm run dev       # Entwicklungsserver
npm run build     # Produktions-Build nach dist/
npm run preview   # Build lokal ansehen
npm run icons     # App-Icons aus public/icon.svg neu erzeugen
```

Supabase-Zugang in `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` = Publishable Key). Den Secret- bzw. service_role-Key nie eintragen.

## Veröffentlichen

**Aktuell:** https://leistungsdiagnostik.handball-trainer.info (GitHub Pages, Repository `vogand2610/leistungsdiagnostik`, eigene Domain über einen CNAME-Eintrag bei Strato auf `vogand2610.github.io`). Jeder Push auf `main` baut und veröffentlicht automatisch. Weil die App im Hauptpfad der Domain liegt, baut der Workflow mit `BASE: /`. Ohne eigene Domain dort wieder `BASE: /<repository>/` setzen.

Die App muss unter einer **HTTPS-Adresse** erreichbar sein. Über `http://` (z. B. `http://192.168.…` im Heimnetz) sperren die Browser die Verschlüsselung und den Offline-Betrieb; Anmelden, Verbinden und Spielerinnen-Codes funktionieren dann nicht. `dist/` ist eine rein statische Seite, jeder statische Hoster mit HTTPS reicht.

### Variante A: GitHub Pages (automatisch bei jeder Änderung)

1. Auf GitHub ein neues Repository anlegen, z. B. `leistungsdiagnostik`. Für GitHub Pages im kostenlosen Tarif muss es **öffentlich** sein. Der Code enthält keine Spielerdaten, nur die Übungsbibliothek und den öffentlichen Supabase-Schlüssel.
2. Inhalt der ZIP-Datei entpacken und hochladen: im Repository „Add file“ → „Upload files“, den **Inhalt** des entpackten Ordners hineinziehen (inklusive des Ordners `.github`), dann „Commit changes“. Unter Windows ggf. im Explorer „Ausgeblendete Elemente“ einschalten, damit `.github` sichtbar ist.
3. Im Repository: Settings → Pages → „Build and deployment“ → Source: **GitHub Actions**.
4. Unter „Actions“ läuft „Deploy to GitHub Pages“ (ca. 1 Minute). Danach ist die App erreichbar unter `https://<github-name>.github.io/leistungsdiagnostik/`.
5. In Supabase: Authentication → URL Configuration → „Site URL“ auf diese Adresse setzen.

Jede spätere Änderung im Repository (Upload oder Commit) baut und veröffentlicht die App automatisch neu. Installierte Apps laden die neue Version im Hintergrund und nutzen sie beim nächsten Start.

### Variante B: Cloudflare Pages (ohne Git, per Hochladen)

1. `npm install` und `npm run build` ausführen.
2. Auf https://dash.cloudflare.com: Workers & Pages → Create → Pages → „Upload assets“, Projektname z. B. `leistungsdiagnostik`, den Ordner `dist` hochladen.
3. Adresse: `https://leistungsdiagnostik.pages.dev`. In Supabase als „Site URL“ eintragen.
4. Für Updates neu bauen und `dist` erneut hochladen.

Für Hosting in einem Unterpfad (Vereins-Webspace o. Ä.) beim Build `BASE=/pfad/` setzen.

## Auf iPad und Tablet

1. Die Adresse der App öffnen: auf dem **iPad in Safari** (andere Browser können dort keine Apps installieren), auf Android in Chrome.
2. Installieren:
   - iPad/iPhone: Teilen-Symbol → „Zum Home-Bildschirm“.
   - Android: Menü ⋮ → „App installieren“.
   - Windows/Mac (Chrome, Edge): Installieren-Symbol rechts in der Adressleiste.
3. Ab dann über das Symbol starten. Die App läuft ohne Adressleiste und funktioniert auch offline in der Halle; Änderungen werden abgeglichen, sobald wieder Internet da ist.

Gut zu wissen:

- **Immer über das Symbol arbeiten, nicht in Safari.** Auf dem iPad hat die installierte App einen eigenen Speicher, getrennt von Safari. Einmal in der App mit der Mannschaft verbinden bzw. als Master anmelden.
- Daten von **nicht installierten** Seiten löscht Safari nach einigen Wochen ohne Nutzung. Mit installierter App und Online-Mannschaft ist das kein Problem.
- **Spielerinnen** müssen nichts installieren: Link `…/#s=CODE` in Safari öffnen genügt. Wer die App installieren will, gibt den Code danach in der App unter „Ich bin Spielerin“ einmal ein.
- Breite Tabellen (Kader, Messungen) lassen sich seitlich wischen.

## Aufbau

- `src/app.js`: App-Logik und Oberfläche, inkl. Abgleich und Spielerinnen-Ansicht
- `src/store.js`: Speicher im Gerät (Dokument je Mannschaft, Abgleich-Status)
- `src/cloud.js`: Zugriff auf Supabase (wird erst bei Bedarf geladen)
- `src/legacy.js`: liest Daten aus einer früheren `Leistungsdiagnostik.html`
- `src/data/uebungen.json`: Übungsbibliothek für neue Mannschaften
- `supabase/migrations/`: Tabellen, Zugriffsregeln (RLS) und Funktionen, in Nummernfolge ausführen

## Bekannte Grenzen

- Abgleich als ganzes Dokument: Ändern zwei Geräte gleichzeitig, fragt die App, welcher Stand gilt.
- Eingebettete Videodateien landen im Dokument und machen den Abgleich langsam. Besser Video-Links verwenden.
- Die automatischen Schwerpunkte im Plan der Spielerinnen sind die aus der Förderpriorität, nicht die im Trainingsplan-Reiter gewählten.
- Jede Freigabe enthält Übungen für alle Bereiche. Viele Bilder in der Übungsbibliothek machen den Abgleich dadurch langsamer; Video-Links statt Videodateien verwenden.
- Zeiten im Plan der Spielerinnen sind Richtwerte: Kräftigung etwa 5 Minuten je Übung (Sätze plus Pausen), Rumpf etwa 3 Minuten.
