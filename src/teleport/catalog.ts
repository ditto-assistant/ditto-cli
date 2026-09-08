/**
 * Project-type catalog for language-aware capture planning.
 *
 * Detectors and regenerable-artifact lists are adapted from Kondo
 * (https://github.com/tbillington/kondo, kondo-lib/src/lib.rs, MIT licence,
 * reference revision 1d351ca80b3d / v0.9). Only the read-only detection and
 * exclusion knowledge is used; Kondo's destructive `clean()` is never invoked.
 *
 * Rules apply per detected project and relative to that project's root, never
 * by bare basename across a whole workspace: a directory named `build` is only
 * treated as disposable when a detector that lists `build` matches that project.
 */

export interface ProjectType {
  /** Stable id, e.g. "node", "cargo". */
  id: string;
  label: string;
  /** Marker file names (exact) at the project root that identify the type. */
  markers?: string[];
  /** File-name suffixes anywhere at the project root that identify the type (e.g. ".csproj"). */
  suffixes?: string[];
  /** Project-relative directories that are regenerable and excluded from working-tree capture. */
  artifacts: string[];
  /** Optional additional condition on the root's entries. */
  when?: (entries: Set<string>) => boolean;
  /** Types that take precedence when their markers are also present. */
  supersededBy?: string[];
}

export const KONDO_REFERENCE = { repo: "https://github.com/tbillington/kondo", revision: "1d351ca80b3d", version: "0.9", licence: "MIT" };

export const PROJECT_TYPES: readonly ProjectType[] = [
  { id: "cargo", label: "Rust (Cargo)", markers: ["Cargo.toml"], artifacts: ["target", ".xwin-cache"] },
  {
    id: "node-react-native",
    label: "Node (React Native)",
    markers: ["package.json"],
    when: (e) => e.has("ios") || e.has("android"),
    artifacts: ["node_modules", "android/build", "android/.gradle", "ios/build", "ios/DerivedData", "ios/Pods", ".expo", ".metro"],
  },
  { id: "node", label: "Node", markers: ["package.json"], artifacts: ["node_modules", ".angular"], supersededBy: ["node-react-native"] },
  { id: "turborepo", label: "Turborepo", markers: ["turbo.json"], artifacts: [".turbo"] },
  { id: "unity", label: "Unity", markers: ["Assembly-CSharp.csproj"], artifacts: ["Library", "Temp", "Obj", "Logs", "MemoryCaptures", "Build", "Builds"] },
  { id: "stack", label: "Haskell (Stack)", markers: ["stack.yaml"], artifacts: [".stack-work"] },
  { id: "cabal", label: "Haskell (Cabal)", markers: ["cabal.project"], artifacts: ["dist-newstyle"] },
  { id: "sbt", label: "Scala (SBT)", markers: ["build.sbt"], artifacts: ["target", "project/target"] },
  { id: "maven", label: "Java (Maven)", markers: ["pom.xml"], artifacts: ["target"] },
  { id: "gradle", label: "Gradle", markers: ["build.gradle", "build.gradle.kts"], artifacts: ["build", ".gradle"] },
  { id: "cmake", label: "CMake", markers: ["CMakeLists.txt"], artifacts: ["build", "cmake-build-debug", "cmake-build-release"] },
  { id: "unreal", label: "Unreal Engine", suffixes: [".uproject"], artifacts: ["Binaries", "Build", "Saved", "DerivedDataCache", "Intermediate"] },
  { id: "jupyter", label: "Jupyter", suffixes: [".ipynb"], artifacts: [".ipynb_checkpoints"] },
  {
    id: "python",
    label: "Python",
    markers: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
    suffixes: [".py"],
    artifacts: [".mypy_cache", ".nox", ".pytest_cache", ".ruff_cache", ".tox", "__pycache__", "__pypackages__", ".venv", "venv"],
  },
  { id: "pixi", label: "Pixi", markers: ["pixi.toml"], artifacts: [".pixi"] },
  { id: "composer", label: "PHP (Composer)", markers: ["composer.json"], artifacts: ["vendor"] },
  { id: "pub", label: "Dart/Flutter (Pub)", markers: ["pubspec.yaml"], artifacts: ["build", ".dart_tool", "linux/flutter/ephemeral", "windows/flutter/ephemeral"] },
  { id: "elixir", label: "Elixir (Mix)", markers: ["mix.exs"], artifacts: ["_build", ".elixir-tools", ".elixir_ls", ".lexical"] },
  { id: "swift", label: "Swift (SwiftPM)", markers: ["Package.swift"], artifacts: [".build", ".swiftpm"] },
  { id: "zig", label: "Zig", markers: ["build.zig"], artifacts: ["zig-cache", ".zig-cache", "zig-out"] },
  { id: "godot", label: "Godot 4", markers: ["project.godot"], artifacts: [".godot"] },
  {
    id: "dotnet",
    label: ".NET",
    suffixes: [".csproj", ".fsproj"],
    when: (e) => !e.has("project.godot") && !e.has("Assembly-CSharp.csproj"),
    artifacts: ["bin", "obj"],
  },
  { id: "terraform", label: "Terraform", markers: [".terraform.lock.hcl"], artifacts: [".terraform"] },
  { id: "cocoapods", label: "CocoaPods", markers: ["Podfile"], artifacts: ["Pods"] },
  // Not in Kondo: Go has no regenerable directory by default (vendor/ is real
  // source when present), but the module cache lives outside the repo, so the
  // detector exists for tool inference and never excludes anything.
  { id: "go", label: "Go", markers: ["go.mod"], artifacts: [] },
];

/** Tool the autoconfigure pre-step should pin for a project type (mise tool names). */
export const MISE_TOOL_FOR_TYPE: Record<string, string> = {
  node: "node",
  "node-react-native": "node",
  turborepo: "node",
  cargo: "rust",
  python: "python",
  pixi: "python",
  go: "go",
  maven: "java",
  gradle: "java",
  sbt: "java",
  dotnet: "dotnet",
  elixir: "elixir",
  zig: "zig",
  swift: "swift",
  composer: "php",
  pub: "dart",
  terraform: "terraform",
};

export interface TypeMatch {
  type: ProjectType;
  /** True when a marker file matched (a real project root); false for a suffix-only match. */
  byMarker: boolean;
}

/** Detects every project type present among a directory's entry names, noting how each matched. */
export function detectTypesDetailed(entries: Iterable<string>): TypeMatch[] {
  const set = new Set(entries);
  const names = [...set];
  const matched: TypeMatch[] = [];
  for (const t of PROJECT_TYPES) {
    const byMarker = (t.markers ?? []).some((m) => set.has(m));
    const bySuffix = (t.suffixes ?? []).some((suf) => names.some((n) => n.endsWith(suf)));
    if (!(byMarker || bySuffix)) continue;
    if (t.when && !t.when(set)) continue;
    matched.push({ type: t, byMarker });
  }
  return matched.filter((m) => !(m.type.supersededBy ?? []).some((id) => matched.some((x) => x.type.id === id)));
}

/** Detects every project type whose markers or suffixes are present among a directory's entry names. */
export function detectTypes(entries: Iterable<string>): ProjectType[] {
  return detectTypesDetailed(entries).map((m) => m.type);
}

/** Union of artifact directories for the detected types (project-relative, "/"-joined). */
export function artifactDirs(types: readonly ProjectType[]): string[] {
  return [...new Set(types.flatMap((t) => t.artifacts))].sort();
}
