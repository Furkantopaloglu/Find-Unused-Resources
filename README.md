# Flutter Find Unused Resources

A Visual Studio Code extension that helps Flutter developers reduce app size and clean up their codebase by detecting unused code, packages, and assets — and providing a detailed breakdown of compiled binary size.

---

## Features

### Dead Code & Resource Analysis

Open the **Flutter Unused Resources** panel in the Activity Bar and run a full analysis of your Flutter project in one click.

| Category | What it finds |
|---|---|
| **Unused Classes** | Dart classes declared but never instantiated or referenced anywhere in the project |
| **Unused Methods** | Functions and methods defined but never called from any part of the codebase |
| **Unused Packages** | Dependencies listed in `pubspec.yaml` that are never imported in any Dart source file |
| **Unused Assets** | Images, fonts, and data files registered under `flutter.assets` in `pubspec.yaml` but not referenced in code |

Results are displayed in a navigable tree view. Clicking a class, method, or asset entry jumps directly to the relevant file and line.

### APK / IPA Size Breakdown

Load a compiled `.apk` or `.ipa` file to get a visual dashboard showing:

- **Total binary size** with a per-category summary
- **Donut chart** breaking down Dart AOT snapshot, Flutter engine, native libraries, assets, and other components
- **Top components list** sorted by size so you know exactly where to focus optimization efforts

---

## Requirements

- **VS Code** `1.85.0` or later
- **Dart SDK** installed and available on your `PATH` (the extension runs the bundled analysis tool via `dart run`)
- The opened workspace must be a **Flutter project** containing a `lib/` directory and `pubspec.yaml`

---

## Usage

### Running the analysis

1. Open your Flutter project folder in VS Code.
2. Click the **Flutter Unused Resources** icon in the Activity Bar (left sidebar).
3. Press **Start Analysis** in the welcome panel.
4. Wait a few seconds while the project is scanned.
5. Browse the results grouped by category — unused classes, methods, packages, and assets.
6. Click any item to navigate directly to the source location.
7. Use the **refresh** button in the panel title bar to clear results and start over.

### APK / IPA size breakdown

1. In the same sidebar panel, click **Load APK File** or **Load IPA File**.
2. Select a compiled `.apk` (Android) or `.ipa` (iOS) file from your machine.
3. The **App Size Report** tab opens with an interactive chart and a ranked list of the largest components.

> **Tip:** Re-run the analysis after every major refactor. Even small removals can noticeably reduce your app's install size and improve user acquisition.

---

## How it works

The extension bundles a Dart CLI tool (`dart_cli/`) that is executed against your project when analysis is triggered.

1. **Dart source files** under `lib/` are parsed using the official [`analyzer`](https://pub.dev/packages/analyzer) package.
2. A **reference graph** is built by collecting all identifier usages across the entire codebase.
3. **Unused classes and methods** are identified by comparing declaration counts to usage counts — any symbol that appears only at its declaration site is flagged.
4. **Unused packages** are detected by cross-referencing `pubspec.yaml` dependencies against `import` statements in all Dart files.
5. **Unused assets** are detected by cross-referencing `pubspec.yaml` asset declarations against string literals in all Dart files. Font files and `.env` files are automatically excluded from this check since they are not referenced by path in code.
6. The CLI outputs a JSON report which the extension parses and renders as a tree view.

For APK/IPA analysis, the extension reads the archive directly (no Flutter build required) and maps file paths to known component labels (Dart AOT snapshot, Flutter engine, DEX shards, native plugins, etc.).

---

## Known Limitations

- The unused **class and method** detection is based on static identifier matching, not full semantic analysis. Symbols referenced only via reflection, `isolate`, or generated code may be incorrectly flagged.
- **Font assets** are always considered used because they are referenced by family name at runtime, not by file path. `.env` files are similarly excluded.
- The extension analyzes only the first workspace folder when multiple folders are open.

---

## Extension Commands

| Command | Description |
|---|---|
| `Flutter Find Unused Resources: Run Analysis` | Start a full project scan |
| `Flutter Find Unused Resources: Clear Results` | Reset the view back to the welcome screen |
| `Load APK File` | Open an APK file for size analysis |
| `Load IPA File` | Open an IPA file for size analysis |

---

## Release Notes

### 0.0.1

Initial release.
