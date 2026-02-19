import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/token.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/source/line_info.dart';
import 'package:path/path.dart' as p;
import 'package:yaml/yaml.dart';

final RegExp _identifierPattern = RegExp(r'^[A-Za-z_]\w*$');

Future<void> main(List<String> args) async {
  if (args.isEmpty) {
    stderr.writeln('Usage: dart run bin/main.dart <folder_path>');
    exitCode = 64;
    return;
  }

  final rootInput = args.first;
  final rootDir = Directory(rootInput);

  if (!await rootDir.exists()) {
    stderr.writeln('Directory not found: $rootInput');
    exitCode = 66;
    return;
  }

  final rootPath = p.normalize(rootDir.absolute.path);

  // Only scan the lib/ folder — Flutter source code lives here
  final libDir = Directory(p.join(rootPath, 'lib'));
  if (!await libDir.exists()) {
    // If lib/ doesn't exist, the directory may not be a Flutter/Dart project
    stderr.writeln('lib/ directory not found in: $rootPath');
    stderr.writeln('Make sure the target directory is a Flutter/Dart project.');
    // Return empty result; do not exit with error — the UI side will display this
    stdout.writeln('{"unused_classes":[],"unused_assets":[]}');
    return;
  }
  final dartFiles = await _collectDartFiles(libDir.path);

  final classInfos = <_ClassInfo>[];
  final declarationCountByName = <String, int>{};
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

    final classCollector = _ClassCollector(filePath, parseResult.lineInfo);
    parseResult.unit.accept(classCollector);

    for (final classInfo in classCollector.classes) {
      classInfos.add(classInfo);
      declarationCountByName[classInfo.name] =
          (declarationCountByName[classInfo.name] ?? 0) + 1;
    }

    for (final name in _collectIdentifierLexemes(parseResult.unit)) {
      identifierCountByName[name] = (identifierCountByName[name] ?? 0) + 1;
    }
  }

  final unused = <Map<String, Object>>[];
  for (final classInfo in classInfos) {
    final totalIdentifierCount = identifierCountByName[classInfo.name] ?? 0;
    final declarationCount = declarationCountByName[classInfo.name] ?? 0;
    final isUnused = totalIdentifierCount <= declarationCount;

    if (isUnused) {
      final relativeFile = p.relative(classInfo.filePath, from: rootPath);
      unused.add({
        'name': classInfo.name,
        'file': relativeFile.replaceAll('\\\\', '/'),
        'line': classInfo.line,
      });
    }
  }

  final output = {
    'unused_classes': unused,
    'unused_assets': await _findUnusedAssets(rootPath, dartFiles),
  };
  stdout.writeln(jsonEncode(output));
}

Future<List<String>> _collectDartFiles(String dirPath) async {
  final files = <String>[];
  await for (final entity in Directory(
    dirPath,
  ).list(recursive: true, followLinks: false)) {
    if (entity is File && p.extension(entity.path) == '.dart') {
      files.add(p.normalize(entity.absolute.path));
    }
  }
  files.sort();
  return files;
}

// ---------------------------------------------------------------------------
// Unused asset detection
// ---------------------------------------------------------------------------

/// Returns a list of assets declared in pubspec.yaml but not referenced in any
/// Dart source file under lib/.
Future<List<Map<String, Object>>> _findUnusedAssets(
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
            // Store as project-relative POSIX path (matching pubspec convention)
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

    final collector = _StringLiteralCollector();
    parseResult.unit.accept(collector);
    allStringLiterals.addAll(collector.literals);
  }

  // 5. An asset is "unused" when no string fragment contains its path,
  //    full filename, or filename-without-extension.
  //    The last check catches interpolated paths like
  //    '$basePath/ic_survey_report' where only the stem appears as a literal.
  final unusedAssets = <Map<String, Object>>[];
  for (final assetPath in declaredAssets) {
    final basename = p.basename(assetPath); // e.g. ic_survey_report.svg
    final stem = p.basenameWithoutExtension(assetPath); // e.g. ic_survey_report
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

class _ClassInfo {
  _ClassInfo({required this.name, required this.filePath, required this.line});

  final String name;
  final String filePath;
  final int line;
}

class _ClassCollector extends RecursiveAstVisitor<void> {
  _ClassCollector(this.filePath, this.lineInfo);

  final String filePath;
  final LineInfo lineInfo;
  final List<_ClassInfo> classes = [];

  @override
  void visitClassDeclaration(ClassDeclaration node) {
    final line = lineInfo.getLocation(node.name.offset).lineNumber;
    classes.add(
      _ClassInfo(name: node.name.lexeme, filePath: filePath, line: line),
    );
    super.visitClassDeclaration(node);
  }
}

List<String> _collectIdentifierLexemes(CompilationUnit unit) {
  final names = <String>[];
  Token? token = unit.beginToken;
  while (token != null && !token.isEof) {
    final lexeme = token.lexeme;
    if (_identifierPattern.hasMatch(lexeme)) {
      names.add(lexeme);
    }
    token = token.next;
  }
  return names;
}

// ---------------------------------------------------------------------------
// Collects all simple string literal values from an AST
// ---------------------------------------------------------------------------

class _StringLiteralCollector extends RecursiveAstVisitor<void> {
  final List<String> literals = [];

  @override
  void visitSimpleStringLiteral(SimpleStringLiteral node) {
    literals.add(node.value);
    super.visitSimpleStringLiteral(node);
  }

  @override
  void visitAdjacentStrings(AdjacentStrings node) {
    // Collect each part individually AND the concatenated whole
    final buffer = StringBuffer();
    for (final str in node.strings) {
      if (str is SimpleStringLiteral) {
        literals.add(str.value);
        buffer.write(str.value);
      }
    }
    literals.add(buffer.toString());
    super.visitAdjacentStrings(node);
  }

  @override
  void visitStringInterpolation(StringInterpolation node) {
    // Collect each literal segment inside an interpolated string.
    // e.g.  '\$basePath/ic_survey_report'  →  '/ic_survey_report'
    // e.g.  'assets/\${folder}/logo.png'   →  'assets/' and '/logo.png'
    // Also reconstruct all consecutive literal segments so that paths
    // which are split only at variable boundaries are still matchable.
    final buffer = StringBuffer();
    for (final element in node.elements) {
      if (element is InterpolationString) {
        literals.add(element.value);
        buffer.write(element.value);
      } else {
        // Variable boundary — flush whatever we have so far
        if (buffer.isNotEmpty) {
          literals.add(buffer.toString());
          buffer.clear();
        }
      }
    }
    if (buffer.isNotEmpty) literals.add(buffer.toString());
    super.visitStringInterpolation(node);
  }
}
