import * as vscode from "vscode";
import { DeadCodeItem } from "./types";

export class DeadCodeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly data: DeadCodeItem,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(data.label, collapsibleState);

    this.tooltip = data.tooltip ?? data.label;
    this.description = data.description;
    this.contextValue = data.kind;

    // Open file on click for code/asset items
    if ((data.kind === "class" || data.kind === "method" || data.kind === "asset") && data.file) {
      this.command = {
        command: "deadCode.openFile",
        title: "Open File",
        arguments: [data.file, data.line ?? 0],
      };
    }

    switch (data.kind) {
      case "group":
        this.iconPath = new vscode.ThemeIcon("folder");
        break;
      case "class":
        this.iconPath = new vscode.ThemeIcon(
          "symbol-class",
          new vscode.ThemeColor("symbolIcon.classForeground")
        );
        break;
      case "method":
        this.iconPath = new vscode.ThemeIcon(
          "symbol-method",
          new vscode.ThemeColor("symbolIcon.methodForeground")
        );
        break;
      case "asset":
        this.iconPath = new vscode.ThemeIcon(
          "file-media",
          new vscode.ThemeColor("symbolIcon.fileForeground")
        );
        break;
    }
  }
}
