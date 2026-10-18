# Übergabe: Installation (R1) und Chef-Bot (R2)

Für die Claude-Session, die mit Johann den neuen Rakazo-Server einrichtet (R1, PIV-21) und danach den Chef-Bot
Seneca anlegt (R2, PIV-22). Stand 18.10.2026, Branch `jhl` des privaten Forks `jhltwietmeyer-ux/rakazo`.
Du hast keinen SSH-Zugang zum Server. Du gibst Johann je Nachricht einen Schritt mit Befehlsblock, er führt ihn
in seinem Terminal aus und meldet die Ausgabe zurück; du wertest sie aus. Johann duzt, antworte deutsch und knapp.
Lesereihenfolge: diese Datei, dann `docs/jhl/README.md`, dann `docs/self-host.md` Abschnitt „Public single-VM
deployment" samt „Docker computers on the production stack", dann `docs/jhl/bots/seneca.md` Abschnitt C.
Die Entscheidungen in Abschnitt 1 sind getroffen. Nicht neu abwägen.

## 1. Stand und Entscheidungen

| Thema | Festlegung |
|---|---|
| Server | Hetzner Cloud CPX42 (8 vCPU AMD, 16 GB RAM, 320 GB SSD), Falkenstein, IPv4 und IPv6. Keine Volumes, kein privates Netz, kein Cloud-init |
| Image | „Docker CE" (Ubuntu mit Docker Engine und Compose-Plugin). Rakazo verlangt Docker Engine 26 oder neuer, API 1.45 (`docs/self-host.md`, Abschnitt „Published images (no checkout)") |
| Zugang | Ein SSH-Key von Johanns Rechner. Nach Schritt 3.3 nur noch Nutzer `deploy`, kein Root-Login, kein SSH-Passwort |
| Firewall | Hetzner-Firewall eingehend TCP 22, 80, 443 und UDP 443; dazu UFW aus `harden-host.sh` |
| Backups | Hetzner-Backups aktiv. Zusätzlich `rakazo-backup.timer` mit lokalen Dumps unter `/var/backups/rakazo`, sieben Tage |
| IP, Domain | Nennt Johann im Chat. Hier stehen nur `<SERVER-IP>` und `<DOMAIN>`; du setzt beides selbst in die Blöcke ein |
| Login-E-Mail | Platzhalter `<E-MAIL>`. Johann tippt sie nur in sein Terminal (3.7) und in die App, nie in den Chat |
| Layout | Checkout `/srv/rakazo`, Besitzer `deploy`, Branch `deploy`. Jeder Compose-Aufruf mit `infra/compose/docker-compose.prod.yml` plus `infra/compose/docker-compose.prod.docker.yml` (lokale Docker-Rechner, kein E2B). `RAKAZO_IMAGE_TAG=local`, Build aus dem Checkout mit `--build-arg GIT_SHA=$(git rev-parse HEAD)`. Kein `updater`-Profil. HTTPS macht Caddy aus dem Compose |
| Branches | `main` folgt dem Original (`upstream`), eigene Arbeit auf `jhl`, der Server baut `deploy` |
| Deploy | Cron alle 2 Minuten ruft `/root/rakazo-deploy.sh` auf (Kopie von `jhl/server/rakazo-deploy.sh`), Log `/var/log/rakazo-deploy.log`. Auf `deploy` pushst du nur auf ausdrückliche Anweisung von Johann: `git push origin jhl:deploy`. Der Branch existiert noch nicht und entsteht beim ersten erlaubten Push |
| Sprache, Commits | Doku, Commits, Bot-Texte Deutsch; Code und Kommentare Englisch. Commit-Präfix mit Schritt (`R1: …`, `R2: …`). Attributions-Zeilen so, wie du sie im System-Hinweis deiner Session bekommst. Keine Modell-IDs in Commit-Texten |
| Linear | Team „Pivat", Projekt „Agenten-Netz". PIV-21 = R1, PIV-22 = R2 |
| Nicht tun | Kein Telegram, keine Messaging-Anbindungen (Johanns Entscheidung, nicht wieder vorschlagen). Keine Original-Dateien ändern. Keine Secrets anfassen, erfragen oder anzeigen lassen. Nicht ungefragt auf `deploy` pushen |
| Abweichungen vom Plan | `01-pruefung-und-anpassungsplan.md` nennt CX43 und `SIGNUPS_ENABLED=false`; es gilt CPX42 und `SIGNUPS_ENABLED=true` mit Allowlist (wie in `docs/self-host.md`). Composio aus der R1-Zeile des Plans ist nicht Teil von R1; das Konto und `COMPOSIO_API_KEY` kommen erst mit R3 oder R4, wenn die erste Anbindung gebraucht wird |

