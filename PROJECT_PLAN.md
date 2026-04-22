# Statistik + – V1 Scope und UI-Plan

## 1. Umfang von Statistik + V1

### Enthalten
- eigenständige Chrome-Erweiterung
- eigener lokaler Speicherbestand
- Dashboard-Seite/Overlay `Statistik +`
- KPI-Karten
- 2 Ranking-Tabellen
- 4 Chart-Slots
- Zeitraumfilter
- Export/Import
- Demo-Daten zum Gegencheck der UI

### Nicht in V1
- kein Eingriff in den Session Coach
- keine Cloud-Synchronisierung
- keine serverseitige Historie
- keine Cross-Device-Synchronisierung
- keine komplexe Match-Replay-Ansicht
- keine Live-Coaching-Logik

## 2. Seitenstruktur / UI

### Header
- Titel `Statistik +`
- Untertitel mit Hinweis auf lokale Historie
- Filterchips: Heute / 7 Tage / 30 Tage / Alles
- Aktionen: Aktualisieren / Export / Import / Demo-Daten / Leeren / Schließen

### Statusleiste
- Parserstatus
- Legs im aktuellen Filter
- Checkouts im aktuellen Filter
- Rohereignisse gesamt
- letztes Update

### KPI-Zeile
- Best average
- Best leg
- Best checkout
- 180s

### Chart-Bereich
- Aktivitätsübersicht
- Average-Verlauf
- Checkout-Quote
- Doppel-Performance

### Tabellenbereich
- Top 10 Legs
- Top 10 Checkouts

## 3. Technische Grundidee

### Datenfluss
Bridge -> Rohereignisse -> heuristische Normalisierung -> IndexedDB -> Aggregation -> Dashboard

### Speicherobjekte
- rawEvents
- legs
- checkouts
- meta

### Erweiterbarkeit für V2
- exakter Autodarts-Adapter pro echter Payload-Struktur
- Match-Ansicht
- pro Gegner / pro Format / pro Board Filter
- First-9, Busts, Finish-Routen, Lieblingsdoppel
