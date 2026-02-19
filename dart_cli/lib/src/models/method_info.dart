class MethodInfo {
  const MethodInfo({
    required this.name,
    required this.filePath,
    required this.line,
  });

  final String name;
  final String filePath;
  final int line;
}
