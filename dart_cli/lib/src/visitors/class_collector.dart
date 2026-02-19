import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/source/line_info.dart';

import '../models/class_info.dart';

class ClassCollector extends RecursiveAstVisitor<void> {
  ClassCollector(this.filePath, this.lineInfo);

  final String filePath;
  final LineInfo lineInfo;
  final List<ClassInfo> classes = [];

  @override
  void visitClassDeclaration(ClassDeclaration node) {
    final line = lineInfo.getLocation(node.name.offset).lineNumber;
    classes.add(
      ClassInfo(name: node.name.lexeme, filePath: filePath, line: line),
    );
    super.visitClassDeclaration(node);
  }
}
