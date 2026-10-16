# Rakazo für Johanns Agenten-Netz: Prüfung und Anpassungsplan

> Stand 16. Oktober 2026, Originalstand `5d1b795b` (elie222/rakazo, 1.268 Commits, Apache-2.0, Beta).
> Grundlage: Code-Review des Repos (Datenmodell, eingebaute Werkzeuge, Messaging, Routinen, Secrets,
> Gedächtnis, Computer) und die Self-Host-Doku. Nichts davon wurde live ausgeführt.

## 1. Ergebnis in einem Absatz

Rakazo deckt die drei Use Cases (Buchhaltung, Entwicklerteam, E-Mail und Kalender) weit besser ab als unser
Eigenbau `jhl-Bots`: Bots legen Bots an, schreiben sich asynchron Nachrichten, planen eigene Routinen,
fragen Zugangsdaten über geschützte Karten ab, haben eigenes Gedächtnis, eigene Skills, ein Ticket-Board,
eine Sandbox mit Shell, Dateien und Browser, und sie sprechen jedes Modell über den Pi-Harness. Web-App,
Desktop-App und iPhone-App gibt es fertig. Vier Lücken bleiben: der Chef kann beim Anlegen kein Modell
setzen (kleine Kernänderung), Telegram ist ein einzelner Gateway-Bot statt ein Bot je Agent (mittlere
Kernänderung, optional), harte Tagesbudgets je Bot fehlen (optional), und Fotos aus Telegram kommen nur als
Link an (Belege besser über die App schicken). Bank, PayPal und Nextcloud bringen wir als eigenen
MCP-Server mit, ohne den Kern anzufassen.

## 2. Was Rakazo mitbringt (geprüft im Code)

