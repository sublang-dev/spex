// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { MachineGraph } from "@sublang/spex-core/protocol";

/** Presentation-only shape check; Playbook owns the durable codec. */
export function contextGraphs(record: Record<string, unknown>): Record<string, MachineGraph | null> | undefined {
  if (record.contextVersion !== 1 || !Array.isArray(record.graphs)) return;
  const graphs: Record<string, MachineGraph | null> = Object.create(null);
  for (const item of record.graphs) {
    if (!item || typeof item.playbookId !== "string") return;
    const graph = item.graph;
    if (graph !== null && (!graph || typeof graph.initial !== "string" || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) ||
      !graph.nodes.every((node: any) => node && typeof node.id === "string" && ["state","final"].includes(node.kind) && Array.isArray(node.tags) && node.tags.every((tag: unknown) => typeof tag === "string")) ||
      !graph.edges.every((edge: any) => edge && ["id","from","to","event"].every((key) => typeof edge[key] === "string")))) return;
    graphs[item.playbookId] = graph;
  }
  return graphs;
}
