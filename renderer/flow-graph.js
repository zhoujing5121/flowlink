/**
 * Process 流程图模型（普通脚本，挂 window.FlowGraph）。
 *
 * 职责：
 * 1. flattenFlowSteps —— 展平收敛的唯一实现：bridge.js 的 flatFlowSteps 与
 *    app.js 的 executableFlowSteps 都收敛到这里（stepId 前缀约定与
 *    engine/executor/src/steps.ts 一致：group 内步骤带 group 前缀，如 g2/a1），
 *    Test 进度列表、Process 图、playback:step/done/aiStep 事件共用，杜绝漂移。
 * 2. buildGraph —— 把 Flow 推导为图模型（节点 = 顶层组/未分组伪组 + Start/End
 *    哨节点；边 = 组间顺延实线 + condition 是/否分支边 + 回跳虚线）。
 *    按 step.sourceFlowId 把可执行步骤切成连续段：无跨段 condition 边时各段是
 *    独立分量（AI 融合出的多个独立流程），有跨段边则连为同一分量。
 *    纯数据推导，不做 DOM、不碰 dagre —— 便于独立测试。
 * 3. layoutGraph —— dagre 宏观布局（每个连通分量各跑一次 dagre，横向排开）。
 *    dagre 经 dist/renderer-vendor.js 以 window.__flowlinkDagre 进入；缺失时
 *    返回 false，由调用方显示明确错误（不提供串行回退视图）。
 */
