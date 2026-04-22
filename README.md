# Statistik + für play.autodarts.io

Eigenständige Chrome-Erweiterung für ein lokales Statistik-Dashboard auf `play.autodarts.io`.

## Ziel von V1

- neue, komplett getrennte Erweiterung
- eigener Datenbestand ab Installation
- lokale Speicherung in IndexedDB
- Fokus auf Statistik/Historie statt Live-Coaching
- Dashboard im dunklen Autodarts-Stil

## Enthalten in V1

### KPI-Karten
- Best average
- Best leg
- Best checkout
- 180s

### Tabellen
- Top 10 Legs
- Top 10 Checkouts

### Charts
- Aktivitätsübersicht
- Average-Verlauf
- Checkout-Quote (wenn Parser die Versuche erkennt)
- Doppel-Performance (wenn Parser die Versuche erkennt)

### Filter
- Heute
- 7 Tage
- 30 Tage
- Alles

### Datenfunktionen
- IndexedDB als Speicherbasis
- JSON-Export
- JSON-Import
- Demo-Daten zum UI-Test
- kompletter lokaler Reset

## Architektur

### 1) Datenerfassung
Die Erweiterung klinkt sich **nur in diese neue Erweiterung** ein und verändert keinen bestehenden Session-Coach.

Aktuell erfasst V1 Daten über eine Bridge im Seitenkontext:
- `fetch`
- `XMLHttpRequest`
- `WebSocket`

Die Bridge reicht JSON-Payloads an das Content Script weiter. Danach versucht ein heuristischer Parser, daraus Leg- und Checkout-Kandidaten zu erkennen.

### 2) Speicherung
IndexedDB Stores:
- `rawEvents`
- `legs`
- `checkouts`
- `meta`

### 3) Rendering
Das Dashboard wird als eigenes Overlay auf `play.autodarts.io` gerendert.

Zugriff über:
- Floating Button `Statistik +`
- zusätzlicher Menüeintrag, sobald eine passende Navigation erkannt wird

## Wichtige Einschränkung dieser ersten Version

Da mir **kein echter Payload-/DOM-Mitschnitt aus deiner Autodarts-Session** vorlag, ist der Parser absichtlich robust, aber noch heuristisch gebaut.

Das bedeutet:
- UI, Speicher, Export/Import und Datenmodell sind bereit
- Rohdaten werden gespeichert
- Leg-/Checkout-Erkennung funktioniert schon für passende JSON-Strukturen
- für eine 100% saubere Zuordnung auf deiner Installation wird sehr wahrscheinlich **ein gezielter Adapter-Feinschliff nach deinem ersten Test** nötig sein

Die Architektur dafür ist bereits vorbereitet.

## Installation

1. Ordner entpacken
2. Chrome öffnen
3. `chrome://extensions`
4. Entwicklermodus aktivieren
5. `Entpackte Erweiterung laden`
6. Ordner `statistik-plus` auswählen
7. `https://play.autodarts.io/` öffnen oder neu laden

## Dateien

- `manifest.json` – Chrome MV3 Manifest
- `src/core.js` – globale Utilities und State
- `src/db.js` – IndexedDB Wrapper
- `src/stats.js` – Aggregationen und Dashboard-Daten
- `src/ui.js` – Overlay, Karten, Charts, Tabellen, Aktionen
- `src/collector.js` – Bridge-Verarbeitung und heuristische Normalisierung
- `src/page-bridge.js` – Hook für Fetch/XHR/WebSocket im Seitenkontext
- `src/content.js` – Bootstrap, Refresh, Menüintegration, Demo-Daten
- `src/content.css` – dunkler Dashboard-Look

## Empfohlener nächster Schritt nach deinem Test

Wenn du die erste Version geladen hast, sollten wir im nächsten Schritt einen **echten Autodarts-Payload oder DOM-Ausschnitt** von einem Match/Leg prüfen. Dann kann ich den Parser exakt auf deine reale Datenstruktur festziehen.


## Neu in V0.4

- Historie-Import direkt aus sichtbaren Spielhistorie-Seiten
- eigener Action-Button `Historie` im Overlay
- Import von Match- und Leg-Seiten über versteckte Same-Origin-Frames
- Zeitstempel werden aus der Match-ID abgeleitet, damit Filter direkt nutzbar bleiben
