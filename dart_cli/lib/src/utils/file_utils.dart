import 'dart:io';

import 'package:path/path.dart' as p;

/// Recursively collects all `.dart` files under [dirPath], sorted by path.
Future<List<String>> collectDartFiles(String dirPath) async {
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
