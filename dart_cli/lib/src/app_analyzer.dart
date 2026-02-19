import 'dart:io';

import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:path/path.dart' as p;

import 'analyzers/unused_asset_analyzer.dart';
import 'analyzers/unused_package_analyzer.dart';
import 'models/class_info.dart';
import 'models/method_info.dart';
import 'utils/file_utils.dart';
import 'utils/identifier_utils.dart';
import 'visitors/class_collector.dart';
import 'visitors/method_collector.dart';

/// Runs all analyses on a Flutter/Dart project located at [rootPath] and
/// returns a map suitable for JSON serialisation:
/// ```json
/// {
///   "unused_classes": [...],
///   "unused_methods":  [...],
///   "unused_assets":   [...],
/// }
/// ```
Future<Map<String, Object>> analyzeProject(String rootPath) async {
  final libDir = Directory(p.join(rootPath, 'lib'));
  if (!libDir.existsSync()) {
    return {
      'unused_classes': <Object>[],
      'unused_methods': <Object>[],
      'unused_packages': <Object>[],
      'unused_assets': <Object>[],
    };
  }

  final dartFiles = await collectDartFiles(libDir.path);

  final classInfos = <ClassInfo>[];
  final methodInfos = <MethodInfo>[];
  final declarationCountByName = <String, int>{};
  final methodDeclarationCountByName = <String, int>{};
  final identifierCountByName = <String, int>{};

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

    // --- classes ---
    final classCollector = ClassCollector(filePath, parseResult.lineInfo);
    parseResult.unit.accept(classCollector);
    for (final info in classCollector.classes) {
      classInfos.add(info);
      declarationCountByName[info.name] =
          (declarationCountByName[info.name] ?? 0) + 1;
    }

    // --- methods ---
    final methodCollector = MethodCollector(filePath, parseResult.lineInfo);
    parseResult.unit.accept(methodCollector);
    for (final info in methodCollector.methods) {
      methodInfos.add(info);
      methodDeclarationCountByName[info.name] =
          (methodDeclarationCountByName[info.name] ?? 0) + 1;
    }

    // --- identifiers ---
    for (final name in collectIdentifierLexemes(parseResult.unit)) {
      identifierCountByName[name] = (identifierCountByName[name] ?? 0) + 1;
    }
  }

  // ---- Unused classes ----
  final unusedClasses = <Map<String, Object>>[];
  for (final info in classInfos) {
    final total = identifierCountByName[info.name] ?? 0;
    final decls = declarationCountByName[info.name] ?? 0;
    if (total <= decls) {
      unusedClasses.add({
        'name': info.name,
        'file': p.relative(info.filePath, from: rootPath).replaceAll('\\', '/'),
        'line': info.line,
      });
    }
  }

  // ---- Unused methods ----
  final unusedMethods = <Map<String, Object>>[];
  for (final info in methodInfos) {
    final total = identifierCountByName[info.name] ?? 0;
    final decls = methodDeclarationCountByName[info.name] ?? 0;
    if (total <= decls) {
      unusedMethods.add({
        'name': info.name,
        'file': p.relative(info.filePath, from: rootPath).replaceAll('\\', '/'),
        'line': info.line,
      });
    }
  }

  return {
    'unused_classes': unusedClasses,
    'unused_methods': unusedMethods,
    'unused_packages': await findUnusedPackages(rootPath, dartFiles),
    'unused_assets': await findUnusedAssets(rootPath, dartFiles),
  };
}
