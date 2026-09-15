# Bauen, starten und testen

[English](BUILD.md) · [简体中文](BUILD.zh-CN.md) · [日本語](BUILD.ja.md) · [Deutsch](BUILD.de.md) · [README](README.de.md)

## Voraussetzungen

Diese Anleitung gilt für die **Entwicklungsvorschau unter Linux x64**, einschließlich Ubuntu mit einer
Desktop-Sitzung oder WSLg. Benötigt werden **Node.js ab 22.14**, npm, Python 3, ein C++-Compiler und make.
Electron benötigt außerdem die üblichen Linux-Desktop-Bibliotheken. Ohne Bildschirm nutzen die Darstellungstests Xvfb.

Das Standardpaket Shared enthält die Dateisystemmechanismen für Unix-artige Systeme. Der Linux-Build
kompiliert den Dateisystemhelfer und das Modul für Dateisperren. Beide gehören zu den Schutzmechanismen des Produkts.

Der Linux-Build verlangt derzeit **g++ 11.4.0** unter `/usr/bin/x86_64-linux-gnu-g++-11`. Die geprüfte
Umgebung und CI verwenden **Ubuntu 22.04 x64**. Auf einer anderen Ubuntu-Version kann g++-11 eine andere
Compilerversion installieren. Unter Ubuntu 22.04 lassen sich die Voraussetzungen so installieren:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends -y g++-11 make python3 xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1
```

## Abhängigkeiten installieren und bauen

Im Stammverzeichnis des Repositorys ausführen:

```sh
npm ci
npm run build
```

Die Lockdatei legt die Auflösung der Abhängigkeiten fest. Der Build leitet die Reihenfolge der Workspaces
aus ihren Manifesten ab, prüft deklarierte Abhängigkeiten und TypeScript-Ein- und Ausgaben, bereinigt die
deklarierten Ausgabeverzeichnisse und kontrolliert die erzeugten Einstiegspunkte.

## Desktop aus dem Quellcode starten

Nach dem Build SQLite für die festgelegte Electron-Version vorbereiten und den Desktop starten:

```sh
npm exec -- electron-rebuild -v 42.7.0 -m packages/core -o better-sqlite3
npm run start --workspace @oaam/client-desktop
```

Der Rebuild stellt das lokale native SQLite-Modul auf die ABI von Electron um. Der Desktop legt seine
OAAM-Bibliothek normalerweise im Anwendungsdatenverzeichnis des aktuellen OS-Benutzers an. Für die
Entwicklung lässt sich ein eigenes Profil auswählen:

```sh
npm run start --workspace @oaam/client-desktop -- --user-data-dir=/absolute/path/to/your/oaam-dev-profile
```

Verwende ein Verzeichnis, das dir gehört und für diese Vorschau reserviert ist. Schließe den Desktop,
bevor du seine Abhängigkeiten änderst.

## Prüfungen ausführen

Wenn SQLite für Electron vorbereitet wurde, vor den Tests die Node-Version wiederherstellen:

```sh
npm rebuild better-sqlite3
npm run verify
```

Direkt nach einem frischen npm ci kann npm run verify ohne Rebuild starten. Es baut den Quellcode,
prüft Formatierung und Typen, führt Architektur- und Asset-Konformitätstests aus, kontrolliert die tatsächliche
Desktop-Darstellung und prüft die Testabdeckung aller Workspaces. Die Tests verwenden synthetische Beispiele.
Sie benötigen keine privaten Dokumente, gespeicherten Nachweise vom Entwicklungsrechner, Zugangsdaten oder
installierten Coding-Tools. Ihr Erfolg belegt nicht, dass ein bestimmtes externes Tool die Dateien tatsächlich lädt.

## Plattformen und Paketierung

CI führt Quellcode-Builds, Architekturtests und ausgewählte Pfadtests auf Windows x64 und macOS 26 ARM64 aus.
Auf macOS belegen diese Prüfungen bisher nur den Quellcode-Stand. Die sicheren Dateisystemoperationen zum
Lesen, Schreiben und Wiederherstellen von Assets sind noch nicht an Darwin angepasst; vollständige
Asset-Abläufe werden dort daher noch nicht unterstützt. Desktop-Paketierung und UI-Tests stehen ebenfalls aus.

Veröffentlichte Desktop-Pakete gibt es für Windows x64 und Linux x64. Linux ist unter Ubuntu WSL/WSLg
geprüft. Die Windows-App kann auch Assets in einer ausdrücklich ausgewählten WSL-Distribution verwalten. Download
und Start beschreibt die [Bedienungsanleitung](USAGE.de.md). Die obigen Befehle bauen die Workspaces;
die folgenden Distributionsbefehle erstellen das vollständige Archiv samt nativen Ressourcen und dem
passenden WSL-Dienst für Windows. Kompilierung allein belegt keinen installierten Ablauf auf anderen Plattformen.

Native Windows-Entwicklung benötigt die C++-Buildtools von Visual Studio und Python. Ein gemeinsamer
Distributions-Builder ist enthalten. Nach npm ci und npm run build erzeugt ein sauberer Checkout die Ausgabe in neuen absoluten Verzeichnissen:

```sh
npm run package:desktop -- --output /absolute/new/oaam-linux
npm run package:wsl-resource -- --output /absolute/new/oaam-wsl-resource
```

Der erste Befehl erzeugt den vollständigen Linux Desktop, der zweite nur den unterstützenden Linux-Dienst für Windows.
Kopieren Sie dessen Archiv und Manifest nach Windows; beide Rechner müssen denselben Quellcode-Commit verwenden.
Nach npm ci und npm run build unter Windows führen Sie PowerShell aus:

```powershell
$archive = 'C:\oaam-build\OAAM-0.1.0-beta.2-restricted-wsl-support-linux-x64.tar.gz'
$nodeExecutable = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$npmCli = Join-Path (Split-Path -Parent $nodeExecutable) 'node_modules/npm/bin/npm-cli.js'
if (!(Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'Node installation is missing npm-cli.js' }
& $nodeExecutable $npmCli run package:desktop -- --output C:\oaam-build\desktop-windows --wsl-archive $archive --wsl-manifest "$archive.manifest.json"
```

Das Verzeichnis artifacts enthält ein versioniertes ZIP oder tar.gz samt SHA-256 und vollständiger Dateiliste.
Der Builder entpackt und prüft das echte Archiv; Linux-Ausführungsrechte bleiben erhalten. build-info.json neben
der ausführbaren Datei nennt Produktversion, Kanal, Komponente, Quellcode-Commit, Buildnummer und UTC-Zeit sowie Werkzeuge.
--build-number und --build-time setzen diese Eingaben; lokal gelten sonst local und die aktuelle UTC-Zeit.
Das Rezept mit Lockfile unter tests/repository/package-assembly fixiert externe Abhängigkeiten unabhängig von den frisch
gebauten internen Tarballs. Windows prüft auch den WSL-Dienst desselben Commits und die tatsächlichen PE-Metadaten.

Die Produktversion gehört der package.json im Repository-Wurzelverzeichnis. Reguläre Versionen verwenden dauerhaft OAAM,
beta-Versionen OAAM Preview; dev.N benötigt ein absolutes --user-data-dir. Explizite Profile gelten für alle Kanäle.
Pushes auf das öffentliche main erzeugen befristete Actions-Testartefakte, deren Download eine GitHub-Anmeldung verlangt.
Ein exakt passender v&lt;version&gt;-Tag erzeugt nach erfolgreichen Prüfungen und beiden Paketen einen Release-Entwurf;
beta wird als Vorabversion markiert. Erst nach Prüfung und Veröffentlichung bietet das Release öffentliche Downloads.
Paketierung allein belegt keinen installierten Ablauf. Linux wird in Ubuntu WSL/WSLg geprüft; die Windows-App greift über ihren mitgelieferten Dienst auf ausdrücklich ausgewählte WSL-Distributionen zu. Der unterstützende WSL-Dienst ist weder Linux Desktop noch eigenständiges Headless.

Headless ist ein technischer Einstieg in das Client/Host-Protokoll. Es benötigt explizite Einstellungen für
Daten, Datenbank, Plattform und Zugriffsverzeichnisse und ersetzt keinen interaktiven Desktop.
Die automatisierten Tests zeigen eine isolierte Konfiguration.

## Änderungen vornehmen

Produktcode und Tests werden in TypeScript geschrieben. Aussagekräftige Fehlerfälle, veraltete Freigaben
und vollständige Dateistrukturen müssen erhalten bleiben. Für begrenzte Änderungen genügen die betroffenen
Tests; Änderungen an gemeinsamem Build, Protokoll, Freigaben oder Persistenz benötigen die gesamte öffentliche Prüfung.

Die [technische Einführung](ARCHITECTURE.de.md) erklärt den Entwurf, die [Nutzungsanleitung](USAGE.de.md) die Bedienung.