## 2. Was Johann vorher bereitstellt

- Die IPv4-Adresse des Servers, im Chat.
- Eine Subdomain mit A-Record auf diese IP. AAAA nur, wenn er auf die IPv6 des Servers zeigt. Liegt die Domain bei
  Cloudflare: Proxy aus („DNS only"), denn der Proxy-Betrieb braucht laut `docs/self-host.md` ein eigenes Caddyfile.
- SSH-Zugang als root mit seinem Key (beim Anlegen des Servers hinterlegt).
- Im Browser offen: GitHub, Fork `jhltwietmeyer-ux/rakazo`, Settings, Deploy keys.
- Einen Passwortmanager für das sudo-Passwort des Nutzers `deploy` (3.2).
- Einen Anthropic-API-Schlüssel für 3.12, nur zur Eingabe in der App. Ein iPhone mit der Rakazo-App.

## 3. Ablauf R1, Schritt für Schritt

Regeln für alle Blöcke: kein `exit` (die SSH-Sitzung bliebe sonst nicht offen), keine Ausgabe von Geheimnissen.
Zeigt eine Ausgabe doch einen Schlüssel, kürzt Johann ihn heraus, bevor er sie dir schickt.

### 3.1 Erstlogin als root, Prüfung, Updates

Ziel: Server erreichbar, Docker in passender Version, System aktuell. Auf Johanns Rechner `ssh root@<SERVER-IP>`:

```bash
lsb_release -ds; uname -m; nproc; free -g | head -2; df -h / | tail -1
docker version --format 'Engine {{.Server.Version}} API {{.Server.APIVersion}}'
docker compose version; docker compose up --help | grep -c -- '--wait-timeout'
systemctl is-active docker cron
apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
DEBIAN_FRONTEND=noninteractive apt-get install -y git curl openssl dnsutils tmux
command -v docker git curl openssl flock setpriv dig tmux
[ -f /var/run/reboot-required ] && echo "NEUSTART NOETIG" || echo "kein Neustart noetig"
```

Erwartete Ausgabe / Prüfung: Ubuntu, `x86_64`, 8 Kerne, rund 15 GiB RAM. Engine 26 oder höher, API 1.45 oder
höher, Compose v2, Zähler für `--wait-timeout` mindestens 1, zweimal `active`, alle acht Pfade gefunden (`docker`
unter `/usr/bin/docker`, sonst die sudo-Regel in 3.2 anpassen). Bei „NEUSTART NOETIG": `reboot`, neu einloggen.

### 3.2 Nutzer deploy

Ziel: Key-only-Nutzer `deploy`, den `harden-host.sh` voraussetzt. Das Skript prüft nur, dass er existiert, und
lässt danach per SSH nur ihn zu (`AllowUsers`, `PermitRootLogin no`); eine sudo-Regel legt es nicht an.
`deploy-main.sh` setzt „passwordless sudo for Docker" voraus. Daher: sudo ohne Passwort nur für `/usr/bin/docker`,
alles andere mit Passwort. Das Passwort setzt Johann selbst (Passwortmanager); es dient für sudo und die
Hetzner-Konsole im Notfall, nie für SSH. Ehrlich dazu: Docker per sudo ist root-gleich, der Schutz ist der SSH-Key.

In der root-Sitzung:

```bash
useradd -m -s /bin/bash -G sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
echo 'deploy ALL=(root) NOPASSWD: /usr/bin/docker' > /etc/sudoers.d/90-rakazo-deploy
chmod 440 /etc/sudoers.d/90-rakazo-deploy
visudo -cf /etc/sudoers.d/90-rakazo-deploy
```

Danach einzeln: `passwd deploy` (zweimal eingeben, nicht in den Chat). Die root-Sitzung bleibt offen. In einem
zweiten Terminal auf Johanns Rechner `ssh deploy@<SERVER-IP>`, dann:

```bash
id
sudo -n docker version --format 'docker ok {{.Server.Version}}'
sudo -n true 2>/dev/null && echo "WARNUNG: sudo ohne Passwort fuer alles" || echo "ok: ohne Passwort nur docker"
sudo -v && echo "ok: sudo mit Passwort"
```

Erwartete Ausgabe / Prüfung: visudo meldet `parsed OK`; `id` nennt die Gruppe `sudo`; `docker ok …`;
`ok: ohne Passwort nur docker`; nach der Passwortabfrage `ok: sudo mit Passwort`.

### 3.3 harden-host.sh

Ziel: Grundhärtung aus dem Original (SSH nur per Key und nur `deploy`, UFW, fail2ban, Sicherheitsupdates,
AppArmor, Audit-Regeln). In der root-Sitzung laden und Prüfsumme zeigen:

```bash
curl -fsSL -o /root/harden-host.sh https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/harden-host.sh
sha256sum /root/harden-host.sh; wc -l /root/harden-host.sh
```

Du vergleichst lokal mit `git fetch upstream main && git show upstream/main:infra/compose/harden-host.sh | sha256sum`.
Nur bei Gleichheit weiter, in der root-Sitzung: `DEPLOY_USER=deploy bash /root/harden-host.sh`

Erwartet als letzte Zeile: `Rakazo host hardening applied. Verify a fresh SSH session before closing the current
one.` Dann auf Johanns Rechner in einem neuen Terminal, jede Zeile nur einmal (fail2ban sperrt nach drei
Fehlversuchen):

```bash
ssh deploy@<SERVER-IP> 'echo login ok; sudo -n docker ps --format x >/dev/null && echo docker ok'
ssh -o BatchMode=yes root@<SERVER-IP> true || echo "root gesperrt, gut"
```

Erwartet: `login ok`, `docker ok`, `Permission denied`, `root gesperrt, gut`. Als `deploy` noch
`sudo ufw status verbose` (22/tcp LIMIT, 80/tcp, 443/tcp, 443/udp). Erst dann die root-Sitzung schließen. Ab hier
arbeitet Johann nur noch als `deploy`.

### 3.4 Deploy Key für den privaten Fork

Ziel: Der Server liest den Fork per SSH mit einem Nur-Lesen-Schlüssel, ohne Token und Passwort. Als `deploy`:

```bash
ssh-keygen -t ed25519 -N "" -C "rakazo-server-deploy-key" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

Johann im Browser: Fork, Settings, Deploy keys, „Add deploy key". Titel `rakazo-server`, Key = die Zeile aus `cat`,
„Allow write access" leer lassen, speichern. Dann:

```bash
ssh -T -o StrictHostKeyChecking=accept-new git@github.com; ssh-keygen -lf ~/.ssh/known_hosts
```

Erwartete Ausgabe / Prüfung: `Hi jhltwietmeyer-ux/rakazo! You've successfully authenticated, but GitHub does not
provide shell access.` (Exit-Code 1 ist normal). Johann vergleicht den Fingerprint mit der Seite „GitHub's SSH key
fingerprints" in der GitHub-Doku. Der private Schlüssel verlässt den Server nie.

### 3.5 Branch deploy anlegen (nur mit Freigabe)

Ziel: `deploy` existiert im Fork und enthält Übergabe und Deploy-Skript. Du prüfst lokal:

```bash
git fetch origin && git status -sb
git ls-tree -r --name-only origin/jhl -- jhl/server/rakazo-deploy.sh docs/jhl/02-uebergabe-r1-r2.md
```

Fehlt eine Datei, erst committen und `jhl` pushen. Dann fragst du Johann ausdrücklich: „Darf ich `jhl` nach
`deploy` pushen? Das legt den Branch an; ab 3.10 baut der Server jede Änderung daran." Nur nach seinem Ja:
`git push origin jhl:deploy`. Prüfung: `git ls-remote origin deploy` zeigt denselben Commit wie `origin/jhl`.

### 3.6 Checkout nach /srv/rakazo

Ziel: Checkout im Standardpfad, den Compose und Backup voraussetzen. Als `deploy`:

```bash
sudo install -d -o deploy -g deploy -m 755 /srv/rakazo
git clone --branch deploy --single-branch git@github.com:jhltwietmeyer-ux/rakazo.git /srv/rakazo
git -C /srv/rakazo log --oneline -1
ls -ld /srv/rakazo /srv/rakazo/jhl/server/rakazo-deploy.sh /srv/rakazo/infra/compose/docker-compose.prod.docker.yml
```

Erwartete Ausgabe / Prüfung: Commit wie `origin/deploy` aus 3.5, Besitzer `deploy`, beide Dateien vorhanden.

### 3.7 docker-daemon.json und .env

Ziel: Docker-Daemon wie für den Produktions-Host vorgesehen; `.env` mit frischen Geheimnissen, die nie angezeigt
werden. `docs/self-host.md`: „The production host also uses `infra/compose/docker-daemon.json`" (Live-Restore,
begrenzte Logs, `no-new-privileges`, kein Userland-Proxy). Zuerst nachsehen:

```bash
sudo test -e /etc/docker/daemon.json && sudo cat /etc/docker/daemon.json || echo "keine daemon.json vorhanden"
```

Gibt es schon eine Datei mit Inhalt, führst du beide zusammen und gibst Johann das Ergebnis. Sonst:

```bash
sudo install -m 644 /srv/rakazo/infra/compose/docker-daemon.json /etc/docker/daemon.json
sudo dockerd --validate --config-file /etc/docker/daemon.json
sudo systemctl restart docker
sudo docker info --format 'Logging={{.LoggingDriver}} LiveRestore={{.LiveRestoreEnabled}}'
```

Erwartet: `configuration OK` und `Logging=local LiveRestore=true`.

Prüfergebnis `OPENROUTER_API_KEY`: darf leer bleiben. In `apps/api/src` und `apps/worker/src` kommt die Variable
nicht vor; beide lesen sie über `resolveDeploymentModel()` (`packages/adapters/src/deployment-model.ts`), das ohne
Schlüssel nur `configured: false` liefert und nichts wirft (`apps/api/src/env.ts`, `deploymentModelConfigured`;
`apps/worker/src/index.ts` Zeile 99). Die API meldet dann `needsModel` (`apps/api/src/router.ts`, `modelSetup`), die
App verlangt ein verbundenes Modell. Pflicht beim Start sind `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`,
`SCREEN_PROXY_SECRET` und bei Docker-Rechnern `SANDBOX_SUPERVISOR_TOKEN`, die letzten beiden mit mindestens 32
Zeichen und voneinander verschieden (`packages/core/src/secrets-guard.ts`). `docs/self-host.md` zählt
`OPENROUTER_API_KEY` zum Minimum, der Code nicht.

Warum eine knappe `.env` statt einer Kopie von `.env.example`: Sie ist `env_file` von API und Worker, und die
Vorlage enthält Entwicklungswerte wie `GIT_SHA=`. Der leere Wert überschriebe das im Image gesetzte `ENV GIT_SHA`
(`infra/compose/Dockerfile`), `/internal/health` zeigte keine Revision. Alle Schlüssel unten stammen aus
`.env.example` und dem Beispiel in `docs/self-host.md`; der Rest bleibt auf den Vorgaben im Code. Keine
Messaging-Variablen.

Schritt a, allein einfügen und die Adresse tippen: `read -r -p 'Login-E-Mail fuer die Allowlist: ' RAKAZO_MAIL`

Schritt b (du setzt `<DOMAIN>` ein):

```bash
cd /srv/rakazo
if [ -e .env ]; then echo "ABBRUCH: .env existiert schon, nichts geaendert."
elif [ -z "${RAKAZO_MAIL:-}" ]; then echo "ABBRUCH: RAKAZO_MAIL ist leer, Schritt a wiederholen."
else
( umask 077; cat > .env <<EOF
NODE_ENV=production
RAKAZO_HOST=<DOMAIN>
BETTER_AUTH_URL=https://<DOMAIN>
WEB_ORIGIN=https://<DOMAIN>
API_URL=https://<DOMAIN>
POSTGRES_USER=rakazo
POSTGRES_DB=rakazo
POSTGRES_PASSWORD=$(openssl rand -hex 16)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
SCREEN_PROXY_SECRET=$(openssl rand -hex 32)
SANDBOX_SUPERVISOR_TOKEN=$(openssl rand -hex 32)
SANDBOX_PROVIDER=docker
AGENT_RUNTIME=pi
WAKEUP_DRIVER=graphile
DATA_DIR=/data
RAKAZO_DEPLOY_DIR=/srv/rakazo
RAKAZO_IMAGE_TAG=local
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=${RAKAZO_MAIL}
OPENROUTER_API_KEY=
EOF
)
unset RAKAZO_MAIL
fi
ls -l .env; cut -d= -f1 .env | paste -sd' '
grep -E '^(NODE_ENV|RAKAZO_HOST|BETTER_AUTH_URL|WEB_ORIGIN|API_URL|SANDBOX_PROVIDER|RAKAZO_DEPLOY_DIR|RAKAZO_IMAGE_TAG|SIGNUPS_ENABLED)=' .env
awk -F= '/^(POSTGRES_PASSWORD|BETTER_AUTH_SECRET|ENCRYPTION_KEY|SCREEN_PROXY_SECRET|SANDBOX_SUPERVISOR_TOKEN)=/ {print $1, length($2)}' .env
grep -q '^SIGNUP_ALLOWLIST=.*@' .env && echo "Allowlist gesetzt" || echo "FEHLER: Allowlist leer"
git status --short --ignored .env
```

Erwartete Ausgabe / Prüfung: `-rw------- … deploy deploy … .env`; 21 Schlüsselnamen; neun Klartextzeilen, davon
dreimal `https://<DOMAIN>`; Länge 32 für `POSTGRES_PASSWORD`, 64 für die vier anderen; `Allowlist gesetzt`;
`!! .env` (von Git ignoriert). Die Werte selbst sieht niemand, auch du nicht.

### 3.8 DNS prüfen

Ziel: Caddy bekommt beim ersten Start ein Zertifikat; dafür muss die Domain schon auf den Server zeigen.

```bash
dig +short A <DOMAIN>; dig +short AAAA <DOMAIN>
ip -4 -br addr show scope global; ip -6 -br addr show scope global
```

Erwartet: A = `<SERVER-IP>`. AAAA leer oder gleich der globalen IPv6 des Servers. Sonst nicht weitermachen.

### 3.9 Erster Build und Start

Ziel: Stack läuft, `/health` antwortet über HTTPS. Damit ein abreißendes SSH den Build nicht abbricht, zuerst
`tmux new -s rakazo` (zurück mit `tmux attach -t rakazo`). Dann als `deploy`:

```bash
cd /srv/rakazo
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml config --quiet && echo "Compose-Konfiguration ok"
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml pull --ignore-buildable
time sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml build --build-arg GIT_SHA=$(git rev-parse HEAD)
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml up -d --wait --wait-timeout 300 --pull never
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml ps
```

`pull --ignore-buildable` holt nur Postgres, Caddy und Busybox; ohne sie scheitert `--pull never`. Gebaut werden das
App-Image (`api`, `worker`, `web`, `supervisor`) und das Rechner-Image `computer`. Dauer: nicht dokumentiert, die
Doku sagt für Builds auf dem Server nur „minutes rather than seconds"; Schätzung fürs erste Mal 15 bis 30 Minuten.

Erwartete Ausgabe / Prüfung: `Compose-Konfiguration ok`; `up` endet ohne Fehler; `ps` zeigt `postgres`, `api`,
`supervisor` als `healthy`, `worker`, `web`, `caddy` als `Up`. Die One-shot-Dienste `computer` und `data-init`
erscheinen nur mit `ps -a`, beendet mit Code 0. Dann:

```bash
curl --fail -sS https://<DOMAIN>/health; echo
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml exec api \
  node -e "fetch('http://127.0.0.1:3100/internal/health').then(r=>r.text()).then(console.log)"
git rev-parse HEAD
```

Erwartet: `{"ok":true}`, dann JSON mit `"runtime":"pi"`, `"sandbox":"docker"`, `"messaging":false` und
`"revision"` gleich `git rev-parse HEAD`. Kein Zertifikat: Abschnitt 6, erster Punkt.

### 3.10 Deploy-Skript und Cron

Ziel: Jeder erlaubte Push auf `deploy` landet binnen etwa 2 Minuten auf dem Server. Das Skript läuft als root per
Cron und führt `git` als `deploy` aus (Begründung im Kopfkommentar von `jhl/server/rakazo-deploy.sh`). Die Domain
liest es aus `RAKAZO_HOST` in `.env`; `/etc/rakazo-deploy.conf` mit `DOMAIN=…` ist optional. Als `deploy`:

```bash
sudo install -m 700 -o root -g root /srv/rakazo/jhl/server/rakazo-deploy.sh /root/rakazo-deploy.sh
sudo /root/rakazo-deploy.sh; echo "exit=$?"
sudo /root/rakazo-deploy.sh --force; echo "exit=$?"
echo '*/2 * * * * root /root/rakazo-deploy.sh' | sudo tee /etc/cron.d/rakazo-deploy >/dev/null
sudo chmod 644 /etc/cron.d/rakazo-deploy; cat /etc/cron.d/rakazo-deploy
sudo tail -n 5 /var/log/rakazo-deploy.log
```

Erwartete Ausgabe / Prüfung: Der erste Aufruf endet still mit `exit=0` (nichts Neues). Der zweite baut mit Cache neu
und schreibt `START forced redeploy of …` und `OK deployed … https://<DOMAIN>/health 200`, `exit=0`. Die
Build-Ausgabe steht in `/var/log/rakazo-deploy-last.log`. Den Weg über Cron testest du in 3.13.

### 3.11 Backup-Skript und Timer

Ziel: Nächtliche, geprüfte Dumps zusätzlich zu den Hetzner-Backups.

```bash
sudo install -m 755 /srv/rakazo/infra/compose/backup-prod.sh /usr/local/sbin/rakazo-backup
sudo install -m 644 /srv/rakazo/infra/systemd/rakazo-backup.service /srv/rakazo/infra/systemd/rakazo-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rakazo-backup.timer
sudo systemctl start rakazo-backup.service
sudo journalctl -u rakazo-backup.service -n 5 --no-pager
sudo sh -c 'ls -l /var/backups/rakazo/*/'
systemctl list-timers rakazo-backup.timer --no-pager
```

Erwartete Ausgabe / Prüfung: `Verified Rakazo backup written to /var/backups/rakazo/<Zeitstempel>`; darin
`rakazo.dump`, `appdata.tgz`, `SHA256SUMS`, alle `-rw-------`; nächster Lauf 02:15 UTC plus bis zu 15 Minuten.
`/etc/rakazo/backup.env` ist nicht nötig. Das Skript ruft Compose nur mit der Basisdatei auf, aber nur für `exec`
und `ps`; das erzeugt nichts neu und bleibt so (Original-Datei).

### 3.12 Abnahme

1. `curl -sS -o /dev/null -w '%{http_code}\n' https://<DOMAIN>/health` liefert `200`.
2. Johann öffnet `https://<DOMAIN>` und registriert sich gleich nach dem ersten Start mit der Allowlist-Adresse.
   Ohne SMTP darf laut `docs/self-host.md` das erste Allowlist-Konto ohne Bestätigungsmail registrieren; der erste
   Nutzer wird Eigentümer der Installation.
3. In der App unter „Modelle", „Modell verbinden", Anthropic wählen, Schlüssel nur dort eingeben.
4. Über „+" einen Test-Bot anlegen und schreiben: „Führe im Team-Computer mit dem Werkzeug shell `uname -a` aus."
   Freigabekarte: „Einmal erlauben". Erwartet: `Linux … x86_64 …`.
5. Auf dem Server: `sudo docker ps -a --filter ancestor=rakazo/computer:local --format '{{.Names}} {{.Status}}'`
   zeigt den Rechner als `Up`. Nach gut 10 Minuten ohne Nutzung (`SANDBOX_IDLE_MS`, Vorgabe 600000) wiederholen:
   Er läuft nicht mehr. prüfen: ob er dann als `Exited` erscheint oder ganz fehlt.
6. iPhone: Rakazo-App, auf der Anmeldeseite „Use a custom server" (deutsch „Eigenen Server verwenden"),
   `https://<DOMAIN>` eintragen, anmelden; der Test-Bot ist sichtbar.

