import * as vscode from "vscode";
import * as path from "path";
import { DeadCodeProvider } from "./DeadCodeProvider";

export function activate(context: vscode.ExtensionContext): void {
  // Pass context to the provider (required for asAbsolutePath)
  const provider = new DeadCodeProvider(context);

  // Register to the view
  const treeView = vscode.window.createTreeView("deadCodeView", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // Refresh command — matches the button in package.json
  const refreshCommand = vscode.commands.registerCommand(
    "deadCodeView.refresh",
    () => provider.refresh()
  );

  // Open file command — triggered when a tree item is clicked
  const openFileCommand = vscode.commands.registerCommand(
    "deadCode.openFile",
    async (filePath: string, line: number) => {
      try {
        // Dart CLI may return a relative path (e.g. "lib/foo.dart")
        // If not absolute, join with the workspace root directory
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        const absolutePath = path.isAbsolute(filePath)
          ? filePath
          : path.join(workspaceRoot, filePath);

        const uri = vscode.Uri.file(absolutePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);

        // If a valid line is provided, navigate to it and center
        if (line && line > 0) {
          const zeroLine = line - 1; // VS Code is 0-based
          const range = new vscode.Range(zeroLine, 0, zeroLine, 0);
          editor.selection = new vscode.Selection(range.start, range.end);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Reduce App Size Flutter: Could not open file: ${filePath}\n${String(err)}`
        );
      }
    }
  );

  context.subscriptions.push(treeView, refreshCommand, openFileCommand);

  console.log("Reduce App Size Flutter extension active.");
}

export function deactivate(): void {}