(function () {
  "use strict";

  /* ---------------- 展平（唯一实现） ---------------- */

  /**
   * 展平步骤树。返回：
   * - steps：展平后的步骤对象数组（按执行序；对象即原树中的引用，
   *   附 .flattenedStepId 临时标注，随保存链路被 Zod strip，不落盘）；
   * - entries：与 steps 同序的包装数组（{ step, flattenedStepId, index, groupId }），
   *   groupId = 拥有它的最外层顶层 group id（无组为 null）；
   * - indexById：flattenedStepId → 下标映射（playback 事件按 stepId 对齐用）。
   */
  function flattenFlowSteps(steps) {
    const stepsOut = [];
    const entries = [];
    const indexById = new Map();
    const visit = (list, prefix, ownerGroupId) => {
      for (const step of list || []) {
        if (!step || typeof step !== "object") continue;
        if (step.kind === "group") {
          visit(step.steps, prefix ? prefix + "/" + step.id : step.id, ownerGroupId || step.id);
          continue;
        }
        const flattenedStepId = prefix ? prefix + "/" + step.id : step.id;
        step.flattenedStepId = flattenedStepId;
        if (!indexById.has(flattenedStepId)) indexById.set(flattenedStepId, stepsOut.length);
        entries.push({
          step,
          flattenedStepId,
          index: stepsOut.length,
          groupId: ownerGroupId || null,
        });
        stepsOut.push(step);
      }
    };
    visit(steps || [], "", null);
    return { steps: stepsOut, entries, indexById };
  }

  /* ---------------- 图模型推导（纯数据） ---------------- */

  function countExecutable(list) {
    let n = 0;
    for (const step of list || []) {
      if (step && step.kind === "group") n += countExecutable(step.steps);
      else n += 1;
    }
    return n;
  }

  /**
   * buildGraph(flow) → { nodes, edges, segments, entries, nodeById }。
   *
   * 分段：按步骤级 sourceFlowId（AI 细化标注；无元素引用的步骤已在前处理中
   * 继承相邻标注）切成连续段；无任何标注（纯录制/旧数据）= 单段单链。
   */
  function buildGraph(flow) {
    const steps = flow && Array.isArray(flow.steps) ? flow.steps : [];
    const { entries } = flattenFlowSteps(steps);

    // —— 段：sourceFlowId 连续相同为一段；null 视为继承当前段 ——
    const segments = [];
    const segmentOf = new Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i].step.sourceFlowId ?? null;
      const last = segments[segments.length - 1];
      if (
        key !== null &&
        last &&
        last.key !== null &&
        key !== last.key
      ) {
        segments.push({ key, startIndex: i, endIndex: i + 1 });
      } else {
        if (!last) segments.push({ key, startIndex: i, endIndex: i + 1 });
        else {
          last.endIndex = i + 1;
          if (key !== null && last.key === null) last.key = key;
        }
      }
      segmentOf[i] = segments.length - 1;
    }

    // —— 节点：顶层 group + 未分组伪组（连续顶层裸步骤兜底） ——
    const nodes = [];
    const nodeById = new Map();
    let cursor = 0;
    let counter = 0;
    let bareRun = [];
    const segmentIndexAt = (index) =>
      index < entries.length ? segmentOf[index] : segments.length - 1;
    const flushBare = () => {
      if (!bareRun.length) return;
      const first = bareRun[0];
      const node = {
        id: "ungrouped-" + ++counter,
        type: "ungrouped",
        label: "未分组步骤",
        firstIndex: first,
        lastIndex: first + bareRun.length,
        segmentIndex: segmentIndexAt(first),
        sourceFlowId: entries[first]?.step.sourceFlowId ?? null,
        steps: [],
      };
      nodes.push(node);
      nodeById.set(node.id, node);
      bareRun = [];
    };
    for (const item of steps) {
      if (item && item.kind === "group") {
        flushBare();
        const count = countExecutable(item.steps);
        const first = cursor;
        const node = {
          id: item.id,
          type: "group",
          label: item.label || item.id,
          firstIndex: first,
          lastIndex: first + count,
          segmentIndex: segmentIndexAt(Math.min(first, entries.length - 1)),
          sourceFlowId: entries[first]?.step.sourceFlowId ?? null,
          steps: item.steps || [],
        };
        nodes.push(node);
        nodeById.set(node.id, node);
        cursor += count;
      } else if (item && typeof item === "object") {
        bareRun.push(cursor);
        cursor += 1;
      }
    }
    flushBare();

    // —— 哨节点：每段一对 Start/End ——
    const startBySegment = new Map();
    const endBySegment = new Map();
    for (let s = 0; s < segments.length; s++) {
      const start = {
        id: "__start_" + s,
        type: "start",
        label: "START",
        segmentIndex: s,
      };
      const end = { id: "__end_" + s, type: "end", label: "END", segmentIndex: s };
      nodes.push(start, end);
      nodeById.set(start.id, start);
      nodeById.set(end.id, end);
      startBySegment.set(s, start);
      endBySegment.set(s, end);
    }

    // —— 边 ——
    const edges = [];
    const addBranchEdges = (sourceNode, conditionStep) => {
      const targets = [
        [conditionStep.trueGroupId, "是", "true"],
        [conditionStep.falseGroupId, "否", "false"],
      ];
      for (const [groupId, label, branch] of targets) {
        const target = groupId ? nodeById.get(groupId) : undefined;
        if (target && (target.type === "group" || target.type === "ungrouped")) {
          edges.push({
            from: sourceNode.id,
            to: target.id,
            // 目标组序 ≤ 来源组序 → 回跳边（运行时受 FLOW_LOOP_LIMIT 3 次约束）
            kind:
              target.firstIndex <= sourceNode.firstIndex ? "back" : "branch",
            label,
            branch,
            conditionStepId: conditionStep.id || null,
            conditionLabel:
              conditionStep.label?.trim() || conditionStep.id || "",
            crossSegment: target.segmentIndex !== sourceNode.segmentIndex,
          });
        } else {
          // 目标缺省 → 段内 End 哨（condition 分支落到"到此结束"）
          const segEnd = endBySegment.get(sourceNode.segmentIndex);
          if (segEnd)
            edges.push({
              from: sourceNode.id,
              to: segEnd.id,
              kind: "branch",
              label,
              branch,
              conditionStepId: conditionStep.id || null,
              conditionLabel:
                conditionStep.label?.trim() || conditionStep.id || "",
              crossSegment: false,
            });
        }
      }
    };

    for (let s = 0; s < segments.length; s++) {
      const list = nodes
        .filter(
          (n) =>
            (n.type === "group" || n.type === "ungrouped") &&
            n.segmentIndex === s,
        )
        .sort((a, b) => a.firstIndex - b.firstIndex);
      const segStart = startBySegment.get(s);
      const segEnd = endBySegment.get(s);
      if (!list.length) {
        if (segStart && segEnd) edges.push({ from: segStart.id, to: segEnd.id, kind: "flow" });
        continue;
      }
      if (segStart) edges.push({ from: segStart.id, to: list[0].id, kind: "flow" });
      for (let i = 0; i < list.length; i++) {
        const node = list[i];
        const lastEntry = entries[node.lastIndex - 1];
        // 组内 condition 步骤（含嵌套，规则与 ensureProcessGroups 的
        // branchEntries 一致）都画是/否分支边。
        for (let j = node.firstIndex; j < node.lastIndex; j++) {
          const entry = entries[j];
          if (entry && entry.step.kind === "condition")
            addBranchEdges(node, entry.step);
        }
        // 契约上 condition 必须是组最后一步；此时流程完全由分支决定，
        // 不再画顺延边。组中段的 condition（旧数据非法形态）额外保留顺延边，
        // 图上呈现为分支+顺延的超集（近似）。
        const endsWithCondition = lastEntry && lastEntry.step.kind === "condition";
        if (!endsWithCondition) {
          if (i + 1 < list.length)
            edges.push({ from: node.id, to: list[i + 1].id, kind: "flow" });
          else if (segEnd) edges.push({ from: node.id, to: segEnd.id, kind: "flow" });
        }
      }
    }

    return { nodes, edges, segments, entries, nodeById };
  }

  /* ---------------- dagre 宏观布局 ---------------- */

  const SENTINEL_SIZE = { width: 88, height: 34 };
  const COMPONENT_GAP_X = 120;

  function computeComponents(graph) {
    const parent = new Map();
    const find = (id) => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      let cur = id;
      while (parent.get(cur) !== cur) {
        const next = parent.get(cur);
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    for (const node of graph.nodes) parent.set(node.id, node.id);
    for (const edge of graph.edges) {
      if (!parent.has(edge.from) || !parent.has(edge.to)) continue;
      const a = find(edge.from);
      const b = find(edge.to);
      if (a !== b) parent.set(a, b);
    }
    const buckets = new Map();
    for (const node of graph.nodes) {
      const root = find(node.id);
      if (!buckets.has(root)) buckets.set(root, []);
      buckets.get(root).push(node);
    }
    // 稳定排序：按分量内最小 firstIndex（无坐标依赖，输出确定）
    return [...buckets.values()].sort((a, b) => {
      const fa = Math.min(...a.map((n) => n.firstIndex ?? Infinity));
      const fb = Math.min(...b.map((n) => n.firstIndex ?? Infinity));
      return fa - fb;
    });
  }

  /**
   * dagre 布局：每个连通分量各跑一次（无跨段 condition 边的独立段 =
   * 独立分量，dagre 自动横向排开），从左到右拼接。
   * measure(node) → { width, height }（组卡由调用方先渲染再量尺寸）。
   * 布局结果写到 node.cx/cy（中心）、left/top（左上）、width/height；
   * graph.worldWidth/worldHeight 为画布内容尺寸。
   * window.__flowlinkDagre 缺失时返回 false。
   */
  function layoutGraph(graph, measure) {
    const dagre = window.__flowlinkDagre;
    if (!dagre || typeof dagre.layout !== "function" || !dagre.graphlib) {
      return false;
    }
    for (const node of graph.nodes) {
      if (node.type === "group" || node.type === "ungrouped") {
        const size = measure ? measure(node) : undefined;
        node.width = size?.width || 448;
        node.height = size?.height || 120;
      } else {
        node.width = SENTINEL_SIZE.width;
        node.height = SENTINEL_SIZE.height;
      }
    }

    const components = computeComponents(graph);
    const componentById = new Map();
    for (const component of components)
      for (const node of component) componentById.set(node.id, component);

    let offsetX = 0;
    let worldHeight = 0;
    for (const component of components) {
      const g = new dagre.graphlib.Graph({ multigraph: true });
      g.setGraph({
        rankdir: "TB",
        nodesep: 56,
        ranksep: 72,
        edgesep: 24,
        marginx: 28,
        marginy: 28,
      });
      g.setDefaultEdgeLabel(() => ({}));
      for (const node of component) g.setNode(node.id, { width: node.width, height: node.height });
      for (const edge of graph.edges) {
        if (componentById.get(edge.from) !== component) continue;
        g.setEdge(edge.from, edge.to, { labelpos: "r" });
      }
      dagre.layout(g);

      let minX = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of component) {
        const pos = g.node(node.id);
        node.cx = offsetX + pos.x;
        node.cy = pos.y;
        node.left = node.cx - node.width / 2;
        node.top = node.cy - node.height / 2;
        minX = Math.min(minX, node.left);
        maxX = Math.max(maxX, node.left + node.width);
        maxY = Math.max(maxY, node.top + node.height);
      }
      offsetX = maxX + COMPONENT_GAP_X;
      worldHeight = Math.max(worldHeight, maxY);
    }
    graph.worldWidth = Math.max(0, offsetX - COMPONENT_GAP_X);
    graph.worldHeight = Math.max(0, worldHeight);
    return true;
  }

  window.FlowGraph = {
    flattenFlowSteps,
    buildGraph,
    layoutGraph,
  };
})();
