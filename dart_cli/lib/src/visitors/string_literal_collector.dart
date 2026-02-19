import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';

/// Collects all simple string literal values from an AST, including segments
/// inside interpolated strings and adjacent string concatenations.
class StringLiteralCollector extends RecursiveAstVisitor<void> {
  final List<String> literals = [];

  @override
  void visitSimpleStringLiteral(SimpleStringLiteral node) {
    literals.add(node.value);
    super.visitSimpleStringLiteral(node);
  }

  @override
  void visitAdjacentStrings(AdjacentStrings node) {
    // Collect each part individually AND the concatenated whole.
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
    // e.g.  '$basePath/ic_survey_report'  →  '/ic_survey_report'
    // e.g.  'assets/${folder}/logo.png'   →  'assets/' and '/logo.png'
    // Also reconstruct all consecutive literal segments so that paths
    // which are split only at variable boundaries are still matchable.
    final buffer = StringBuffer();
    for (final element in node.elements) {
      if (element is InterpolationString) {
        literals.add(element.value);
        buffer.write(element.value);
      } else {
        // Variable boundary — flush whatever we have so far.
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