Scheitert ein Punkt: Logs aus Abschnitt 4 holen, auswerten, beheben, Punkt wiederholen.

### 3.13 Abschluss R1

- `docs/jhl/README.md` um einen Abschnitt „Betrieb" ergänzen: Deploy-Befehl `git push origin jhl:deploy` (nur auf
  Johanns Anweisung), Logs `/var/log/rakazo-deploy.log` und `/var/log/rakazo-deploy-last.log`, Backups unter
  `/var/backups/rakazo`, der volle Compose-Aufruf für Logs und Neustart aus Abschnitt 4, Verweis auf diese Datei.
  Commit auf `jhl` mit Präfix `R1:`, Push nach `origin jhl`.
- Johann fragen, ob dieser Commit nach `deploy` darf. Wenn ja: pushen; nach 2 bis 3 Minuten zeigt
  `sudo tail -n 5 /var/log/rakazo-deploy.log` erst `START deploy …`, später `OK deployed …`. Das testet den Cron-Weg.
- PIV-21 kommentieren (was eingerichtet ist, Abnahme bestanden; ohne IP, E-Mail und Werte aus `.env`), schließen.

## 4. Betrieb: die fünf Befehle

Alle als `deploy` in `/srv/rakazo`, immer mit beiden Compose-Dateien und `--env-file`.

