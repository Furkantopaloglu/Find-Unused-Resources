import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/source/line_info.dart';

import '../models/method_info.dart';

/// Collects method and top-level function declarations, skipping well-known
/// Flutter framework callbacks that are invoked by the framework at runtime.
class MethodCollector extends RecursiveAstVisitor<void> {
  MethodCollector(this.filePath, this.lineInfo);

  final String filePath;
  final LineInfo lineInfo;
  final List<MethodInfo> methods = [];

  // These are called by the Flutter/Dart runtime — exclude from "unused" checks.
  static const _excluded = {
    'build',
    'createState',
    'initState',
    'dispose',
    'deactivate',
    'reassemble',
    'didChangeDependencies',
    'didUpdateWidget',
    'debugFillProperties',
    'toString',
    'hashCode',
    'noSuchMethod',
    'main',
  };

  @override
  void visitMethodDeclaration(MethodDeclaration node) {
    final name = node.name.lexeme;
    if (!_excluded.contains(name)) {
      final line = lineInfo.getLocation(node.name.offset).lineNumber;
      methods.add(MethodInfo(name: name, filePath: filePath, line: line));
    }
    super.visitMethodDeclaration(node);
  }

  @override
  void visitFunctionDeclaration(FunctionDeclaration node) {
    final name = node.name.lexeme;
    if (!_excluded.contains(name)) {
      final line = lineInfo.getLocation(node.name.offset).lineNumber;
      methods.add(MethodInfo(name: name, filePath: filePath, line: line));
    }
    super.visitFunctionDeclaration(node);
  }
}
