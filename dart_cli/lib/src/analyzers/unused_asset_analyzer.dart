import 'dart:io';

import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:path/path.dart' as p;
import 'package:yaml/yaml.dart';

import '../visitors/string_literal_collector.dart';

/// Returns a list of assets declared in `pubspec.yaml` that are not referenced
/// in any of the provided [dartFiles].
Future<List<Map<String, Object>>> findUnusedAssets(
  String rootPath,
  List<String> dartFiles,
) async {
  // 1. Read and parse pubspec.yaml
  final pubspecFile = File(p.join(rootPath, 'pubspec.yaml'));
  if (!pubspecFile.existsSync()) return [];

  YamlMap pubspec;
  try {
    final content = await pubspecFile.readAsString();
    pubspec = loadYaml(content) as YamlMap;
  } catch (_) {
    return [];
  }

  // 2. Collect declared asset paths from flutter.assets
  final flutterSection = pubspec['flutter'];
  if (flutterSection == null || flutterSection is! YamlMap) return [];

  final assetsNode = flutterSection['assets'];
  if (assetsNode == null || assetsNode is! YamlList) return [];

  // 3. Expand each entry to concrete file paths
  final declaredAssets = <String>[];
  for (final entry in assetsNode) {
    final assetEntry = entry.toString();
    final absoluteEntry = p.join(rootPath, assetEntry);

    if (assetEntry.endsWith('/')) {
      // Directory entry — add all files inside it (non-recursive by convention)
      final dir = Directory(absoluteEntry);
      if (dir.existsSync()) {
        await for (final entity in dir.list(recursive: false)) {
          if (entity is File) {
            declaredAssets.add(
              p.relative(entity.path, from: rootPath).replaceAll('\\', '/'),
            );
          }
        }
      }
    } else {
      // Specific file entry
      if (File(absoluteEntry).existsSync()) {
        declaredAssets.add(assetEntry.replaceAll('\\', '/'));
      }
    }
  }

  if (declaredAssets.isEmpty) return [];

  // 4. Collect all string literals from the Dart source files
  final allStringLiterals = <String>{};
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

    final collector = StringLiteralCollector();
    parseResult.unit.accept(collector);
    allStringLiterals.addAll(collector.literals);
  }

  // 5. An asset is "unused" when no string fragment contains its path,
  //    full filename, or filename-without-extension.
  final unusedAssets = <Map<String, Object>>[];
  for (final assetPath in declaredAssets) {
    final basename = p.basename(assetPath);
    final stem = p.basenameWithoutExtension(assetPath);
    final isReferenced = allStringLiterals.any(
      (lit) =>
          lit.contains(assetPath) ||
          lit.contains(basename) ||
          (stem.length > 3 && lit.contains(stem)),
    );
    if (!isReferenced) {
      unusedAssets.add({'path': assetPath});
    }
  }

  return unusedAssets;
}