```bash
# 1. Logs ansehen (Strg+C beendet)
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml logs --tail 100 -f api worker supervisor caddy

# 2. Neustart (nach Änderung der .env stattdessen: up -d --wait --wait-timeout 300 --pull never)
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml restart api worker web

# 3. Status
sudo docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml ps && curl --fail -sS https://<DOMAIN>/health; echo

# 4. Deploy sofort anstoßen (holt origin/deploy); mit --force baut es den aktuellen Stand neu
sudo /root/rakazo-deploy.sh; sudo tail -n 10 /var/log/rakazo-deploy.log

# 5. Backup prüfen
systemctl list-timers rakazo-backup.timer --no-pager; sudo ls -lt /var/backups/rakazo | head -n 8
sudo journalctl -u rakazo-backup.service -n 5 --no-pager
```

## 5. Ablauf R2

Voraussetzung: R1 abgenommen, Anthropic in der App verbunden. Grundlage ist `docs/jhl/bots/seneca.md` Abschnitt C,
Punkte 1 bis 11, in dieser Reihenfolge.

- Du: Johann je Punkt sagen, wo er in der App klickt, und ihm die Texte zum Einfügen geben (Block A für das Feld
  „Beschreibung", Block B für den Skill, die Startinhalte von `NETZ.md` und `ENTSCHEIDUNGEN.md`). Vorher lokal
  prüfen, dass Block A unter 4.000 Zeichen bleibt (`wc -m`). Bot-Texte nur in `seneca.md` ändern, dann in die App;
  Commit auf `jhl` mit Präfix `R2:`.
- Johann: alle Klicks und Eingaben in der App, Modell für Seneca setzen, Space-Standardmodell prüfen,
  Freigabekarten beantworten (anfangs „Einmal erlauben").
- Abnahme (Punkte 9 bis 11): Seneca fragt nacheinander nach Zweck, Name, Modell und Rechner, zeigt den Entwurf und
  legt erst nach Johanns Ja an; der Test-Bot erscheint in der Bot-Liste und in `NETZ.md`; Archivieren mit Rückfrage
  und Karte, danach fehlt er in der Liste und in `NETZ.md`.
- Danach PIV-22 kommentieren und schließen.

## 6. Bekannte Stolpersteine

- **Kein Zertifikat:** Caddy holt es nur, wenn der A-Record schon zeigt, kein falscher AAAA-Record existiert und
  TCP 80/443 in der Hetzner-Firewall offen sind. Prüfen mit Befehl 1 (`caddy`), nach der Korrektur `… restart
  caddy`. Nicht in Schleife neu starten, die Zertifizierungsstelle begrenzt Fehlversuche.
- **Ausgesperrt nach harden-host.sh:** Es lässt nur `deploy` per Key herein. Fehlt der Key in
  `/home/deploy/.ssh/authorized_keys` (600, Besitzer `deploy`), ist SSH zu; darum bleibt in 3.3 die root-Sitzung
  offen. Notfall: Hetzner-Konsole, Login `deploy` mit dem Passwort aus 3.2.
- **Docker umgeht UFW:** Veröffentlichte Ports laufen an UFW vorbei, die Hetzner-Firewall ist die Außenwand. Keine
  weiteren Ports veröffentlichen, `docker-compose.postgres-host.yml` nie auf diesem Server.
- **Build braucht RAM und Zeit:** Builds immer in `tmux`. Platz mit `sudo docker system df` beobachten; nach jedem
  Deploy läuft `docker image prune -f`. Bei Platzmangel `sudo docker builder prune` (nächster Build langsamer).
- **`pgdata` nie löschen:** kein `down -v`, kein `docker volume rm`, kein `docker system prune --volumes`.
- **`ENCRYPTION_KEY` nie ändern:** Gespeicherte Zugangsdaten und Bot-Secrets sind damit verschlüsselt; ein neuer
  Wert macht sie unlesbar, auch in einem zurückgespielten Dump.
- **`.env` ist nicht im Git** und nicht in `/var/backups/rakazo`, nur im Hetzner-Backup. `git reset --hard` lässt
  sie stehen; `git clean -x` in `/srv/rakazo` würde sie löschen, also nie.
- **Postgres-Passwort:** nur Hex, keine Zeichen `@ : / ? # %` (sie brechen `DATABASE_URL`). Postgres übernimmt es
  nur beim ersten Anlegen von `pgdata`; später in `.env` geändert, sperrt es die App aus.
- **Immer beide `-f`-Dateien:** Ohne das Overlay fehlen Supervisor und Rechner-Image, und API und Worker verlieren
  die Supervisor-Adresse; ein `up` mit der Basisdatei allein baut die Topologie um. Ausnahme: Backup-Skript (3.11).
- **Signups:** `SIGNUPS_ENABLED` wirkt nur beim ersten API-Start, `SIGNUP_ALLOWLIST` bei jedem Start. Ohne SMTP
  kann nur das erste Allowlist-Konto ohne Bestätigung registrieren.
- **Fehlgeschlagener Deploy:** Das Skript setzt `HEAD` vor dem Build auf den neuen Commit und wiederholt ihn nicht
  alle 2 Minuten. Behebung: neuer erlaubter Push auf `deploy` oder `sudo /root/rakazo-deploy.sh --force`. Zurück
  auf einen alten Stand: Revert-Commit auf `jhl`, mit Johanns Freigabe nach `deploy`.
- **`/root/rakazo-deploy.sh` ist eine Kopie:** Nach Änderungen an `jhl/server/rakazo-deploy.sh` die erste Zeile von
  3.10 erneut ausführen.
- **Rescale:** Größerer Servertyp in der Hetzner-Konsole (ausschalten, ändern, einschalten) ändert nichts an der
  Installation; die Container starten wegen `restart: unless-stopped` selbst. Danach Befehl 3 aus Abschnitt 4.

## 7. Startprompt für die neue Session

```text
Du bist die Session für die Installation von Rakazo auf meinem neuen Hetzner-Server (R1, PIV-21) und danach für den Chef-Bot Seneca (R2, PIV-22).
Lies zuerst docs/jhl/02-uebergabe-r1-r2.md vollständig, dann die dort genannte Lesereihenfolge.
Es gelten die Regeln aus Abschnitt 1: Deutsch, du, Commit-Präfix R1/R2, keine Modell-IDs in Commit-Texten, keine Original-Dateien ändern.
Du hast keinen SSH-Zugang. Gib mir pro Nachricht genau einen Schritt: Ziel, Befehlsblock, was ich zurückmelden soll.
Warte dann auf meine Ausgabe und werte sie aus, bevor du weitergehst.
Beginne mit Schritt 3.1. Server-IP: <SERVER-IP>. Domain: <DOMAIN>.
Keine Secrets anfassen, erfragen oder anzeigen lassen. Meine Login-E-Mail nenne ich nicht im Chat.
Auf deploy pushst du nur, wenn ich es ausdrücklich sage.
Kein Telegram und keine Messaging-Anbindungen, auch nicht vorschlagen.
```
