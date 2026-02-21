import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import { DeadCodeProvider } from "./DeadCodeProvider";
import { ApkSizePanel, ApkReportData, ApkTopItem } from "./ApkSizePanel";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SizeNode {
  n?: string;        // Flutter analyze-size format uses 'n' for name
  name?: string;     // keep for compatibility with other formats
  value?: number;
  size?: number;
  children?: SizeNode[];
}

interface ApkSizeSummary {
  totalBytes: number;
  dartCodeBytes: number;
  assetsBytes: number;
  nativeBytes: number;
  otherBytes: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Recursively walk a directory and collect files matching a predicate. */
function walkDir(dir: string, predicate: (name: string) => boolean): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) { return results; }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, predicate));
    } else if (entry.isFile() && predicate(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/** Pick the most recently modified file from a list. */
function latestFile(files: string[]): string | undefined {
  if (files.length === 0) { return undefined; }
  return files.reduce((a, b) =>
    fs.statSync(a).mtimeMs >= fs.statSync(b).mtimeMs ? a : b
  );
}

/** Return the byte-value of a SizeNode (handles both 'size' and 'value' keys). */
function nodeBytes(n: SizeNode): number {
  return n.size ?? n.value ?? 0;
}

/** Get the display name of a node — Flutter uses 'n', some tools use 'name'. */
function nodeName(node: SizeNode): string {
  return (node.n ?? node.name ?? "").trim();
}

/** Find a direct child whose name contains the keyword (case-insensitive). */
function findChild(root: SizeNode, keyword: string): SizeNode | undefined {
  return root.children?.find(
    (c) => nodeName(c).toLowerCase().includes(keyword.toLowerCase())
  );
}

/** Recursively search the tree for the first node whose name contains keyword. */
function findDeep(root: SizeNode, keyword: string): SizeNode | undefined {
  if (nodeName(root).toLowerCase().includes(keyword.toLowerCase())) { return root; }
  for (const child of root.children ?? []) {
    const found = findDeep(child, keyword);
    if (found) { return found; }
  }
  return undefined;
}

/** Sum bytes of all direct children. */
function sumChildren(root: SizeNode): number {
  return (root.children ?? []).reduce((acc, c) => acc + nodeBytes(c), 0);
}

// ─── Known APK component labels ──────────────────────────────────────────────
// Maps a substring of the full node path to a friendly display name + category.
const KNOWN_COMPONENTS: Array<{
  match: RegExp;
  label: string;
  category: ApkTopItem["category"];
}> = [
  // Dart
  { match: /libapp\.so/i,            label: "Dart AOT Snapshot (libapp.so)",          category: "Dart"   },
  { match: /app\.aot/i,              label: "Dart AOT Snapshot (app.aot)",             category: "Dart"   },
  { match: /app\.dill/i,             label: "Dart Kernel Bytecode (app.dill)",          category: "Dart"   },
  // Flutter engine
  { match: /libflutter\.so/i,        label: "Flutter Engine (libflutter.so)",          category: "Native" },
  // Plugin native libs
  { match: /libplugin_(.+)\.so/i,    label: "Flutter Plugin Native Lib",              category: "Native" },
  // DEX shards
  { match: /classes(\d+)\.dex/i,     label: "Android DEX Bytecode",                   category: "Native" },
  { match: /classes\.dex/i,          label: "Android DEX Bytecode (main)",            category: "Native" },
  // Assets
  { match: /flutter_assets/i,        label: "Flutter Assets (images, fonts, data)",   category: "Assets" },
  { match: /assets\//i,              label: "App Assets",                             category: "Assets" },
  // Resources
  { match: /resources\.arsc/i,       label: "Android Resources Table (resources.arsc)", category: "Other" },
  { match: /AndroidManifest\.xml/i,  label: "Android Manifest",                       category: "Other" },
  { match: /^res\//i,                label: "Android XML / Drawable Resources",       category: "Other" },
  { match: /META-INF/i,              label: "APK Signing & Metadata (META-INF)",      category: "Other" },
];

function resolveComponent(
  rawName: string,
  fullPath: string
): { label: string; category: ApkTopItem["category"] } {
  for (const known of KNOWN_COMPONENTS) {
    if (known.match.test(fullPath) || known.match.test(rawName)) {
      // For DEX shards, append the shard index for clarity
      const dexMatch = rawName.match(/classes(\d+)\.dex/i);
      if (dexMatch) {
        return { label: `Android DEX Shard #${dexMatch[1]}`, category: "Native" };
      }
      // For plugin .so files, extract the plugin name
      const pluginMatch = rawName.match(/lib(.+?)\.so/i);
      if (pluginMatch && !/flutter|app/i.test(pluginMatch[1])) {
        return {
          label: `Native Plugin: ${pluginMatch[1].replace(/_/g, " ")}`,
          category: "Native",
        };
      }
      return { label: known.label, category: known.category };
    }
  }

  // Unknown .so file
  if (rawName.endsWith(".so")) {
    return { label: `Native Library: ${rawName}`, category: "Native" };
  }

  // Image/font assets
  if (/\.(png|jpg|jpeg|webp|gif|svg)$/i.test(rawName)) {
    return { label: `Image Asset: ${rawName}`, category: "Assets" };
  }
  if (/\.(ttf|otf|woff2?)$/i.test(rawName)) {
    return { label: `Font Asset: ${rawName}`, category: "Assets" };
  }

  return { label: rawName, category: "Other" };
}

/** Collect all nodes recursively, sorted by bytes descending, capped at N.
 *  Only leaf nodes (no children) are emitted to avoid double-counting.
 */
function collectTopItems(root: SizeNode, n: number): ApkTopItem[] {
  const all: ApkTopItem[] = [];

  function walk(node: SizeNode, pathSoFar: string): void {
    const nm       = nodeName(node);
    const fullPath = pathSoFar ? `${pathSoFar}/${nm}` : nm;
    const bytes    = nodeBytes(node);
    const isLeaf   = !node.children || node.children.length === 0;

    if (isLeaf && bytes > 0 && nm) {
      const { label, category } = resolveComponent(nm, fullPath);
      all.push({ name: label, sizeBytes: bytes, category });
    }
    for (const child of node.children ?? []) { walk(child, fullPath); }
  }

  for (const child of root.children ?? []) { walk(child, ""); }

  return all
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, n);
}

/** Derive a human-readable size string. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1_048_576) { return `${(bytes / 1_048_576).toFixed(2)} MB`; }
  if (bytes >= 1_024)     { return `${(bytes / 1_024).toFixed(1)} KB`; }
  return `${bytes} B`;
}

/** Parse the Flutter analyze-size JSON and extract key metrics.
 *
 * Standard Flutter APK JSON structure:
 *   root  ("app-arm64.apk" | "total")
 *   ├─ lib/
 *   │   └─ arm64-v8a/
 *   │       ├─ libapp.so      ← Dart AOT snapshot
 *   │       └─ libflutter.so  ← Flutter engine  (Native)
 *   ├─ assets/
 *   │   └─ flutter_assets/    ← images, fonts, etc.
 *   ├─ classes.dex             ← JVM bytecode    (Native)
 *   └─ res/, META-INF/, …     ← Other
 */
function parseSizeJson(jsonPath: string): ApkSizeSummary & { root: SizeNode } {
  const raw = fs.readFileSync(jsonPath, "utf-8");
  const root: SizeNode = JSON.parse(raw);

  // ── Diagnostic log ──────────────────────────────────────────────────────
  console.log("[APK Size Analysis] Root:", { n: root.n, name: root.name, value: root.value });
  console.log("[APK Size Analysis] Direct children:",
    JSON.stringify(
      (root.children ?? []).map(c => ({ n: c.n, name: c.name, value: c.value, kids: c.children?.length ?? 0 })),
      null, 2
    )
  );

  const totalBytes = nodeBytes(root) || sumChildren(root);

  // ── lib/ directory (.so files) ──────────────────────────────────────────
  const libNode   = findChild(root, "lib");
  const libBytes  = libNode ? (nodeBytes(libNode) || sumChildren(libNode)) : 0;

  // ── Dart AOT: libapp.so inside lib/ ────────────────────────────────────
  const dartNode      = libNode ? (findDeep(libNode, "libapp.so") ?? findDeep(libNode, "app.aot")) : undefined;
  const dartCodeBytes = dartNode ? nodeBytes(dartNode) : 0;

  // ── Native: rest of lib/ + classes.dex ─────────────────────────────────
  const dexNode     = findChild(root, "classes.dex") ?? findChild(root, "classes");
  const dexBytes    = dexNode ? (nodeBytes(dexNode) || sumChildren(dexNode)) : 0;
  const nativeBytes = Math.max(0, libBytes - dartCodeBytes) + dexBytes;

  // ── Assets: assets/ directory ───────────────────────────────────────────
  const assetsNode  = findChild(root, "assets") ?? findChild(root, "flutter_assets");
  const assetsBytes = assetsNode ? (nodeBytes(assetsNode) || sumChildren(assetsNode)) : 0;

  // ── Other ───────────────────────────────────────────────────────────────
  const otherBytes = Math.max(0, totalBytes - dartCodeBytes - nativeBytes - assetsBytes);

  console.log("[APK Size Analysis] lib/     :", fmtBytes(libBytes),   "| dart:", dartNode ? nodeName(dartNode) : "(not found)");
  console.log("[APK Size Analysis] dart     :", fmtBytes(dartCodeBytes));
  console.log("[APK Size Analysis] native   :", fmtBytes(nativeBytes));
  console.log("[APK Size Analysis] assets   :", fmtBytes(assetsBytes));
  console.log("[APK Size Analysis] other    :", fmtBytes(otherBytes));

  return { totalBytes, dartCodeBytes, assetsBytes, nativeBytes, otherBytes, root };
}

/**
 * Analyze an APK file directly — no Flutter build needed.
 *
 * Strategy: APK is a ZIP file. `unzip -v` lists every entry with its
 * compressed size, which is what actually affects the download size.
 *
 * Output format (one data line per entry):
 *   Length  Method   Size Cmpr    Date    Time   CRC-32   Name
 *   123456  Defl:X  45678  63%  2024-…  12:00  deadbeef  lib/arm64-v8a/libapp.so
 */
async function analyzeApkDirect(apkPath: string): Promise<ApkReportData> {
  // ── 1. Run unzip -v ─────────────────────────────────────────────────────
  const raw = await new Promise<string>((resolve, reject) => {
    cp.exec(`unzip -v "${apkPath}"`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      // unzip exits with 1 when there are warnings — still usable
      if (err && !stdout.trim()) { reject(new Error(err.message)); return; }
      resolve(stdout);
    });
  });

  // ── 2. Parse each file entry ─────────────────────────────────────────────
  //
  // unzip -v format (macOS / Linux):
  //  Length   Method    Size  Cmpr    Date    Time   CRC-32   Name
  // --------  ------  ------- ---- ---------- ----- --------  ----
  //   123456  Defl:N    45678  63% 01-01-1981 01:01 deadbeef  lib/arm64.../libapp.so
  //  9010112  Stored  9010112   0% 01-01-1981 01:01 b8dc675d  classes4.dex
  //
  // Notes:
  //   • Date is MM-DD-YYYY (not YYYY-MM-DD)
  //   • Compression ratio can be negative (e.g. -4%)
  //   • Some filenames may be very long but cp.exec doesn't wrap them

  // Matches: (uncompressed) (method) (compressed) (ratio%) (date) (time) (crc) (name)
  const lineRe =
    /^\s*(\d+)\s+\S+\s+(\d+)\s+-?\d+%\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+[0-9a-f]{8}\s+(.+?)\s*$/i;

  interface FileEntry { compressedBytes: number; name: string; }
  const entries: FileEntry[] = [];

  for (const line of raw.split('\n')) {
    const m = line.match(lineRe);
    if (m) {
      entries.push({ compressedBytes: parseInt(m[2], 10), name: m[3].trim() });
    }
  }

  // Debug: log first 5 lines & entry count
  console.log("[APK Direct] Raw sample (first 5 lines):\n",
    raw.split('\n').slice(0, 5).join('\n'));
  console.log("[APK Direct] Entries parsed:", entries.length);

  if (entries.length === 0) {
    // Print the first 10 lines for diagnosis
    const sample = raw.split('\n').slice(0, 10).join('\n');
    console.error("[APK Direct] Could not parse APK. Raw output sample:\n", sample);
    throw new Error(
      "Could not parse any entries from the APK.\n" +
      "Raw output sample (see Output panel):\n" + sample
    );
  }

  // ── 3. Categorise & sum ──────────────────────────────────────────────────
  let dartCodeBytes = 0;
  let nativeBytes   = 0;
  let assetsBytes   = 0;
  let otherBytes    = 0;

  const allItems: ApkTopItem[] = entries.map(e => {
    const { label, category } = resolveComponent(path.basename(e.name), e.name);
    switch (category) {
      case "Dart":   dartCodeBytes += e.compressedBytes; break;
      case "Native": nativeBytes   += e.compressedBytes; break;
      case "Assets": assetsBytes   += e.compressedBytes; break;
      default:       otherBytes    += e.compressedBytes; break;
    }
    return { name: label, sizeBytes: e.compressedBytes, category };
  });

  // Use actual APK file size as total (= what the user downloads)
  const totalBytes = fs.statSync(apkPath).size;

  const topItems = allItems
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 5);

  console.log("[APK Direct] entries parsed:", entries.length);
  console.log("[APK Direct] Total (file)  :", fmtBytes(totalBytes));
  console.log("[APK Direct] Dart          :", fmtBytes(dartCodeBytes));
  console.log("[APK Direct] Native        :", fmtBytes(nativeBytes));
  console.log("[APK Direct] Assets        :", fmtBytes(assetsBytes));
  console.log("[APK Direct] Other         :", fmtBytes(otherBytes));

  return {
    totalBytes,
    dartCodeBytes,
    assetsBytes,
    nativeBytes,
    otherBytes: Math.max(0, totalBytes - dartCodeBytes - nativeBytes - assetsBytes),
    topItems,
    jsonPath: apkPath,   // reuse field to carry the source path
    buildDate: new Date().toLocaleString(),
  };
}

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

  // APK Size Analysis command

  /** Shared helper: parse a size JSON and open the dashboard. */
  function showReportFromJson(jsonPath: string): void {
    try {
      const { totalBytes, dartCodeBytes, assetsBytes, nativeBytes, otherBytes, root } =
        parseSizeJson(jsonPath);
      const topItems = collectTopItems(root, 5);
      const reportData: ApkReportData = {
        totalBytes,
        dartCodeBytes,
        assetsBytes,
        nativeBytes,
        otherBytes,
        topItems,
        jsonPath,
        buildDate: new Date().toLocaleString(),
      };
      console.log("[APK Size Analysis] Total :", fmtBytes(totalBytes));
      console.log("[APK Size Analysis] Dart  :", fmtBytes(dartCodeBytes));
      console.log("[APK Size Analysis] Assets:", fmtBytes(assetsBytes));
      console.log("[APK Size Analysis] Native:", fmtBytes(nativeBytes));
      console.log("[APK Size Analysis] Other :", fmtBytes(otherBytes));
      console.log("[APK Size Analysis] Top 5 :", topItems.map(i => `${i.name} (${fmtBytes(i.sizeBytes)})`));
      ApkSizePanel.show(reportData);
    } catch (parseErr) {
      vscode.window.showErrorMessage(
        `APK Size Analysis: failed to parse JSON.\n${String(parseErr)}`
      );
    }
  }

  const analyzeApkSizeCommand = vscode.commands.registerCommand(
    "deadCode.analyzeApkSize",
    async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage("No Flutter project folder open.");
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "APK Size Analysis",
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({
            message: "Building APK and analyzing size… This may take a few minutes.",
          });

          // ── 1. Run flutter build ────────────────────────────────────────────
          const buildCmd =
            "flutter build apk --analyze-size --target-platform android-arm64";

          let stdout = "";
          let stderr = "";
          let cancelled = false;

          await new Promise<void>((resolve) => {
            const proc = cp.exec(
              buildCmd,
              { cwd: workspaceRoot },
              (err, out, err2) => {
                stdout = out ?? "";
                stderr = err2 ?? "";
                if (!cancelled) {
                  if (err && !token.isCancellationRequested) {
                    vscode.window.showErrorMessage(
                      `Flutter build failed:\n${stderr || err.message}`
                    );
                  }
                }
                resolve();
              }
            );

            token.onCancellationRequested(() => {
              cancelled = true;
              proc.kill();
              resolve();
            });
          });

          if (cancelled || token.isCancellationRequested) {
            vscode.window.showWarningMessage("APK Size Analysis cancelled.");
            return;
          }

          progress.report({ message: "Locating size analysis JSON…" });

          // ── 2. Find the JSON file ───────────────────────────────────────────
          // Flutter prints the path in stdout; try to extract it first.
          let jsonPath: string | undefined;

          const stdoutPathMatch = stdout.match(
            /([^\s]+(?:size-analysis|code-size)[^\s]*\.json)/i
          );
          if (stdoutPathMatch) {
            const candidate = path.isAbsolute(stdoutPathMatch[1])
              ? stdoutPathMatch[1]
              : path.join(workspaceRoot, stdoutPathMatch[1]);
            if (fs.existsSync(candidate)) {
              jsonPath = candidate;
            }
          }

          // Fallback: walk the build directory
          if (!jsonPath) {
            const buildDir = path.join(workspaceRoot, "build");
            const matches = walkDir(buildDir, (name) =>
              /size.*\.json$/i.test(name) || /code-size.*\.json$/i.test(name)
            );
            jsonPath = latestFile(matches);
          }

          if (!jsonPath) {
            vscode.window.showErrorMessage(
              "APK Size Analysis: could not find the size-analysis JSON file. " +
              "Make sure the build completed successfully."
            );
            return;
          }

          progress.report({ message: "Parsing results…" });

          // ── 3. Parse & show dashboard ───────────────────────────────────────
          showReportFromJson(jsonPath);
        }
      );
    }
  );

  // ── Load APK directly ─────────────────────────────────────────────────────
  const loadApkCommand = vscode.commands.registerCommand(
    "deadCode.loadApk",
    async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      // Auto-detect APK files in build/app/outputs/
      const outputDir = workspaceRoot
        ? path.join(workspaceRoot, "build", "app", "outputs")
        : undefined;
      const existingApks = outputDir
        ? walkDir(outputDir, (n) => /\.apk$/i.test(n))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
        : [];

      type PickItem = vscode.QuickPickItem & { fsPath?: string };
      const items: PickItem[] = [
        ...existingApks.map<PickItem>((fp) => ({
          label:       `$(package)  ${path.basename(fp)}`,
          description: path.relative(workspaceRoot ?? "", path.dirname(fp)),
          detail:      `${fmtBytes(fs.statSync(fp).size)}  ·  Last modified: ${
            new Date(fs.statSync(fp).mtimeMs).toLocaleString()
          }`,
          fsPath: fp,
        })),
        {
          label:       "$(folder-opened)  Browse for APK file…",
          description: "Select any .apk from your file system",
        },
      ];

      const picked = await vscode.window.showQuickPick(items, {
        title:       "APK Size Analysis — Select APK File",
        placeHolder: existingApks.length
          ? "Detected APK files, or browse manually"
          : "No APK files found — browse manually",
      });
      if (!picked) { return; }

      let apkPath: string | undefined;
      if (picked.fsPath) {
        apkPath = picked.fsPath;
      } else {
        const uris = await vscode.window.showOpenDialog({
          title:            "Select APK File",
          canSelectFiles:   true,
          canSelectFolders: false,
          canSelectMany:    false,
          defaultUri:       outputDir ? vscode.Uri.file(outputDir) : undefined,
          filters:          { "Android APK": ["apk"] },
          openLabel:        "Analyze",
        });
        if (!uris || uris.length === 0) { return; }
        apkPath = uris[0].fsPath;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "APK Size Analysis",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: `Reading ${path.basename(apkPath!)}…` });
          try {
            const reportData = await analyzeApkDirect(apkPath!);
            ApkSizePanel.show(reportData);
          } catch (err) {
            vscode.window.showErrorMessage(
              `APK Size Analysis: ${String(err)}`
            );
          }
        }
      );
    }
  );

  context.subscriptions.push(
    treeView,
    refreshCommand,
    openFileCommand,
    analyzeApkSizeCommand,
    loadApkCommand,
  );

  console.log("Reduce App Size Flutter extension active.");
}

export function deactivate(): void {}
