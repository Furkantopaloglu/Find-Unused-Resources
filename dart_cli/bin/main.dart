import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:reduce_app_size_flutter_cli/reduce_app_size_flutter_cli.dart';

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
  final libDir = Directory(p.join(rootPath, 'lib'));

  if (!await libDir.exists()) {
    stderr.writeln('lib/ directory not found in: $rootPath');
    stderr.writeln('Make sure the target directory is a Flutter/Dart project.');
    stdout.writeln(
      '{"unused_classes":[],"unused_methods":[],"unused_assets":[]}',
    );
    return;
  }

  final result = await analyzeProject(rootPath);
  stdout.writeln(jsonEncode(result));
}
