# Johanns Anpassungen an Rakazo

Dieses Verzeichnis gehört zum privaten Fork `jhltwietmeyer-ux/rakazo`. `main` folgt dem Original
(`elie222/rakazo`, Remote `upstream`), eigene Arbeit liegt auf dem Branch `jhl`. Alles Eigene lebt in
`docs/jhl/` und, sobald es Code gibt, in `jhl/` (eigene Dienste wie der MCP-Server), damit das Nachziehen
des Originals konfliktfrei bleibt.

- `01-pruefung-und-anpassungsplan.md` — Prüfung der drei Use Cases gegen Rakazo, Anpassungsplan in drei
  Schichten, Schritte R0 bis R6.

Regeln für Sessions: Original-Dateien nur ändern, wenn der Plan es als Kernänderung vorsieht, und dann als
Pull Request ans Original. Keine Secrets, keine persönlichen Daten in diesem Repo (es ist privat, aber die
Regel gilt trotzdem). Sprache in Doku und Bot-Anweisungen Deutsch, Code Englisch wie im Original.

Original nachziehen:

```
git fetch upstream main && git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout jhl && git merge main
```
