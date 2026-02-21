import * as vscode from "vscode";
import { exec } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { DartAnalysisResult, DeadCodeItem, UnusedMethod, UnusedPackage } from "./types";
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
    unused_packages: [],
    unused_assets: [],
  };

  /** True once the first analysis has completed */
  private _hasAnalyzed = false;

  /** The provider needs the running extension's context (for asAbsolutePath) */
  constructor(private readonly context: vscode.ExtensionContext) {
    this._setState("idle");
  }

  /** Updates the VS Code context key that drives viewsWelcome content */
  private _setState(state: "idle" | "analyzing" | "done"): void {
    vscode.commands.executeCommand("setContext", "reduceAppSize.state", state);
  }

  // ---- Public API -------------------------------------------------------

  /**
   * Clears all analysis results and resets the view back to the initial idle
   * state — exactly as if the extension had just been opened.
   * Called by the `deadCodeView.reset` command (title-bar refresh button).
   */
  reset(): void {
    this._result = {
      unused_classes: [],
      unused_methods: [],
      unused_packages: [],
      unused_assets: [],
    };
    this._hasAnalyzed = false;
    this._setState("idle");
    this._onDidChangeTreeData.fire();
  }

  /**
   * Runs the Dart CLI tool, parses the result, and updates the view.
   * Called by the `deadCodeView.refresh` command (Start Analysis button).
   */
  async refresh(): Promise<void> {
    // 1. Check for an open workspace
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showWarningMessage(
        "Flutter Find Unused Resources: Please open a Flutter project folder first."
      );
      return;
    }
    const projectPath = folders[0].uri.fsPath;

    // 2. The CLI is kept inside the extension so it is accessible in the Marketplace package
    const cliRoot = path.resolve(this.context.extensionPath, "dart_cli");
    const scriptPath = path.resolve(cliRoot, "bin", "main.dart");
    if (!fs.existsSync(scriptPath)) {
      vscode.window.showErrorMessage(
        "Flutter Find Unused Resources: Internal analysis tool not found. Please verify the extension package."
      );
      return;
    }

    // 3. Switch to loading state — triggers viewsWelcome spinner
    this._setState("analyzing");
    this._onDidChangeTreeData.fire();

    // 4. Run the Dart CLI; show a visible progress notification
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Flutter Find Unused Resources",
        cancellable: false,
      },
      (progress) => {
        progress.report({ message: "Scanning your Flutter project…" });

        return new Promise<void>((resolve) => {
          const cmd = `dart run "${scriptPath}" "${projectPath}"`;

          exec(cmd, { cwd: cliRoot }, (error, stdout, stderr) => {
            if (error) {
              const msg = stderr?.trim() || error.message;
              vscode.window.showErrorMessage(
                `Flutter Find Unused Resources: Analysis failed.\n${msg}`
              );
              this._setState(this._hasAnalyzed ? "done" : "idle");
              this._onDidChangeTreeData.fire();
              resolve();
              return;
            }

            if (stderr?.trim()) {
              console.warn("[Flutter Find Unused Resources] stderr:", stderr);
            }

            // 5. Parse stdout
            // `dart run` sometimes prepends build messages; extract only the JSON block.
            try {
              const jsonStart = stdout.indexOf("{");
              const jsonEnd = stdout.lastIndexOf("}");
              if (jsonStart === -1 || jsonEnd === -1) {
                throw new Error(`JSON block not found. stdout:\n${stdout.slice(0, 300)}`);
              }
              const raw = stdout.slice(jsonStart, jsonEnd + 1);
              const parsed = JSON.parse(raw) as Partial<DartAnalysisResult>;
              this._result = {
                unused_classes:  Array.isArray(parsed.unused_classes)  ? parsed.unused_classes  : [],
                unused_methods:  Array.isArray(parsed.unused_methods)  ? parsed.unused_methods  : [],
                unused_packages: Array.isArray(parsed.unused_packages) ? parsed.unused_packages : [],
                unused_assets:   Array.isArray(parsed.unused_assets)   ? parsed.unused_assets   : [],
              };
            } catch (parseErr) {
              vscode.window.showErrorMessage(
                "Flutter Find Unused Resources: Could not parse analysis output.\n" + String(parseErr)
              );
              this._result = { unused_classes: [], unused_methods: [], unused_packages: [], unused_assets: [] };
              this._setState(this._hasAnalyzed ? "done" : "idle");
              this._onDidChangeTreeData.fire();
              resolve();
              return;
            }

            this._hasAnalyzed = true;
            this._setState("done");

            // 6. Refresh the view
            this._onDidChangeTreeData.fire();

            // 7. Show a friendly summary notification
            const classCount   = this._result.unused_classes.length;
            const methodCount  = this._result.unused_methods.length;
            const packageCount = this._result.unused_packages.length;
            const assetCount   = this._result.unused_assets.length;
            const total = classCount + methodCount + packageCount + assetCount;

            if (total === 0) {
              vscode.window.showInformationMessage(
                "Flutter Find Unused Resources: No unused code, packages or assets found. Your project looks clean! 🎉"
              );
            } else {
              const parts: string[] = [];
              if (classCount   > 0) { parts.push(`${classCount} unused class${classCount   > 1 ? "es" : ""}`); }
              if (methodCount  > 0) { parts.push(`${methodCount} unused method${methodCount  > 1 ? "s" : ""}`); }
              if (packageCount > 0) { parts.push(`${packageCount} unused package${packageCount > 1 ? "s" : ""}`); }
              if (assetCount   > 0) { parts.push(`${assetCount} unused asset${assetCount   > 1 ? "s" : ""}`); }
              vscode.window.showWarningMessage(
                `Flutter Find Unused Resources: Analysis complete — ${parts.join(", ")} found.`
              );
            }

            resolve();
          });
        });
      }
    );
  }

  // ---- TreeDataProvider interface ----------------------------------------

  getTreeItem(element: DeadCodeTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DeadCodeTreeItem): DeadCodeTreeItem[] {
    if (!element) {
      // When not yet analyzed (idle/analyzing), return nothing so viewsWelcome shows
      if (!this._hasAnalyzed) {
        return [];
      }

      // Root level: four fixed groups
      const classCount   = this._result.unused_classes?.length   ?? 0;
      const methodCount  = this._result.unused_methods?.length   ?? 0;
      const packageCount = this._result.unused_packages?.length  ?? 0;
      const assetCount   = this._result.unused_assets?.length    ?? 0;

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
          label: "Unused Packages",
          kind: "group",
          description: `${packageCount} item`,
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

    if (element.data.label === "Unused Packages") {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      return (this._result.unused_packages ?? []).map((pkg: UnusedPackage) => {
        const item: DeadCodeItem = {
          label: pkg.name,
          kind: "package",
          description: "pubspec.yaml",
          tooltip: `${pkg.name} — declared in pubspec.yaml but never imported\nClick to open pubspec.yaml`,
          file: path.join(workspaceRoot, "pubspec.yaml"),
          line: pkg.line ?? 1,
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