| Bedarf | Rakazo | Fundstelle |
|---|---|---|
| Chef legt Agenten an | Werkzeug `spawn_bot` (name, title, instructions, prompt, computer_mode) erzeugt einen vollwertigen Bot mit Thread, Computer, Gedächtnis | `packages/adapters/src/builtin-tools.ts` |
| Agenten ändern, archivieren, löschen | `update_bot` (Name, Titel, Beschreibung, Avatar, Benachrichtigung), `archive_bot`, `delete_bot` mit Bestätigung | ebd. |
| Modell je Agent | Felder `modelProvider`, `modelId`, `thinkingLevel` je Bot, Standard je Space, Ersatzmodell je Space; Anbieter über Pi: Anthropic, OpenAI, OpenAI Codex, Google, OpenRouter, Vercel AI Gateway, DeepSeek, xAI, lokale OpenAI-kompatible Endpunkte; Schlüssel je Nutzer in der App | `packages/db/prisma/schema.prisma` (Bot, SpaceModelPreference, SpaceBackupModel, UserModelCredential), `packages/core/src/model-providers.ts` |
| Agenten schreiben sich | `message_bot` (asynchron, Absichten request/result/question/status/fyi), `handoff_to_bot` in Gruppenchats, `run_subagent` für kurzlebige Helfer | builtin-tools.ts, `child-bots.ts` |
| Rückfrage an Johann | `ask_user` (blockierend), `message_user` (Zwischenstand), Benachrichtigung bei Fertigstellung | builtin-tools.ts |
| Cron-Jobs durch den Agenten | `schedule_create` / `schedule_list` / `schedule_cancel` mit 5-Feld-Cron, Intervall oder Einmal-Termin, Zeitzone, eigenem Modell je Routine; Auslöser auch per Webhook, GitHub-Event oder eingehender Nachricht | builtin-tools.ts, `model Routine`, `apps/api/src/routine-runs.ts` |
| Freigaben für schreibende Aktionen | Karte „Allow once / Always allow this tool / Deny", gespeicherte Regeln je Space und Nutzer | `packages/adapters/src/approval-ask.ts`, `model ActionApprovalRule` |
| Zugangsdaten im Dialog | `request_secret` zeigt eine geschützte Karte in Web, Desktop und Handy; Wert wird AES-verschlüsselt gespeichert und nur in HTTPS-Aufrufe (`secret_request`) oder als Shell-Variable injiziert, nie ins Modell | `docs/bot-secrets.md`, `model BotSecret` |
| Gedächtnis | Eingebaut: Markdown-Dokumente in Postgres mit Revisionen (`remember`, `recall_memory`, `forget_memory`, `save_memory`, `save_shared_memory`); optional Supermemory oder Serenity als semantische Anbieter | `packages/memory/src/index.ts`, `model MemoryDocument` |
| Custom Skills | `skill_create` / `skill_read` / `skill_update` / `skill_delete` (gelehrte Skills je Bot) | builtin-tools.ts, `model TaughtSkill` |
| Tickets | Eingebautes Board: `ticket_create` / `ticket_get` / `ticket_update` / `ticket_comment` / `board_tickets`, Zuweisung an Bots | `model Board`, `model Ticket` |
| Werkstatt (Code ausführen) | Computer je Team oder je Bot: `shell`, `read_file` / `write_file` / `list_files`, `browser_navigate` / `browser_snapshot` / `browser_act`, `computer_observe` / `computer_act`, dazu `cloud_agent_launch` (derzeit Cursor Cloud Agents) | `docs/computer-runtime.md`, builtin-tools.ts |
| App-Anbindungen | Composio (z. B. GMAIL_CREATE_EMAIL_DRAFT, GOOGLECALENDAR, GOOGLESHEETS, OUTLOOK, GITHUB, LINEAR, ASANA) oder Pipedream; eigene MCP-Server je Space, vom Bot selbst per `add_mcp_server` anlegbar, mit OAuth-Sitzungen; OpenAPI-Werkzeugquellen | `composio-connector.ts`, `model McpServer`, `model BotMcpServer` |
| Telegram | Ein Gateway-Bot (`TELEGRAM_BOT_TOKEN`, Webhook, braucht öffentliches HTTPS). Jede Absender-Adresse ist genau einem Bot zugeordnet; Wechsel per Link-Code aus der App. Gruppen verteilen an alle Mitglieds-Bots, Ansprache per @Name. Medien kommen als Link, nicht als Anhang | `apps/api/src/messaging-inbound.ts`, `messaging-platforms.ts`, `model MessagingIdentity` |
| Oberflächen | Web (Vite, Deutsch vorhanden), Desktop (Electron, „Existing instance"), iPhone (App Store, „Use a custom server"), Android (selbst bauen) | `apps/`, `docs/self-host.md`, `docs/mobile-release.md` |
| Kosten | `UsageRecord` je Lauf, Modell und Bot; keine harten Tagesbudgets je Bot gefunden | `model UsageRecord` |

## 3. Die drei Use Cases gegen Rakazo

### 3.1 Buchhaltung

- Chef legt den Buchhaltungs-Bot an: ja (`spawn_bot`). Nach Name fragen: ja. Nach dem Modell fragen und es
  setzen: **nein**, `spawn_bot` und `update_bot` kennen kein Modell-Feld; das Modell wird in den
  Bot-Einstellungen der App gesetzt. → Kernänderung K1.
- Google Sheet anlegen und pflegen: ja, über Composio (Google Sheets, Hobby-Tarif kostenlos) oder über die
  Google-API mit `request_secret`.
- Belege per Foto: in der App ja (Anhänge werden Artefakte). Über Telegram nur als Link, ohne Übernahme der
  Datei. → Belege über die App schicken oder Kernänderung K4.
