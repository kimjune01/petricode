// ── Test harness re-exports ─────────────────────────────────────

export { type FileTree, createTestDir, writeTree, cleanupTestDir } from "./fileTree.js";
export { WorkspaceFixture } from "./workspace.js";
export {
  type GoldenEnvelope,
  createGoldenProvider,
  loadGoldenFile,
  saveGoldenFile,
} from "./goldenProvider.js";
export { PipelineRig, type PipelineRigOptions } from "./pipelineRig.js";
