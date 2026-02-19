import * as vscode from "vscode";
import { exec } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { DartAnalysisResult, DeadCodeItem, UnusedMethod } from "./types";
import { DeadCodeTreeItem } from "./DeadCodeTreeItem";

// -----------------------------------------------------------------------
// TreeDataProvider
// -----------------------------------------------------------------------

export class DeadCodeProvider
  implements vscode.TreeDataProvider<DeadCodeTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    DeadCodeTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Last analysis result parsed from the Dart CLI */
  private _result: DartAnalysisResult = {
    unused_classes: [],
    unused_methods: [],
    unused_assets: [],
  };

  /** The provider needs the running extension's context (for asAbsolutePath) */
  constructor(private readonly context: vscode.ExtensionContext) {}

  // ---- Public API -------------------------------------------------------

  /**
   * Runs the Dart CLI tool, parses the result, and updates the view.
   * Called by the `deadCodeView.refresh` command in extension.ts.
   */
  async refresh(): Promise<void> {
    // 1. Check for an open workspace
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showWarningMessage(
        "Reduce App Size Flutter: A project folder must be open for analysis."
      );
      return;
    }
    const projectPath = folders[0].uri.fsPath;

    // 2. The CLI is kept inside the extension so it is accessible in the Marketplace package
    const cliRoot = path.resolve(this.context.extensionPath, "dart_cli");
    const scriptPath = path.resolve(cliRoot, "bin", "main.dart");
    if (!fs.existsSync(scriptPath)) {
      vscode.window.showErrorMessage(
        "Reduce App Size Flutter: Internal analysis tool not found. Please verify the extension package."
      );
      return;
    }

    // 3. Run the Dart CLI; show progress to the user
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "Analyzing Reduce App Size Flutter…",
        cancellable: false,
      },
      () =>
        new Promise<void>((resolve) => {
          const cmd = `dart run "${scriptPath}" "${projectPath}"`;

          exec(cmd, { cwd: cliRoot }, (error, stdout, stderr) => {
            if (error) {
              // Show stderr if the Dart process returned an error
              const msg = stderr?.trim() || error.message;
              vscode.window.showErrorMessage(
                `Reduce App Size Flutter error: ${msg}`
              );
              resolve();
              return;
            }

            if (stderr?.trim()) {
              // Non-fatal warnings (lint, etc.)
              console.warn("[Reduce App Size Flutter] stderr:", stderr);
            }

            // 4. Parse stdout
            // `dart run` sometimes writes build messages before the JSON;
            // we slice from the first '{' to the last '}' to extract only the JSON block.
            try {
              const jsonStart = stdout.indexOf("{");
              const jsonEnd = stdout.lastIndexOf("}");
              if (jsonStart === -1 || jsonEnd === -1) {
                throw new Error(`JSON block not found. stdout:\n${stdout.slice(0, 300)}`);
              }
              const raw = stdout.slice(jsonStart, jsonEnd + 1);
              const parsed = JSON.parse(raw) as Partial<DartAnalysisResult>;
              // Normalize missing/null fields to empty arrays
              this._result = {
                unused_classes: Array.isArray(parsed.unused_classes) ? parsed.unused_classes : [],
                unused_methods: Array.isArray(parsed.unused_methods) ? parsed.unused_methods : [],
                unused_assets:  Array.isArray(parsed.unused_assets)  ? parsed.unused_assets  : [],
              };
            } catch (parseErr) {
              vscode.window.showErrorMessage(
                "Reduce App Size Flutter: Dart CLI output could not be parsed as JSON.\n" +
                  String(parseErr)
              );
              this._result = { unused_classes: [], unused_methods: [], unused_assets: [] };
            }

            // 5. Refresh the view
            this._onDidChangeTreeData.fire();
            resolve();
          });
        })
    );
  }

  // ---- TreeDataProvider interface ----------------------------------------

  getTreeItem(element: DeadCodeTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DeadCodeTreeItem): DeadCodeTreeItem[] {
    if (!element) {
      // Root level: three fixed groups
      const classCount  = this._result.unused_classes?.length  ?? 0;
      const methodCount = this._result.unused_methods?.length  ?? 0;
      const assetCount  = this._result.unused_assets?.length   ?? 0;

      const groups: DeadCodeItem[] = [
        {
          label: "Unused Classes",
          kind: "group",
          description: `${classCount} item`,
        },
        {
          label: "Unused Methods",
          kind: "group",
          description: `${methodCount} item`,
        },
        {
          label: "Unused Assets",
          kind: "group",
          description: `${assetCount} item`,
        },
      ];

      return groups.map(
        (g) =>
          new DeadCodeTreeItem(g, vscode.TreeItemCollapsibleState.Expanded)
      );
    }

    // Child items: return actual data based on which group was clicked
    if (element.data.label === "Unused Classes") {
      return (this._result.unused_classes ?? []).map((cls) => {
        const item: DeadCodeItem = {
          label: cls.name,
          kind: "class",
          description: `${cls.file}:${cls.line}`,
          tooltip: `${cls.name}\n${cls.file} — line ${cls.line}`,
          file: cls.file,
          line: cls.line,
        };
        return new DeadCodeTreeItem(item, vscode.TreeItemCollapsibleState.None);
      });
    }

    if (element.data.label === "Unused Methods") {
      return (this._result.unused_methods ?? []).map((method: UnusedMethod) => {
        const item: DeadCodeItem = {
          label: method.name,
          kind: "method",
          description: `${method.file}:${method.line}`,
          tooltip: `${method.name}\n${method.file} — line ${method.line}`,
          file: method.file,
          line: method.line,
        };
        return new DeadCodeTreeItem(item, vscode.TreeItemCollapsibleState.None);
      });
    }

    if (element.data.label === "Unused Assets") {
      return (this._result.unused_assets ?? []).map((asset) => {
        const item: DeadCodeItem = {
          label: asset.path.split("/").pop() ?? asset.path,
          kind: "asset",
          description: asset.path,
          tooltip: asset.path,
          file: asset.path, // direct path for assets
          line: 1,          // assets have no line concept, so navigate to the beginning
        };
        return new DeadCodeTreeItem(item, vscode.TreeItemCollapsibleState.None);
      });
    }

    return [];
  }
}
