import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import { DeadCodeProvider } from "./DeadCodeProvider";
import { ApkSizePanel, ApkReportData, ApkTopItem } from "./ApkSizePanel";

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

/** Derive a human-readable size string. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1_048_576) { return `${(bytes / 1_048_576).toFixed(2)} MB`; }
  if (bytes >= 1_024)     { return `${(bytes / 1_024).toFixed(1)} KB`; }
  return `${bytes} B`;
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
    fileType: "apk" as const,
  };
}

/**
 * Resolve an IPA ZIP entry to a human-readable label + category.
 *
 * IMPORTANT: checks are ordered from most-specific to least-specific.
 * The flutter_assets check MUST come before the generic .framework check
 * because flutter assets live inside App.framework/flutter_assets/.
 */
function resolveIpaComponent(
  rawName: string,
  fullPath: string
): { label: string; category: ApkTopItem["category"] } {

  // ── 1. Flutter assets (MUST be before .framework catch-all) ───────────────
  if (fullPath.includes("flutter_assets/") || fullPath.includes("flutter_assets\\\\")) {
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(rawName)) {
      return { label: `Flutter Image: ${rawName}`, category: "Assets" };
    }
    if (/\.(ttf|otf|woff2?)$/i.test(rawName)) {
      return { label: `Flutter Font: ${rawName}`, category: "Assets" };
    }
    return { label: "Flutter Assets (images, fonts, data)", category: "Assets" };
  }

  // ── 2. Dart AOT snapshot binary ───────────────────────────────────────────
  if (/App\.framework[/\\]App$/i.test(fullPath)) {
    return { label: "Dart AOT Snapshot (App.framework/App)", category: "Dart" };
  }

  // ── 3. Flutter engine binary ──────────────────────────────────────────────
  if (/Flutter\.framework[/\\]Flutter$/i.test(fullPath)) {
    return { label: "Flutter Engine (Flutter.framework/Flutter)", category: "Native" };
  }

  // ── 4. Swift support libraries (SwiftSupport/*.dylib) ────────────────────
  if (fullPath.startsWith("SwiftSupport/")) {
    const libMatch = rawName.match(/^libswift(.+?)\.dylib$/i);
    const libName = libMatch ? `Swift ${libMatch[1]}` : rawName;
    return { label: `Swift Support: ${libName}`, category: "Native" };
  }

  // ── 5. Debug symbols strip (Symbols/) ────────────────────────────────────
  if (fullPath.startsWith("Symbols/")) {
    return { label: "Debug Symbols", category: "Other" };
  }

  // ── 6. Any .dylib (plugin native libraries) ───────────────────────────────
  if (rawName.endsWith(".dylib")) {
    return { label: `Native Library: ${rawName}`, category: "Native" };
  }

  // ── 7. Named framework binary, e.g. Sentry.framework/Sentry ─────────────
  const fwBinaryMatch = fullPath.match(/\/([^/]+)\.framework\/\1$/i);
  if (fwBinaryMatch) {
    return { label: `Plugin Framework: ${fwBinaryMatch[1]}`, category: "Native" };
  }

  // ── 8. Main app binary Payload/Foo.app/Foo ────────────────────────────────
  const appBinaryMatch = fullPath.match(/^Payload\/([^/]+)\.app\/\1$/i);
  if (appBinaryMatch) {
    return { label: `Main App Binary (${appBinaryMatch[1]})`, category: "Native" };
  }

  // ── 9. App extension binaries (PlugIns/) ─────────────────────────────────
  const appexMatch = fullPath.match(/\/PlugIns\/([^/]+)\.appex\/\1$/i);
  if (appexMatch) {
    return { label: `App Extension: ${appexMatch[1]}`, category: "Native" };
  }

  // ── 10. Compiled asset catalog ───────────────────────────────────────────
  if (rawName === "Assets.car") {
    return { label: "iOS Compiled Assets (Assets.car)", category: "Assets" };
  }

  // ── 11. Standalone image / font assets (e.g. inside plugin .bundles) ─────
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(rawName)) {
    return { label: `Image Asset: ${rawName}`, category: "Assets" };
  }
  if (/\.(ttf|otf|woff2?)$/i.test(rawName)) {
    return { label: `Font Asset: ${rawName}`, category: "Assets" };
  }

  // ── 12. Localisation strings ──────────────────────────────────────────────
  if (fullPath.includes(".lproj/")) {
    return { label: "Localisation Resources", category: "Other" };
  }

  // ── 13. Code signatures ───────────────────────────────────────────────────
  if (fullPath.includes("_CodeSignature/")) {
    return { label: "Code Signature", category: "Other" };
  }

  return { label: rawName, category: "Other" };
}

/**
 * Analyze an IPA file directly — no Xcode build needed.
 *
 * Strategy: IPA is a ZIP file. `unzip -v` lists every entry with its
 * compressed size (= what is actually stored / downloaded).
 */
