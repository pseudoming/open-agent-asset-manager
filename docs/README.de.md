<div align="center">

# Open Agent Asset Manager

### Deine Agenten-Assets. Du wählst die Tools.

Skills, Anweisungen und Workflows verdienen einen Platz jenseits eines einzelnen Coding-Tools.

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Deutsch](README.de.md)

[Download](https://github.com/pseudoming/open-agent-asset-manager/releases) · [Anleitung](USAGE.de.md) · [Aus Quellcode bauen](BUILD.de.md) · [Technischer Einblick](ARCHITECTURE.de.md)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](../LICENSE) · Desktop-Beta

</div>

![OAAM mit einer gespeicherten Teamanleitung im Beispielprojekt Atlas Notes](images/oaam-overview.png)

*Vorschau einer gespeicherten Teamanleitung im synthetischen Beispielprojekt Atlas Notes.*

## Was du damit machen kannst

**Vorhandene Arbeit mitnehmen**

Wiederverwendbare Skills und Anweisungen samt Dateien in einer versionierten Bibliothek sammeln.

**Änderungen vorher prüfen**

Ein Ziel-Tool wählen und die geplanten Dateiänderungen vor dem Anwenden prüfen.

**Verbesserungen behalten**

Unterstützte externe Änderungen als neue Version in die Bibliothek übernehmen.

OAAM verwaltet **Guidance, Rules, Workflows, Skills, Subagent-Deklarationen und Memory**. Projektbezogene Assets und eine globale Bibliothek halten die Zuordnung klar. Bei vollständigen Verzeichnis-Assets bleiben Ressourcen, relative Pfade, Dateiinhalt und Ausführungsattribute erhalten.

Es gibt Adapter für **Claude Code, Codex, Cursor, OpenCode, Antigravity und zcode**. Welche Aktionen verfügbar sind, hängt vom konkreten App-, CLI- oder IDE-Einstieg, der Asset-Art, der Plattform und der erkannten Version ab. Nicht unterstützte Konvertierungen werden erklärt; bevor Details verloren gehen, ist eine Bestätigung erforderlich.

**Einstellungen mitnehmen**

Ein Skill, der nur auf deinen ausdrücklichen Aufruf hin ausgeführt werden soll, soll diese Einstellung auch nach dem Umzug behalten. OAAM erfasst die Einstellung getrennt vom Inhalt und kann sie bei unterstützten Konvertierungen für Claude Code und Cursor erhalten. Auch Modellwahl und Denkaufwand bleiben für die Zielanalyse gespeichert. [Beispiele und Grenzen](ARCHITECTURE.de.md#aufrufeinstellungen).

## Ein erster Ablauf

1. Füge ein Projekt hinzu und wähle die Tool-Verzeichnisse, die OAAM lesen darf.
2. Importiere vorhandene Anweisungen oder einen Skill und prüfe die gespeicherte Version samt Dateien.
3. Wähle ein anderes unterstütztes Tool, prüfe Ziel und Änderungen und wende sie an.
4. Werden unterstützte Dateien außerhalb von OAAM bearbeitet, kannst du diese Änderungen prüfen und als neue Version speichern.

Die [Bedienungsanleitung](USAGE.de.md) führt dich durch die einzelnen Schritte. Scans und Vorschauen wenden noch keine Änderungen an.

## Herunterladen und starten

Wähle eine veröffentlichte Beta unter [Releases](https://github.com/pseudoming/open-agent-asset-manager/releases): das ZIP für Windows x64 oder das tar.gz für Linux x64 samt zugehörigem Manifest. Entpacke das gesamte Archiv und starte unter Windows `oaam-desktop.exe` oder unter Linux `./oaam-desktop` im entpackten Ordner. Electron/Node und OAAM-Abhängigkeiten sind enthalten. Linux benötigt zusätzlich [Desktop-Systembibliotheken](USAGE.de.md#linux-systembibliotheken). Node.js und Build-Werkzeuge brauchst du nur für die [Entwicklung aus dem Quellcode](BUILD.de.md).

Beta-Versionen verwenden gemeinsam das Profil **OAAM Preview**. Beende OAAM und entpacke ein Update in einen neuen Ordner; deine gespeicherte Bibliothek bleibt im vorhandenen Profil. Lies vor dem ersten Import die [Hinweise zu Start und Updates](USAGE.de.md).

## Aktueller Umfang

- Desktop-Archive gibt es für **Windows x64 und Linux x64**. Linux ist unter Ubuntu WSL/WSLg geprüft; die Abnahme auf nativem Ubuntu und macOS steht noch aus. Die Windows-App kann auch Assets in einer ausdrücklich ausgewählten WSL-Distribution verwalten.
- Diese Vorschau ergänzt Bereitstellung und Rückübernahme von Projekt-Skills für **Claude Code CLI 2.1.220** unter Linux. Andere Tools, Geltungsbereiche und Asset-Kombinationen behalten ihre jeweiligen Unterstützungsgrenzen.
- Chatverläufe, Zugangsdaten, private Sitzungen, interne Plugin-Daten und vom Tool verwaltete eingebaute Inhalte gehören nicht zur Asset-Bibliothek.

## Mitmachen

Konkrete Anwendungsfälle, reproduzierbare Fehler und klar eingegrenzte Verbesserungen sind willkommen. Lies die [Build- und Test-Anleitung](BUILD.de.md), bevor du ein Issue oder einen Pull Request erstellst. Auch Verbesserungen der vier README-Sprachen helfen.

Geprüfte Beiträge können gemeinsam in einem öffentlichen Snapshot erscheinen. Die von den Beitragenden gewählte öffentliche Namensnennung bleibt erhalten.

## Lizenz

Der eigene Code von OAAM steht unter der [Apache License 2.0](../LICENSE). Für Abhängigkeiten Dritter und importierte Assets gelten deren jeweilige Lizenzen.
