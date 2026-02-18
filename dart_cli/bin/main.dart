import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/token.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/source/line_info.dart';
import 'package:path/path.dart' as p;

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
    'unused_assets': <Map<String, Object>>[],
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
