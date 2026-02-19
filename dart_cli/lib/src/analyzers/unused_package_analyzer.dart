import 'dart:io';

import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:path/path.dart' as p;
import 'package:yaml/yaml.dart';

import '../visitors/import_collector.dart';

/// Returns a list of packages declared in `pubspec.yaml` (under *dependencies*
/// and *dev_dependencies*) that are never imported in any Dart source file
/// under `lib/`.
///
/// Packages that are part of the Dart or Flutter SDK itself (sdk: flutter /
/// sdk: dart) are skipped since they are not regular pub packages.
Future<List<Map<String, Object>>> findUnusedPackages(
  String rootPath,
  List<String> dartFiles,
) async {
  // 1. Parse pubspec.yaml
  final pubspecFile = File(p.join(rootPath, 'pubspec.yaml'));
  if (!pubspecFile.existsSync()) return [];

  YamlMap pubspec;
  String pubspecContent;
  try {
    pubspecContent = await pubspecFile.readAsString();
    pubspec = loadYaml(pubspecContent) as YamlMap;
  } catch (_) {
    return [];
  }

  // Pre-build a lookup: package name → 1-based line number in pubspec.yaml
  // We look for lines whose leading non-space content is "<name>:".
  final lineNumberByPackage = <String, int>{};
  final pubspecLines = pubspecContent.split('\n');
  for (var i = 0; i < pubspecLines.length; i++) {
    final trimmed = pubspecLines[i].trimLeft();
    final colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      final key = trimmed.substring(0, colonIdx).trim();
      if (!lineNumberByPackage.containsKey(key)) {
        lineNumberByPackage[key] = i + 1; // 1-based
      }
    }
  }

  // 2. Collect package names from dependencies + dev_dependencies
  final packageNames = <String>{};
  for (final section in ['dependencies', 'dev_dependencies']) {
    final node = pubspec[section];
    if (node == null || node is! YamlMap) continue;
    for (final key in node.keys) {
      final name = key.toString();
      final value = node[key];
      // Skip SDK pseudo-packages: `flutter: sdk: flutter` / `dart: sdk: dart`
      if (value is YamlMap && value['sdk'] != null) continue;
      packageNames.add(name);
    }
  }

  if (packageNames.isEmpty) return [];

  // 3. Collect all import/export URIs from the Dart source files
  final importedPackages = <String>{};
  for (final filePath in dartFiles) {
    String content;
    try {
      content = await File(filePath).readAsString();
    } catch (_) {
      continue;
    }

    final parseResult = parseString(
      content: content,
      path: filePath,
      throwIfDiagnostics: false,
    );

    final collector = ImportCollector();
    parseResult.unit.accept(collector);

    for (final uri in collector.uris) {
      // 'package:some_package/...' — extract the package name
      if (uri.startsWith('package:')) {
        final rest = uri.substring('package:'.length);
        final slash = rest.indexOf('/');
        final name = slash == -1 ? rest : rest.substring(0, slash);
        importedPackages.add(name);
      }
    }
  }

  // 4. A package is "unused" when it never appears in any import/export URI
  final unusedPackages = <Map<String, Object>>[];
  for (final name in packageNames) {
    if (!importedPackages.contains(name)) {
      unusedPackages.add({
        'name': name,
        'line': lineNumberByPackage[name] ?? 1,
      });
    }
  }

  // Sort alphabetically for a stable output
  unusedPackages.sort(
    (a, b) => (a['name'] as String).compareTo(b['name'] as String),
  );

  return unusedPackages;
}
