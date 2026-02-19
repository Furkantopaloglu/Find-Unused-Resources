/// Public API of the reduce_app_size_flutter_cli package.
library reduce_app_size_flutter_cli;

export 'src/analyzers/unused_asset_analyzer.dart';
export 'src/app_analyzer.dart';
export 'src/models/class_info.dart';
export 'src/models/method_info.dart';
export 'src/utils/file_utils.dart';
export 'src/utils/identifier_utils.dart';
export 'src/visitors/class_collector.dart';
export 'src/visitors/method_collector.dart';
export 'src/visitors/string_literal_collector.dart';
