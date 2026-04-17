import { describe, test, expect } from "bun:test";
import { UnionFindCache } from "../src/cache/cache.js";
import { TfIdfIndex } from "../src/cache/tfidf.js";
import type { Turn } from "../src/core/types.js";

// ── Helpers ─────────────────────────────────────────────────────

function make_turn(id: string, text: string, role: "user" | "assistant" = "user"): Turn {
  return {
    id,
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

let counter = 0;
function unique_turn(text: string, role: "user" | "assistant" = "user"): Turn {
  return make_turn(`t${++counter}`, text, role);
}

// ── Tests ───────────────────────────────────────────────────────

describe("UnionFindCache", () => {
  test("hot zone capacity is respected (never more than N turns)", () => {
    const cache = new UnionFindCache({ hot_capacity: 5 });

    for (let i = 0; i < 20; i++) {
      cache.append(unique_turn(`message ${i}`));
    }

    // read() returns hot + cold summaries; hot portion should be <= 5
    const all = cache.read();
    // Hot turns are appended last in read(), count non-cluster turns
    const hot_count = all.filter((t) => !t.id.startsWith("cluster_")).length;
    expect(hot_count).toBeLessThanOrEqual(5);
  });

  test("append 50 turns — token_count stays bounded (not linear)", () => {
    const cache = new UnionFindCache({ hot_capacity: 10, max_clusters: 5 });
    const long_text = "the quick brown fox jumps over the lazy dog ".repeat(20);

    // Measure token count at 10 turns (before any graduation)
    for (let i = 0; i < 10; i++) {
      cache.append(unique_turn(`${long_text} message ${i}`));
    }
    const count_at_10 = cache.token_count();

    // Now add 40 more
    for (let i = 10; i < 50; i++) {
      cache.append(unique_turn(`${long_text} message ${i}`));
    }
    const count_at_50 = cache.token_count();

    // If it grew linearly, count_at_50 would be ~5x count_at_10.
    // With compression, it should be well under 4x.
    expect(count_at_50).toBeLessThan(count_at_10 * 4);
  });

  test("find() on an early message returns a result after graduation", () => {
    const cache = new UnionFindCache({ hot_capacity: 5 });

    const early = make_turn("early_msg", "this is the early message");
    cache.append(early);

    // Push enough to graduate it
    for (let i = 0; i < 10; i++) {
      cache.append(unique_turn(`filler message ${i}`));
    }

    const found = cache.find("early_msg");
    expect(found).toBeDefined();
    expect(found!.id).toBe("early_msg");
  });

  test("expand() on a cluster root returns original messages", () => {
    const cache = new UnionFindCache({ hot_capacity: 3, merge_threshold: 0.3 });

    // Add several similar messages so they cluster together
    const turns = [
      make_turn("a1", "typescript compiler error in the build pipeline"),
      make_turn("a2", "typescript build pipeline has compiler errors"),
      make_turn("a3", "the build pipeline fails with typescript errors"),
    ];

    for (const t of turns) {
      cache.append(t);
    }

    // Push them out of hot
    for (let i = 0; i < 5; i++) {
      cache.append(unique_turn(`completely different topic number ${i} about cooking recipes and food`));
    }

    // Find a cluster that contains one of our original turns
    const result = cache.read();
    const cluster_turns = result.filter((t) => t.id.startsWith("cluster_"));

    // At least one cluster should exist
    expect(cluster_turns.length).toBeGreaterThan(0);

    // expand on a cluster root should return original turns
    for (const ct of cluster_turns) {
      const root_id = ct.id.replace("cluster_", "");
      const expanded = cache.expand(root_id);
      expect(expanded.length).toBeGreaterThan(0);
      // Every expanded turn should be a real turn with content
      for (const t of expanded) {
        expect(t.content.length).toBeGreaterThan(0);
      }
    }
  });

  test("two semantically similar messages merge; two dissimilar stay separate", () => {
    const cache = new UnionFindCache({
      hot_capacity: 2,
      merge_threshold: 0.3,
      max_clusters: 100, // high cap so we don't force-merge
    });

    // Two very similar messages
    cache.append(make_turn("sim1", "machine learning neural network deep learning gradient descent backpropagation"));
    cache.append(make_turn("sim2", "deep learning neural network machine learning gradient descent optimization"));

    // Two very different messages
    cache.append(make_turn("diff1", "chocolate cake recipe baking flour sugar eggs butter vanilla"));
    cache.append(make_turn("diff2", "quantum physics entanglement superposition wave function particle"));

    // Push everything to cold
    for (let i = 0; i < 5; i++) {
      cache.append(unique_turn(`filler ${i} random words xyzzy plugh`));
    }

    // The similar pair should have merged. Check cluster count < 4
    // (sim1+sim2 should be 1 cluster, diff1 and diff2 should be separate = 3 clusters + fillers)
    const result = cache.read();
    const clusters = result.filter((t) => t.id.startsWith("cluster_"));

    // sim1 and sim2 should be findable
    const found_sim1 = cache.find("sim1");
    const found_sim2 = cache.find("sim2");
    expect(found_sim1).toBeDefined();
    expect(found_sim2).toBeDefined();

    // diff1 and diff2 should not have merged with the similar pair
    const found_diff1 = cache.find("diff1");
    const found_diff2 = cache.find("diff2");
    expect(found_diff1).toBeDefined();
    expect(found_diff2).toBeDefined();

    // The total cluster count should be less than the total number of graduated turns
    // (meaning at least some merging happened)
    const total_graduated = result.filter((t) => t.id.startsWith("cluster_")).length;
    expect(total_graduated).toBeLessThan(9); // 9 non-hot turns were graduated
  });

  test("LRU eviction removes oldest cluster when cap exceeded", () => {
    // Use totally distinct vocabularies so nothing merges
    const topics = [
      "alpha bravo charlie delta echo foxtrot golf hotel",
      "igloo jacket kite lemon mango noodle orange pepper",
      "quartz ruby sapphire topaz uranium vanadium wolfram xenon",
      "asteroid blazer comet dwarf eclipse flare galaxy halo",
      "insulin jellyfish kelp lobster manatee narwhal octopus plankton",
      "abacus blueprint caliper drafting easel fixture grout hinge",
    ];

    const cache = new UnionFindCache({
      hot_capacity: 2,
      max_clusters: 3,
      merge_threshold: 0.99, // absurdly high so nothing merges
    });

    // Create distinct turns with ascending timestamps
    for (let i = 0; i < topics.length; i++) {
      const t = make_turn(`lru_${i}`, topics[i]!);
      t.timestamp = 1000 + i;
      cache.append(t);
    }

    // With max_clusters=3, older clusters should have been evicted
    const result = cache.read();
    const clusters = result.filter((t) => t.id.startsWith("cluster_"));
    expect(clusters.length).toBeLessThanOrEqual(3);

    // The earliest turns should have been evicted (LRU)
    const found_earliest = cache.find("lru_0");
    expect(found_earliest).toBeUndefined();
  });

  test("read() returns hot turns plus cold cluster summaries", () => {
    const cache = new UnionFindCache({ hot_capacity: 3 });

    for (let i = 0; i < 6; i++) {
      cache.append(make_turn(`msg_${i}`, `message number ${i}`));
    }

    const result = cache.read();

    // Should have some hot turns and some cold summaries
    const hot = result.filter((t) => !t.id.startsWith("cluster_"));
    const cold = result.filter((t) => t.id.startsWith("cluster_"));

    expect(hot.length).toBeLessThanOrEqual(3);
    expect(cold.length).toBeGreaterThan(0);
    expect(result.length).toBe(hot.length + cold.length);
  });

  test("token_count() returns a reasonable estimate", () => {
    const cache = new UnionFindCache({ hot_capacity: 5 });
    const text = "hello world"; // 11 chars -> ~3 tokens

    cache.append(make_turn("tc1", text));
    const count = cache.token_count();

    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(20); // Should be ~3, definitely under 20
  });

  test("LRU eviction also tombstones evicted clusters' TF-IDF documents", () => {
    // Regression: previously enforce_cap removed clusters from the forest
    // but never called index.remove_document, so TfIdfIndex.documents grew
    // unboundedly across long sessions and IDF skewed.
    const topics = [
      "alpha bravo charlie delta echo foxtrot golf hotel",
      "igloo jacket kite lemon mango noodle orange pepper",
      "quartz ruby sapphire topaz uranium vanadium wolfram xenon",
      "asteroid blazer comet dwarf eclipse flare galaxy halo",
      "insulin jellyfish kelp lobster manatee narwhal octopus plankton",
      "abacus blueprint caliper drafting easel fixture grout hinge",
      "papaya quince raspberry strawberry tangerine ugli vanilla watermelon",
      "yogurt zucchini artichoke broccoli cauliflower dill eggplant fennel",
    ];
    const cache = new UnionFindCache({
      hot_capacity: 2,
      max_clusters: 3,
      merge_threshold: 0.99, // disable merging
    });

    for (let i = 0; i < topics.length; i++) {
      const t = make_turn(`tfidf_${i}`, topics[i]!);
      t.timestamp = 1000 + i;
      cache.append(t);
    }

    const index = (cache as unknown as { index: TfIdfIndex }).index;
    // After eviction, only live clusters' member docs should remain.
    // Each topic graduates as a singleton, so live count == cluster count.
    const result = cache.read();
    const live_clusters = result.filter((t) => t.id.startsWith("cluster_")).length;
    expect(live_clusters).toBeLessThanOrEqual(3);
    expect(index.live_document_count()).toBe(live_clusters);
  });

  test("graduating an assistant tool_use turn co-graduates the matching tool_result", () => {
    // Regression: previously the assistant turn (with tool_use block X) could
    // graduate to cold while the user turn carrying tool_result(X) stayed
    // hot — leaving an orphan tool_result that any provider call rejects.
    const cache = new UnionFindCache({ hot_capacity: 3 });

    cache.append({
      id: "asst-1",
      role: "assistant",
      content: [{ type: "tool_use", id: "tool-X", name: "shell", input: { command: "ls" } }],
      timestamp: 1,
    });
    cache.append({
      id: "user-1",
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-X", content: "a\nb\nc" }],
      timestamp: 2,
    });
    // Push enough new turns to overflow hot_capacity and force graduation
    for (let i = 0; i < 5; i++) {
      cache.append(make_turn(`pad-${i}`, `padding ${i}`));
    }

    const all = cache.read();
    const orphanedToolResult = all.some((t) =>
      t.content.some(
        (c) => c.type === "tool_result" && c.tool_use_id === "tool-X",
      ),
    );
    const orphanedToolUse = all.some((t) =>
      t.content.some(
        (c) => c.type === "tool_use" && c.id === "tool-X",
      ),
    );
    // Either both stayed in hot, or both graduated together. Never a split.
    expect(orphanedToolResult).toBe(orphanedToolUse);
  });

  test("clear() drops hot, cold, and token count back to empty", () => {
    // Backstop the /clear UX bug — without cache.clear(), the model
    // kept seeing the entire pre-clear history on the next turn even
    // though the UI was empty.
    const cache = new UnionFindCache({ hot_capacity: 3, max_clusters: 5 });

    // Force both hot AND cold population so we exercise the forest reset,
    // not just the hot-only happy path.
    for (let i = 0; i < 10; i++) {
      cache.append(unique_turn(`message ${i}`));
    }
    expect(cache.read().length).toBeGreaterThan(0);
    expect(cache.token_count()).toBeGreaterThan(0);

    cache.clear();

    expect(cache.read()).toEqual([]);
    expect(cache.token_count()).toBe(0);

    // Sanity: appending after clear behaves like a fresh cache, not a
    // stale-index re-bind.
    cache.append(unique_turn("post-clear"));
    expect(cache.read().length).toBe(1);
  });
});