- Konten und PayPal lesend: kein fertiger Konnektor. Zwei Wege: `secret_request` ruft eine HTTPS-API mit
  injiziertem Schlüssel direkt auf (reicht für einfache Token-APIs), oder unser MCP-Server (Schicht 2) kapselt
  Enable Banking (PSD2, „Restricted Production" für eigene Konten laut Anbieter, vorher prüfen) und PayPal
  (Transaction Search, Business-Konto nötig). GoCardless nimmt keine neuen Kunden.
- Regelmäßige Jobs, die der Agent selbst anlegt: ja (`schedule_create`, Cron, Zeitzone Europa/Berlin).
- Ablage für die Steuer: Computer-Arbeitsbereich (persistent) plus Nextcloud über WebDAV, entweder per
  Shell-Werkzeug (Befehl mit Command-Variable) oder über unseren MCP-Server.

### 3.2 Entwicklerteam

- Chef legt CTO, Frontend, Backend, Integration, Reviewer an: ja, fünfmal `spawn_bot`; Rollen und
  „wer schreibt wem" stehen in den `instructions` jedes Bots. Modelle je Bot: siehe K1.
- To-do aus Asana: Composio-Asana lesen; Chef gibt per `message_bot` an den CTO.
- CTO fragt Johann bei Unklarheit: `ask_user` oder `message_user`.
- Ticket schreiben: eingebautes Board (`ticket_create`, Zuweisung an Entwickler-Bot) oder Linear über Composio.
- Entwickler setzt um: eigener „Private Computer" je Entwickler (Isolation), `shell`, Dateien, Git mit
  `GITHUB_TOKEN` als Command-Variable; alternativ `cloud_agent_launch` (Cursor) mit PR.
- Reviewer prüft: Diff per Shell oder GitHub über Composio, Kritik per `message_bot` an Entwickler und CTO.
- CTO meldet an den Chef, Chef an Johann: `message_bot`, Benachrichtigung bei Fertigstellung.
- Lange Aufträge im Hintergrund: Läufe sind Worker-Jobs; Befehle haben 5 Minuten Zeitlimit je Aufruf,
  Läufe selbst sind nicht auf Minuten begrenzt.
- Grenzen: Parallele Entwickler-Computer kosten je 2 GB RAM; Server entsprechend wählen (Abschnitt 6).

### 3.3 E-Mail und Kalender

- Gmail, Outlook, Google Kalender: Composio-Toolkits (OAuth läuft über Composio), Entwurf im Entwurfsordner
  über `GMAIL_CREATE_EMAIL_DRAFT` bzw. Outlook-Entwurf.
- Apple Kalender: kein Composio-Toolkit bekannt; CalDAV über unseren MCP-Server (Schicht 2).
- Zugangsdaten im Dialog: `request_secret` für Token-APIs, Composio-Autorisierung für OAuth.
- Schreibstil-Skill aus 300 Mails: Mails über Composio lesen, Stil destillieren, `skill_create` legt den Skill an,
  der bei Entwürfen angewendet wird.
- Kontext von Projektleiter-Bots: `message_bot`; Projektordner auf dem Team-Computer oder in Nextcloud.

## 4. Anpassungsplan in drei Schichten

### Schicht 1: Konfiguration und Inhalte (kein Code im Kern)

- Server und Installation (R1), Secrets in `.env`, Anmeldung nur für Johann (`SIGNUPS_ENABLED=false`).
- Modellschlüssel in der App (Anthropic, OpenAI, DeepSeek nach Bedarf), Space-Standardmodell und Ersatzmodell.
- Composio-Konto (Hobby) als Anbindung für Google, Microsoft, Asana, Linear, GitHub.
- Chef-Bot „Seneca" mit deutschen `instructions`: Rolle, Umgang mit Johann, Leitfaden zum Entwerfen neuer
  Bots (Name, Titel, Zuständigkeit, wer wem schreibt, Modellempfehlung nach Aufgabe und Kosten), Pflicht,
  nach Modell und Name zu fragen, Hinweis auf K1-Umweg (Modell in den Einstellungen setzen, bis K1 da ist).
- Freigaberegeln: schreibende Werkzeuge zunächst „Allow once", vertrauenswürdige Routinen später „Always allow".
- Telegram-Gateway-Bot an den Chef gebunden; Gruppen optional.

### Schicht 2: Erweiterungen außerhalb des Kerns

- `jhl/mcp-server/`: eigener MCP-Server (Node, TypeScript) als zusätzlicher Container neben Rakazo, vom Chef
  per `add_mcp_server` angebunden. Werkzeuge: Enable Banking (Konten, Umsätze), PayPal (Umsätze), Nextcloud
  (WebDAV: Ordner, Ablage, Abruf), CalDAV (Apple Kalender). Allowlists und Nur-Lesen-Regeln wie in
  `jhl-Bots`; Schreibaktionen über Rakazos Freigabekarte.
- Optional: Asana, GitHub, Linear direkt (Code aus `jhl-Bots` übernehmen), falls Composio-Grenzen stören.

### Schicht 3: Kernänderungen, als Pull Requests ans Original

- **K1 Modell beim Anlegen** (klein): `spawn_bot` und `update_bot` um `model_provider`, `model_id`,
  `thinking_level` erweitern; Validierung gegen den Modellkatalog des Space. Betrifft
  `packages/adapters/src/builtin-tools.ts`, `pi-runtime.ts`, `child-bots.ts`, Contracts, Tests.
- **K2 Ein Telegram-Bot je Agent** (mittel, optional): mehrere Telegram-Tokens, jeder fest an einen Bot
  gebunden; Identität dann je (Provider, Adresse, Bot). Betrifft `messaging-platforms.ts`,
  `messaging-inbound.ts`, `messaging-delivery.ts`, Datenmodell `MessagingIdentity`. Erst entscheiden, wenn
  die App als Hauptoberfläche ausprobiert ist.
- **K3 Tagesbudget je Bot** (klein bis mittel, optional): harter Stopp je Bot und Tag auf Basis von
  `UsageRecord`, mit Hinweis im Chat.
- **K4 Telegram-Anhänge** (klein, optional): eingehende Fotos und Dateien aus Telegram als Artefakt
  übernehmen statt als Link.

## 5. Schritte

| Schritt | Inhalt | Abnahme |
|---|---|---|
| R0 | Fork pflegen: Branch `jhl`, `docs/jhl/`, Routine zum Nachziehen des Originals | `git merge upstream/main` läuft konfliktfrei |
| R1 | Server (16 GB), Domain mit HTTPS, Installer, `.env`, erster Nutzer, Signups zu, Modellschlüssel, Composio, Telegram-Gateway | Anmeldung in Web und iPhone-App, ein Bot antwortet |
| R2 | Chef „Seneca" mit deutschen Anweisungen und Bot-Leitfaden, Freigaberegeln | Chef legt auf Zuruf einen Test-Bot an, fragt nach Name und Modell, Bot erscheint in der App |
| R3 | Buchhaltung: Sheets über Composio, Belege, Routinen, MCP-Server mit Bank/PayPal/Nextcloud | Routine pflegt ein Sheet; Beleg landet in Nextcloud; Umsätze lesbar |
| R4 | E-Mail und Kalender: Gmail/Outlook/Kalender über Composio, CalDAV im MCP-Server, Stil-Skill | Entwurf im Entwurfsordner im Stil von Johann; Termin gelesen und angelegt |
| R5 | Entwicklerteam: fünf Bots, Private Computer, GitHub-Token, Board oder Linear, Review-Schleife | Aufgabe aus Asana wird als PR mit Review abgeschlossen, Chef meldet Fertigstellung |
| R6 | Kernänderungen als PRs: K1 zuerst, K2 bis K4 nach Bedarf | PR im Original angenommen oder als gepflegter Patch auf `jhl` |

## 6. Server

Compose-Grenzen in `infra/compose/docker-compose.prod.yml`: Postgres 2 GB, API 1,5 GB, Worker 2 GB, Web
0,5 GB, Updater 1 GB, Caddy 0,25 GB, dazu je Computer 2 GB und 2 vCPU (schläft nach 10 Minuten). Für R1 bis
R4 reicht ein Server mit 8 GB knapp; mit parallelen Entwickler-Computern (R5) sind 16 GB nötig: Hetzner CX43
(8 vCPU, 16 GB, 15,99 € netto) oder CAX31 (ARM, Images sind multi-arch). Dazu 0,50 € für IPv4 und optional
Backups (20 %). Öffentliche Domain mit HTTPS ist Pflicht (Telegram-Webhook, iPhone-App).

## 7. Was aus `jhl-Bots` weiterlebt

- Personas und Zuständigkeiten (Seneca, Vitruv, Hypatia) als `instructions` der Bots.
- Konnektor-Code (Asana, GitHub, Linear) und die Allowlist-Logik als Vorlage für den MCP-Server.
- Der Leitfaden zum Entwerfen neuer Agenten (Schritt U3 im alten Plan) als Teil der Chef-Anweisungen.
- Die Regeln: Sende-Sperre nur an Johann, Schreibaktionen über Freigabe, keine Secrets in Prompts, Logs oder Chat.
