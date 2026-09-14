<div align="center">

# Open Agent Asset Manager

### Deine Agenten-Assets. Du wählst die Tools.

Skills, Anweisungen und Workflows verdienen einen Platz jenseits eines einzelnen Coding-Tools.

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Deutsch](README.de.md)

[Anleitung lesen](USAGE.de.md) · [Aus dem Quellcode starten](#aus-dem-quellcode-starten) · [Technischer Einblick](ARCHITECTURE.de.md)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](../LICENSE) · Quellcode-Vorschau

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

## Aus dem Quellcode starten

Für die **Entwicklungsvorschau unter Linux x64** benötigst du **Node.js ab 22.14**, npm und die C++-Build-Werkzeuge für dein System. Voraussetzungen für Python, Systembibliotheken und native Module stehen in der [Build-Anleitung](BUILD.de.md).

```sh
git clone https://github.com/pseudoming/open-agent-asset-manager.git
cd open-agent-asset-manager
npm ci
npm run build
npm exec -- electron-rebuild -v 42.7.0 -m packages/core -o better-sqlite3
npm run start --workspace @oaam/client-desktop
```

Der Schritt für native Module bereitet SQLite für Electron vor. Wenn du anschließend Tests unter Node ausführst, baue das Modul wie in der Build-Anleitung beschrieben erneut. Diese Quellcode-Vorschau enthält noch kein herunterladbares Desktop-Paket.

## Aktueller Umfang

- Der Schwerpunkt der Desktop-Auslieferung liegt auf **Windows x64**, einschließlich ausdrücklich ausgewählter Ubuntu-WSL-x64-Umgebungen. Ein erfolgreicher Build auf einem anderen System belegt noch keine dort geprüfte Desktop-Auslieferung.
- Chatverläufe, Zugangsdaten, private Sitzungen, interne Plugin-Daten und vom Tool verwaltete eingebaute Inhalte gehören nicht zur Asset-Bibliothek.

## Mitmachen

Konkrete Anwendungsfälle, reproduzierbare Fehler und klar eingegrenzte Verbesserungen sind willkommen. Lies die [Build- und Test-Anleitung](BUILD.de.md), bevor du ein Issue oder einen Pull Request erstellst. Auch Verbesserungen der vier README-Sprachen helfen.

Geprüfte Beiträge können gemeinsam in einem öffentlichen Snapshot erscheinen. Die von den Beitragenden gewählte öffentliche Namensnennung bleibt erhalten.

## Lizenz

Der eigene Code von OAAM steht unter der [Apache License 2.0](../LICENSE). Für Abhängigkeiten Dritter und importierte Assets gelten deren jeweilige Lizenzen.
