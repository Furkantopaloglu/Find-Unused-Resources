import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';

/// Collects every import / export / part URI from a compilation unit.
class ImportCollector extends RecursiveAstVisitor<void> {
  final List<String> uris = [];

  @override
  void visitImportDirective(ImportDirective node) {
    final uri = node.uri.stringValue;
    if (uri != null) uris.add(uri);
    super.visitImportDirective(node);
  }

  @override
  void visitExportDirective(ExportDirective node) {
    final uri = node.uri.stringValue;
    if (uri != null) uris.add(uri);
    super.visitExportDirective(node);
  }
}
