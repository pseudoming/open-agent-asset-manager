# OAAM verwenden

[English](USAGE.md) · [简体中文](USAGE.zh-CN.md) · [日本語](USAGE.ja.md) · [Deutsch](USAGE.de.md) · [README](README.de.md)

Diese Anleitung beschreibt die Desktop-Oberfläche. Der Quellcode-Snapshot enthält kein fertiges Binärpaket.
Die [Build-Anleitung](BUILD.de.md) erklärt Start und Auslieferungsanforderungen, die [technische Einführung](ARCHITECTURE.de.md) den Entwurf.

## Der erste Import

1. Wähle die Tools und Umgebungen aus, die OAAM untersuchen darf. Starte bei Bedarf zuerst die WSL-Distribution und wähle sie ausdrücklich aus. Eine gefundene Umgebung ist noch keine Scan-Freigabe.
2. Wähle ein Projekt oder die globale Bibliothek, prüfe die verfügbaren Quellen und den passenden Tool-Einstieg. CLI und App können dieselbe physische Quelle unterschiedlich interpretieren.
3. Prüfe das Asset und seine Ressourcen und importiere es. Eine gespeicherte Version wird getrennt von der aktuellen Quelle verwaltet.
4. Wähle die Version und prüfe ihre möglichen Einsatzorte. Kontrolliere vorhandene Dateien, die vollständig geplante Dateistruktur, Konvertierungen und nötige Freigaben. Wende erst das akzeptierte Ergebnis an.
5. Aktualisiere später den Nutzungsstatus, um externe Änderungen zu erkennen. Entscheide, ob du sie beibehalten, reparieren oder als neue Version übernehmen möchtest. Ein gespeicherter Backup-Ausgangsstand übernimmt spätere Tool-Änderungen nicht stillschweigend.

## Assets und Projekte verwalten

Versionen bewahren gespeicherte Inhalte und vollständige native Ressourcen. Bearbeitbare Anzeigenamen und
andere Asset-Metadaten werden getrennt verwaltet. Prüfe einen Export vor der Weitergabe: Asset-Archive
enthalten die eigentlichen Inhalte; Support-Bundles und Leistungstraces dienen anderen Zwecken.
Gespeicherte Freigaben lassen sich beim jeweiligen Asset einsehen und widerrufen.

Umbenennen, einen anderen Projektordner zuweisen, die Verwaltung beenden und wieder aufnehmen betrifft
Identität und Verwaltungszustand des Projekts. Ein anderer Projektordner verschiebt oder überschreibt
keine bereits bereitgestellten Dateien. Prüfe verbleibende Einsatzorte vor weiteren Aktionen.

## Backups und Wiederherstellung

Erstelle und prüfe eine Sicherung des gesamten Zustands, bevor du dich bei destruktiven Änderungen darauf
verlässt. Eine Wiederherstellung erfordert eine ausdrückliche Prüfung und ersetzt den Zustand als Einheit;
beliebige Datenbankfragmente werden dabei nicht zusammengeführt. Fehlt die Datenbank, kann die
Wiederherstellungsoberfläche ein ausgewähltes Backup prüfen und wiederherstellen. Aktualisiere danach
die verwalteten Einsatzorte in der normalen Oberfläche, um externe Änderungen mit dem wiederhergestellten Ausgangsstand abzugleichen.

## Bekannte Grenzen

- Die Unterstützung hängt vom konkreten Tool-Einstieg, Asset-Typ, der Richtung, Plattform und dem Build ab. Maßgeblich ist die angezeigte Analyse. Nicht unterstützte Aufrufe oder private Semantik können eine Konvertierung blockieren. Bewahre die Quelle, statt bedeutungsvolle Felder zu löschen, nur um einen Vorgang zu ermöglichen.
- Manche eindeutig nicht unterstützten Workflows werden noch als vorübergehender Fehler mit Wiederholungsaufforderung beschrieben.
- Nach einer Änderung des Projektordners kann ein Hinweis auf erhaltene Bereitstellungen in der globalen Bibliothek mit falschem Bezug erscheinen.
- Nach erfolgreicher Wiederherstellung kann der Host-Wechsel die dauerhafte Erfolgsmeldung entfernen. Prüfe den wiederhergestellten Zustand und aktualisiere die Nutzung; wiederhole die Wiederherstellung nicht allein wegen der fehlenden Meldung.
- Der reine Wiederherstellungseinstieg enthält noch kleinere Formulierungen, die auf eine dort nicht angezeigte Backup-Liste verweisen.
- Die Bedienung bleibt komplex und Antwortzeiten schwanken. Repräsentative Tests belegen keine ungeprüften Kombinationen aus Tool, Plattform, Sprache und Darstellung. Eine laufende Hintergrundsynchronisierung über Watcher wird derzeit nicht angeboten.
