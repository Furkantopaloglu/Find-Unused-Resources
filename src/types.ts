// -----------------------------------------------------------------------
// Interfaces matching the JSON structure returned by the Dart CLI
// -----------------------------------------------------------------------

export interface UnusedClass {
  name: string;
  file: string;
  line: number;
}

export interface UnusedAsset {
  path: string;
}

export interface DartAnalysisResult {
  unused_classes: UnusedClass[];
  unused_assets: UnusedAsset[];
}

// -----------------------------------------------------------------------
// Tree item types
// -----------------------------------------------------------------------

export type ItemKind = "group" | "class" | "asset";

export interface DeadCodeItem {
  label: string;
  kind: ItemKind;
  description?: string;
  tooltip?: string;
  /** Absolute path of the file to open (only for class/asset items) */
  file?: string;
  /** Line number to navigate to (1-based, only for class items) */
  line?: number;
}