async function analyzeIpaDirect(ipaPath: string): Promise<ApkReportData> {
  // ── 1. Run unzip -v ─────────────────────────────────────────────────────
  const raw = await new Promise<string>((resolve, reject) => {
    cp.exec(`unzip -v "${ipaPath}"`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout.trim()) { reject(new Error(err.message)); return; }
      resolve(stdout);
    });
  });

  // ── 2. Parse each file entry ─────────────────────────────────────────────
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

  console.log("[IPA Direct] Raw sample (first 5 lines):\n",
    raw.split('\n').slice(0, 5).join('\n'));
  console.log("[IPA Direct] Entries parsed:", entries.length);

  if (entries.length === 0) {
    const sample = raw.split('\n').slice(0, 10).join('\n');
    console.error("[IPA Direct] Could not parse IPA. Raw output sample:\n", sample);
    throw new Error(
      "Could not parse any entries from the IPA.\n" +
      "Raw output sample (see Output panel):\n" + sample
    );
  }

  // ── 3. Categorise & sum ──────────────────────────────────────────────────
  let dartCodeBytes = 0;
  let nativeBytes   = 0;
  let assetsBytes   = 0;
  let otherBytes    = 0;

  const allItems: ApkTopItem[] = entries
    .filter(e => e.compressedBytes > 0)   // skip directory entries (0 bytes)
    .map(e => {
      const { label, category } = resolveIpaComponent(path.basename(e.name), e.name);
      switch (category) {
        case "Dart":   dartCodeBytes += e.compressedBytes; break;
        case "Native": nativeBytes   += e.compressedBytes; break;
        case "Assets": assetsBytes   += e.compressedBytes; break;
        default:       otherBytes    += e.compressedBytes; break;
      }
      return { name: label, sizeBytes: e.compressedBytes, category };
    });

  const totalBytes = fs.statSync(ipaPath).size;

  // Deduplicate labels and sum (e.g. many "Flutter Assets" entries → one bar)
  const aggregated = new Map<string, { sizeBytes: number; category: ApkTopItem["category"] }>();
  for (const item of allItems) {
    const existing = aggregated.get(item.name);
    if (existing) {
      existing.sizeBytes += item.sizeBytes;
    } else {
      aggregated.set(item.name, { sizeBytes: item.sizeBytes, category: item.category });
    }
  }

  const topItems = Array.from(aggregated.entries())
    .map(([name, v]) => ({ name, sizeBytes: v.sizeBytes, category: v.category }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 10);

  console.log("[IPA Direct] Total (file)  :", fmtBytes(totalBytes));
  console.log("[IPA Direct] Dart          :", fmtBytes(dartCodeBytes));
  console.log("[IPA Direct] Native        :", fmtBytes(nativeBytes));
  console.log("[IPA Direct] Assets        :", fmtBytes(assetsBytes));
  console.log("[IPA Direct] Other         :", fmtBytes(otherBytes));
  console.log("[IPA Direct] Top 10 items  :", topItems.map(i => `${i.name}: ${fmtBytes(i.sizeBytes)}`).join(", "));

  return {
    totalBytes,
    dartCodeBytes,
    assetsBytes,
    nativeBytes,
    otherBytes: Math.max(0, totalBytes - dartCodeBytes - nativeBytes - assetsBytes),
    topItems,
    jsonPath: ipaPath,
    buildDate: new Date().toLocaleString(),
    fileType: "ipa" as const,
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

  // Refresh command — runs the analysis (Start Analysis button in viewsWelcome)
  const refreshCommand = vscode.commands.registerCommand(
    "deadCodeView.refresh",
    () => provider.refresh()
  );

  // Reset command — clears data and returns to idle (title-bar refresh button)
  const resetCommand = vscode.commands.registerCommand(
    "deadCodeView.reset",
    () => provider.reset()
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
          `Flutter Find Unused Resources: Could not open file: ${filePath}\n${String(err)}`
        );
      }
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

  // ── Load IPA directly ─────────────────────────────────────────────────────
  const loadIpaCommand = vscode.commands.registerCommand(
    "deadCode.loadIpaFile",
    async () => {
      const uris = await vscode.window.showOpenDialog({
        title:            "Select IPA File",
        canSelectFiles:   true,
        canSelectFolders: false,
        canSelectMany:    false,
        filters:          { "IPA Files": ["ipa"] },
        openLabel:        "Analyze",
      });
      if (!uris || uris.length === 0) { return; }
      const ipaPath = uris[0].fsPath;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "IPA Size Analysis",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: `Reading ${path.basename(ipaPath)}…` });
          try {
            const reportData = await analyzeIpaDirect(ipaPath);
            ApkSizePanel.show(reportData);
          } catch (err) {
            vscode.window.showErrorMessage(
              `IPA Size Analysis: ${String(err)}`
            );
          }
        }
      );
    }
  );

  context.subscriptions.push(
    treeView,
    refreshCommand,
    resetCommand,
    openFileCommand,
    loadApkCommand,
    loadIpaCommand,
  );

  console.log("Flutter Find Unused Resources extension active.");
}

export function deactivate(): void {}
