# jhl/ – eigene Dienste neben Rakazo

Hier liegt alles, was Johanns Netz zusätzlich zu Rakazo braucht und was nicht in den Original-Baum gehört:

- `mcp-server/` (ab R3): eigener MCP-Server mit Werkzeugen für Bank (Enable Banking, nur lesend), PayPal,
  Nextcloud (WebDAV) und CalDAV. Läuft als eigener Container im Compose, nur im internen Netz, und wird im
  Space über `add_mcp_server` angebunden.

Regeln: keine Secrets im Repo (Umgebung des Containers oder Rakazos `request_secret`), Allowlists statt
Vollzugriff, Schreibaktionen laufen über Rakazos Freigabekarte. Doku und Plan: `docs/jhl/`.
