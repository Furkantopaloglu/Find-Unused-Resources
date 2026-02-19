import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/token.dart';

final RegExp identifierPattern = RegExp(r'^[A-Za-z_]\w*$');

/// Walks every token in [unit] and returns the lexemes that look like
/// identifiers (matches [identifierPattern]).
List<String> collectIdentifierLexemes(CompilationUnit unit) {
  final names = <String>[];
  Token? token = unit.beginToken;
  while (token != null && !token.isEof) {
    final lexeme = token.lexeme;
    if (identifierPattern.hasMatch(lexeme)) {
      names.add(lexeme);
    }
    token = token.next;
  }
  return names;
}
