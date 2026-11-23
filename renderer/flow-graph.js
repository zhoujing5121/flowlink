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
 *    options.level / options.stepUnits（add-swimlane-and-level-views）：级别
 *    裁剪视图（端点提升 + 平行边合并）与下钻步骤卡视图。
 * 2b. buildSwimlane —— 泳道纯数据推导（列 = targetSystem、行 = L1 阶段带、
 *    节点 = 次级任务卡、边 = 执行顺序），网格坐标自算（不走 dagre）。
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

  /* ---------------- 层级编号（树位置派生） ---------------- */

  /**
   * numberingOf(flow) → Map<stepOrGroupId, code>。
   *
   * 层级编号：顶层分组按序 01、02…；其内分组续 01-01、01-02…；更深层逐段延伸
   * （01-01-01、01-01-01-01…，深度无上限）；步骤取父分组编号加段（扁平数据
   * 即 01-01 起）。同一父列表内分组与步骤共享同一条位置序，保证编号不碰撞。
   * 编号是展示派生量：不落盘、不参与执行；Process/Instruction/Test 三处共用。
   */
  function numberingOf(flow) {
    const steps = flow && Array.isArray(flow.steps) ? flow.steps : [];
    const codes = new Map();
    const visit = (list, prefix) => {
      let seq = 0;
      for (const step of list || []) {
        if (!step || typeof step !== "object" || !step.id) continue;
        const code = prefix
          ? prefix + "-" + String(++seq).padStart(2, "0")
          : String(++seq).padStart(2, "0");
        codes.set(step.id, code);
        if (step.kind === "group") visit(step.steps, code);
      }
    };
    visit(steps, "");
    return codes;
  }

  /* ---------------- 层级深度（级别切换器枚举用） ---------------- */

  /**
   * groupDepthOf(steps) → 最深分组嵌套层数（无分组 = 0）。
   * 级别切换器按 1..depth 枚举组级；扁平数据（depth ≤ 1）隐藏 L1、
   * 默认以「下一级」呈现（与现状全量视图等价）。
   */
  function groupDepthOf(list) {
    let max = 0;
    const visit = (items, depth) => {
      for (const step of items || []) {
        if (step && step.kind === "group") {
          if (depth + 1 > max) max = depth + 1;
          visit(step.steps, depth + 1);
        }
      }
    };
    visit(list, 0);
    return max;
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
   * buildGraph(flow, options?) → { nodes, edges, segments, entries, nodeById }。
   *
   * 分段：按步骤级 sourceFlowId（AI 细化标注；无元素引用的步骤已在前处理中
   * 继承相邻标注）切成连续段；无任何标注（纯录制/旧数据）= 单段单链。
   *
   * options.level（1..最深组级）：级别视图——深度 == level 的组与「无子组」的
   * 组为叶子卡（更浅的含子组组为容器），边端点自动提升到所属级别卡（分支/
   * 回跳判定按提升后端点重算），完全相同的平行边合并（保留分支标签）；
   * level ≥ 最深组级时与全量视图等价（走 legacy 发射路径，输出逐字节一致）。
   * options.stepUnits：裸步骤逐张成卡（下钻视图用；配合 level=1）。
   */
  function buildGraph(flow, options) {
    const steps = flow && Array.isArray(flow.steps) ? flow.steps : [];
    const { entries } = flattenFlowSteps(steps);
    const level =
      options && Number.isFinite(options.level)
        ? Math.max(1, Math.floor(options.level))
        : null;
    const stepUnits = Boolean(options && options.stepUnits);
    // 级别裁剪仅在 level < 最深组级时改变形态；≥ 时与全量视图等价，
    // 走 legacy 发射路径（与 buildGraph(flow) 无参调用输出一致）。
    const levelMode =
      stepUnits ||
      (level !== null && level < groupDepthOf(steps));

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

    // —— 节点：顶层 group + 未分组伪组（连续顶层裸步骤兜底）。
    // 组内全部 condition（任意位置，含嵌套组）提取为独立菱形判断节点，
    // 动作步骤按条件位置切分为多张卡（卡片带 groupId 指回原组视图）。
    const nodes = [];
    const nodeById = new Map();
    // 裸步骤 id → 覆盖它的节点（步骤级分支目标的边解析用）
    const nodeByStepId = new Map();
    let cursor = 0;
    let counter = 0;
    let bareRun = [];
    const segmentIndexAt = (index) =>
      index < entries.length ? segmentOf[index] : segments.length - 1;
    // 把一段连续扁平下标 [firstIndex, lastIndex) 按 condition 切成卡 + 判断节点。
    const flushBare = () => {
      if (!bareRun.length) return;
      const first = bareRun[0];
      emitRange(first, first + bareRun.length, {
        id: "ungrouped-" + ++counter,
        type: "ungrouped",
        label: "未分组步骤",
      });
      bareRun = [];
    };
    const emitRange = (firstIndex, lastIndex, meta) => {
      let runStart = -1;
      const flushCard = (endExclusive) => {
        if (runStart < 0) return;
        const node = {
          id: meta.id + "-part" + runStart,
          groupId: meta.id,
          type: meta.type,
          label: meta.label,
          firstIndex: runStart,
          lastIndex: endExclusive,
          segmentIndex: segmentIndexAt(Math.min(runStart, entries.length - 1)),
          sourceFlowId: entries[runStart]?.step.sourceFlowId ?? null,
          containerId: meta.containerId || null,
          // 步骤卡（stepUnits 下钻视图）：携带步骤引用供渲染层取编号/明细
          step: meta.step || null,
        };
        nodes.push(node);
        nodeById.set(node.id, node);
        runStart = -1;
      };
      for (let i = firstIndex; i < lastIndex; i++) {
        const entry = entries[i];
        if (!entry) continue;
        if (entry.step.kind === "condition") {
          flushCard(i);
          const decision = {
            id: "cond-" + entry.flattenedStepId.replace(/[^-\w]/g, "-"),
            type: "decision",
            label: entry.step.label?.trim() || "条件判断",
            firstIndex: entry.index,
            lastIndex: entry.index + 1,
            segmentIndex: segmentOf[entry.index] ?? 0,
            sourceFlowId: entry.step.sourceFlowId ?? null,
            conditionStep: entry.step,
            containerId: meta.containerId || null,
          };
          nodes.push(decision);
          nodeById.set(decision.id, decision);
        } else if (runStart < 0) runStart = i;
      }
      flushCard(lastIndex);
    };
    // —— 嵌套分组推导：含子分组的组渲染为容器节点（外层组卡包含内层组卡），
    // 直接步骤段成为容器内的连续步骤卡，子分组递归同规则（深度无上限）。
    // 容器不参与边链/分支目标解析（边按执行语义连接卡与判定节点）。
    const emitGroup = (group, firstIndex, containerId) => {
      const children = group.steps || [];
      const count = countExecutable(children);
      const lastIndex = firstIndex + count;
      const hasNested = children.some((step) => step?.kind === "group");
      if (!hasNested) {
        emitRange(firstIndex, lastIndex, {
          id: group.id,
          type: "group",
          label: group.label || group.id,
          containerId,
        });
        return lastIndex;
      }
      const container = {
        id: group.id,
        type: "group",
        container: true,
        label: group.label || group.id,
        targetSystem: group.targetSystem || null,
        firstIndex,
        lastIndex,
        segmentIndex: segmentIndexAt(Math.min(firstIndex, Math.max(0, entries.length - 1))),
        sourceFlowId: entries[firstIndex]?.step.sourceFlowId ?? null,
        containerId: containerId || null,
      };
      nodes.push(container);
      nodeById.set(container.id, container);
      let cursor = firstIndex;
      let runStart = -1;
      let runSeq = 0;
      const flushRun = () => {
        if (runStart < 0) return;
        emitRange(runStart, cursor, {
          id: group.id + "-run" + ++runSeq,
          type: "ungrouped",
          label: "直接步骤",
          containerId: group.id,
        });
        runStart = -1;
      };
      for (const child of children) {
        if (child && child.kind === "group") {
          flushRun();
          cursor = emitGroup(child, cursor, group.id);
        } else {
          if (runStart < 0) runStart = cursor;
          cursor += 1;
        }
      }
      flushRun();
      return cursor;
    };
    // —— 级别视图发射：深度 == level 的组与无子组的组为叶子卡，更浅的含子组
    // 组为容器；stepUnits 时裸步骤逐张成卡（下钻视图）。结构与 legacy 的
    // emitGroup 同构（容器几何包含、emitRange 条件切分/判定节点提取复用）。
    const emitLevelUnits = () => {
      let cursor = 0;
      let ungroupedSeq = 0;
      const emitList = (list, depth, containerId) => {
        let runStart = -1;
        let runSeq = 0;
        const flushRun = () => {
          if (runStart < 0) return;
          if (stepUnits) {
            for (let i = runStart; i < cursor; i++) {
              const entry = entries[i];
              emitRange(i, i + 1, {
                id: "step-" + entry.flattenedStepId.replace(/[^-\w]/g, "-"),
                type: "step",
                label:
                  entry.step.label?.trim() ||
                  (entry.step.kind === "condition" ? "条件判断" : entry.step.id),
                containerId,
                step: entry.step,
              });
            }
          } else {
            emitRange(runStart, cursor, {
              id: containerId
                ? containerId + "-run" + ++runSeq
                : "ungrouped-" + ++ungroupedSeq,
              type: "ungrouped",
              label: containerId ? "直接步骤" : "未分组步骤",
              containerId,
            });
          }
          runStart = -1;
        };
        for (const item of list) {
          if (item && item.kind === "group") {
            flushRun();
            const hasNested = (item.steps || []).some(
              (step) => step && step.kind === "group",
            );
            if (depth === level || !hasNested) {
              const count = countExecutable(item.steps);
              emitRange(cursor, cursor + count, {
                id: item.id,
                type: "group",
                label: item.label || item.id,
                containerId,
              });
              cursor += count;
            } else {
              const count = countExecutable(item.steps);
              const container = {
                id: item.id,
                type: "group",
                container: true,
                label: item.label || item.id,
                targetSystem: item.targetSystem || null,
                firstIndex: cursor,
                lastIndex: cursor + count,
                segmentIndex: segmentIndexAt(
                  Math.min(cursor, Math.max(0, entries.length - 1)),
                ),
                sourceFlowId: entries[cursor]?.step.sourceFlowId ?? null,
                containerId: containerId || null,
              };
              nodes.push(container);
              nodeById.set(container.id, container);
              emitList(item.steps, depth + 1, item.id);
            }
          } else if (item && typeof item === "object") {
            if (runStart < 0) runStart = cursor;
            cursor += 1;
          }
        }
        flushRun();
      };
      emitList(steps, 1, null);
    };
    if (levelMode) emitLevelUnits();
    else
      for (const item of steps) {
        if (item && item.kind === "group") {
          flushBare();
          cursor = emitGroup(item, cursor, null);
        } else if (item && typeof item === "object") {
          bareRun.push(cursor);
          cursor += 1;
        }
      }
    if (!levelMode) flushBare();
    // 步骤级分支目标解析：每个扁平条目的裸步骤 id → 覆盖它的卡/判断节点。
    for (const node of nodes) {
      if (node.type === "decision") {
        if (node.conditionStep?.id) nodeByStepId.set(node.conditionStep.id, node);
        continue;
      }
      if (node.container) continue;
      for (let i = node.firstIndex; i < node.lastIndex; i++) {
        const entry = entries[i];
        if (entry?.step?.id && !nodeByStepId.has(entry.step.id))
          nodeByStepId.set(entry.step.id, node);
      }
    }

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
    // 分支边：目标解析到步骤 id（任意位置步骤/条件）；缺省分支 = 顺序继续
    //（连到判定后的下一个顺延节点；段末则连段 End 哨）。
    // 可连的目标类型：组卡/未分组伪组/步骤卡（下钻视图）/判定节点。
    const LINKABLE = ["group", "ungrouped", "step", "decision"];
    const addBranchEdges = (sourceNode, conditionStep, nextNode, segEnd) => {
      const targets = [
        [conditionStep.trueStepId, "是", "true"],
        [conditionStep.falseStepId, "否", "false"],
      ];
      for (const [stepId, label, branch] of targets) {
        const target = stepId ? nodeByStepId.get(stepId) : undefined;
        if (
          target &&
          LINKABLE.includes(target.type) &&
          target !== sourceNode
        ) {
          edges.push({
            from: sourceNode.id,
            to: target.id,
            // 目标序 ≤ 来源序 → 回跳边（运行时受 FLOW_LOOP_LIMIT 3 次约束）
            kind:
              target.firstIndex <= sourceNode.firstIndex ? "back" : "branch",
            label,
            branch,
            conditionStepId: conditionStep.id || null,
            conditionLabel:
              conditionStep.label?.trim() || conditionStep.id || "",
            crossSegment: target.segmentIndex !== sourceNode.segmentIndex,
          });
        } else if (nextNode) {
          // 缺省 = 顺序继续：不是终止，沿组内/组间下一步顺延。
          edges.push({
            from: sourceNode.id,
            to: nextNode.id,
            kind: "flow",
            label,
            branch,
            conditionStepId: conditionStep.id || null,
            conditionLabel:
              conditionStep.label?.trim() || conditionStep.id || "",
            crossSegment: nextNode.segmentIndex !== sourceNode.segmentIndex,
          });
        } else if (segEnd) {
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
            !n.container &&
            LINKABLE.includes(n.type) &&
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
        const next = list[i + 1];
        if (node.type === "decision") {
          // 判断节点：只出是/否分支边（有目标的连目标，缺省的顺序继续）。
          addBranchEdges(node, node.conditionStep, next, segEnd);
          continue;
        }
        if (next) edges.push({ from: node.id, to: next.id, kind: "flow" });
        else if (segEnd) edges.push({ from: node.id, to: segEnd.id, kind: "flow" });
      }
    }

    // —— 级别视图：平行边合并 —— 端点提升后完全相同的边（from/to/kind/label/
    // branch）只保留一条；不同标签（是/否）的平行边保留（dagre multigraph）。
    let graphEdges = edges;
    if (levelMode) {
      const seen = new Set();
      graphEdges = edges.filter((edge) => {
        const key = [
          edge.from,
          edge.to,
          edge.kind,
          edge.label || "",
          edge.branch || "",
        ].join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    return { nodes, edges: graphEdges, segments, entries, nodeById, nodeByStepId };
  }

  /* ---------------- 泳道布局推导（纯数据，add-swimlane-and-level-views） ---------------- */

  // 泳道几何常量：列头/阶段带/卡宽与 CSS 对齐（demo FlowLink.11.20 校准）。
  const SWIMLANE_LANE_LEFT = 176;
  const SWIMLANE_HEADER_H = 40;
  const SWIMLANE_CARD_W = 320;
  const SWIMLANE_CARD_PAD = 16;
  const SWIMLANE_COL_W = SWIMLANE_CARD_W + SWIMLANE_CARD_PAD * 2;
  const SWIMLANE_ROW_GAP = 24;
  const SWIMLANE_BAND_GAP = 40;
  const SWIMLANE_START_Y = 88;
  const SWIMLANE_TOP = 144;
  const SWIMLANE_BOTTOM_PAD = 64;

  /**
   * buildSwimlane(flow, measure?) → { columns, bands, tasks, edges, start, end,
   * worldWidth, worldHeight, numbering, entries }。
   *
   * 列 = 有效 targetSystem 去重（出现序）+「未标注」兜底列（仅当存在无标签
   * 任务时追加）；行 = L1 阶段带（顶层组；同一 condition 分支目标所在的兄弟
   * 组合并为一带，带标题为编号区间 + 分支标题；顶层裸步骤归「未分组」带）；
   * 节点 = 次级任务卡（L2 组卡 / 步骤卡），lane = 自身标签 → 最近祖先（L1）
   * → 未标注。measure(task) → { height }（卡高按真实内容实测；宽度恒定）。
   * 坐标为自算网格（列 × 带内行槽），不走 dagre。
   */
  function buildSwimlane(flow, measure) {
    const steps = flow && Array.isArray(flow.steps) ? flow.steps : [];
    const { entries } = flattenFlowSteps(steps);
    const numbering = numberingOf(flow);
    const topGroups = steps.filter((step) => step && step.kind === "group");

    // —— 分支兄弟组合并：同一 condition 的 true/false 目标（叶步骤 id）落在
    // 不同顶层组 → 并查集合并为一条阶段带。
    const parentOf = new Map(topGroups.map((group) => [group.id, group.id]));
    const find = (id) => {
      let root = id;
      while (parentOf.get(root) !== root) root = parentOf.get(root);
      return root;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parentOf.set(ra, rb);
    };
    const topGroupByStepId = new Map();
    for (const entry of entries) {
      if (entry.step?.id && entry.groupId)
        topGroupByStepId.set(entry.step.id, entry.groupId);
    }
    const branchLabelOf = new Map(); // root → 分支标题（首个合并条件）
    const walkConditions = (list) => {
      for (const step of list || []) {
        if (!step || typeof step !== "object") continue;
        if (step.kind === "group") walkConditions(step.steps);
        else if (step.kind === "condition") {
          const groups = [step.trueStepId, step.falseStepId]
            .map((id) => (id ? topGroupByStepId.get(id) : undefined))
            .filter(Boolean);
          const distinct = [...new Set(groups)];
          if (distinct.length >= 2) {
            const label = step.label?.trim() || step.id;
            for (let i = 1; i < distinct.length; i++)
              union(distinct[0], distinct[i]);
            const root = find(distinct[0]);
            if (!branchLabelOf.has(root)) branchLabelOf.set(root, label);
          }
        }
      }
    };
    walkConditions(steps);

    // —— 阶段带：按顶层出现序；合并集按首成员位置归位。
    // 裸步骤带区间：按顶层裸步骤的扁平下标归集（连续段）。
    const bareSeeds = [];
    {
      let run = null;
      let cursor = 0;
      const countOf = (step) =>
        step && step.kind === "group" ? countExecutable(step.steps) : 1;
      for (const item of steps) {
        if (item && item.kind === "group") cursor += countOf(item);
        else if (item && typeof item === "object") {
          if (!run) run = { first: cursor };
          cursor += 1;
          run.last = cursor;
        }
      }
      if (run) bareSeeds.push(run);
    }

    // 顶层组的叶区间（含成员序）
    const rangeOfTopGroup = new Map();
    {
      let cursor = 0;
      for (const group of topGroups) {
        const count = countExecutable(group.steps);
        rangeOfTopGroup.set(group.id, { firstIndex: cursor, lastIndex: cursor + count });
        cursor += count;
      }
    }

    const bandRoots = []; // 依顶层出现序的 root 列表
    const seenRoots = new Set();
    for (const group of topGroups) {
      const root = find(group.id);
      if (!seenRoots.has(root)) {
        seenRoots.add(root);
        bandRoots.push(root);
      }
    }
    const bands = [];
    const bandIndexOfGroup = new Map();
    const groupsByRoot = new Map();
    for (const root of bandRoots)
      groupsByRoot.set(
        root,
        topGroups.filter((group) => find(group.id) === root),
      );
    let bareSeedCursor = 0;
    let bandCursor = 0;
    // 顶层出现序混合裸步骤带：按 seed 顺序（组 root 或裸段）生成 bands。
    const rootSeeded = new Set();
    for (const item of steps) {
      if (item && item.kind === "group") {
        const root = find(item.id);
        if (!rootSeeded.has(root)) {
          rootSeeded.add(root);
          const members = groupsByRoot.get(root) || [];
          const first = Math.min(
            ...members.map((group) => rangeOfTopGroup.get(group.id).firstIndex),
          );
          const last = Math.max(
            ...members.map((group) => rangeOfTopGroup.get(group.id).lastIndex),
          );
          const merged = members.length > 1;
          const codes = members.map(
            (group) => numbering.get(group.id) || group.id,
          );
          const band = {
            kind: "group",
            key: root,
            title: merged ? codes[0] + "–" + codes[codes.length - 1] : codes[0],
            name: merged
              ? branchLabelOf.get(root) || members[0].label || ""
              : members[0].label || members[0].id,
            branchLabel: merged ? branchLabelOf.get(root) || "" : "",
            groupIds: members.map((group) => group.id),
            firstIndex: first,
            lastIndex: last,
          };
          for (const group of members)
            bandIndexOfGroup.set(group.id, bandCursor);
          bands.push(band);
          bandCursor++;
        }
      } else if (item && typeof item === "object") {
        const seed = bareSeeds[bareSeedCursor];
        if (seed && !bands.some((band) => band.kind === "bare" && band.seed === seed)) {
          bands.push({
            kind: "bare",
            key: "__bare__",
            title: "—",
            name: "未分组步骤",
            branchLabel: "",
            groupIds: [],
            firstIndex: seed.first,
            lastIndex: seed.last,
            seed,
          });
          bareSeedCursor++;
          bandCursor++;
        }
      }
    }

    // —— 任务卡：各顶层组的直接子项（L2 组卡 / 步骤卡）+ 裸步骤卡。
    // condition 不成卡（分支点由带标签的分支边表达）；其边源回溯到
    // 前一个覆盖任务（demo 的 split/merge 同形态）。
    const tasks = [];
    const effectiveSystem = (own, topGroup) =>
      (own && String(own).trim()) ||
      (topGroup?.targetSystem && String(topGroup.targetSystem).trim()) ||
      "";
    const isUnit = (item) =>
      item && typeof item === "object" && item.kind !== "condition";
    for (const band of bands) {
      const bandIndex = bands.indexOf(band);
      if (band.kind === "bare") {
        for (let i = band.firstIndex; i < band.lastIndex; i++) {
          const entry = entries[i];
          if (!entry || entry.step?.kind === "condition") continue;
          tasks.push({
            id: "step:" + entry.flattenedStepId,
            groupKey: null,
            type: "step",
            step: entry.step,
            label: entry.step.label?.trim() || entry.step.id,
            code: numbering.get(entry.step.id) || "",
            laneKey: "",
            bandIndex,
            firstIndex: i,
            lastIndex: i + 1,
          });
        }
        continue;
      }
      for (const groupId of band.groupIds) {
        const group = topGroups.find((item) => item.id === groupId);
        if (!group) continue;
        let cursor = rangeOfTopGroup.get(groupId).firstIndex;
        for (const child of group.steps || []) {
          if (!child || typeof child !== "object") continue;
          if (child.kind === "group") {
            const count = countExecutable(child.steps);
            tasks.push({
              id: child.id,
              groupKey: child.id,
              type: "group",
              label: child.label || child.id,
              code: numbering.get(child.id) || "",
              laneKey: effectiveSystem(child.targetSystem, group),
              bandIndex,
              firstIndex: cursor,
              lastIndex: cursor + count,
              children: (child.steps || [])
                .filter((item) => item && typeof item === "object")
                .map((item) => ({
                  id: item.id,
                  kind: item.kind,
                  label: item.label?.trim() || item.id,
                  code: numbering.get(item.id) || "",
                })),
            });
            cursor += count;
          } else {
            if (child.kind === "condition") {
              cursor += 1;
              continue;
            }
            tasks.push({
              id: "step:" + entries[cursor]?.flattenedStepId,
              groupKey: groupId,
              type: "step",
              step: child,
              label: child.label?.trim() || child.id,
              code: numbering.get(child.id) || "",
              laneKey: effectiveSystem(null, group),
              bandIndex,
              firstIndex: cursor,
              lastIndex: cursor + 1,
            });
            cursor += 1;
          }
        }
      }
    }

    // —— 列：出现序去重 + 未标注兜底（仅当有无标签任务时追加）。
    const columns = [];
    const columnByKey = new Map();
    const unlabeledTasks = tasks.some((task) => !task.laneKey);
    for (const task of tasks) {
      if (!task.laneKey) continue;
      if (!columnByKey.has(task.laneKey)) {
        columnByKey.set(task.laneKey, columns.length);
        columns.push({ key: task.laneKey, name: task.laneKey });
      }
    }
    if (unlabeledTasks) {
      columnByKey.set("", columns.length);
      columns.push({ key: "", name: "未标注" });
    }
    for (const task of tasks) task.laneIndex = columnByKey.get(task.laneKey) ?? 0;

    // —— 边：执行顺序链（首序任务对）+ 条件分支边（带标签）+ 回跳。
    const orderedTasks = [...tasks].sort((a, b) => a.firstIndex - b.firstIndex);
    const taskByIndex = new Map(); // 扁叶下标 → 覆盖任务
    for (const task of tasks)
      for (let i = task.firstIndex; i < task.lastIndex; i++)
        if (!taskByIndex.has(i)) taskByIndex.set(i, task);
    const stepIdToIndex = new Map();
    for (const entry of entries)
      if (entry.step?.id && !stepIdToIndex.has(entry.step.id))
        stepIdToIndex.set(entry.step.id, entry.index);
    // 条件不成卡：边源/目标回溯到最近覆盖任务（源向后、目标向前再向后）。
    const resolveTaskAt = (index) => {
      if (taskByIndex.has(index)) return taskByIndex.get(index);
      for (let i = index - 1; i >= 0; i--)
        if (taskByIndex.has(i)) return taskByIndex.get(i);
      for (let i = index + 1; i < entries.length; i++)
        if (taskByIndex.has(i)) return taskByIndex.get(i);
      return undefined;
    };
    const laneEdges = [];
    const pushEdge = (edge) => {
      const key = [edge.from, edge.to, edge.kind, edge.label || ""].join("|");
      if (laneEdges.some((item) => [item.from, item.to, item.kind, item.label || ""].join("|") === key))
        return;
      laneEdges.push(edge);
    };
    for (let i = 1; i < orderedTasks.length; i++) {
      const prev = orderedTasks[i - 1];
      const next = orderedTasks[i];
      if (prev.id !== next.id)
        pushEdge({ from: prev.id, to: next.id, kind: "flow" });
    }
    for (const entry of entries) {
      const step = entry.step;
      if (!step || step.kind !== "condition") continue;
      const source = resolveTaskAt(entry.index);
      if (!source) continue;
      for (const [stepId, label, branch] of [
        [step.trueStepId, "是", "true"],
        [step.falseStepId, "否", "false"],
      ]) {
        const targetIndex = stepId ? stepIdToIndex.get(stepId) : undefined;
        const target =
          targetIndex !== undefined ? resolveTaskAt(targetIndex) : undefined;
        if (!target || target.id === source.id) continue;
        pushEdge({
          from: source.id,
          to: target.id,
          kind: target.firstIndex < source.firstIndex ? "back" : "branch",
          label,
          branch,
          conditionLabel: step.label?.trim() || step.id || "",
        });
      }
    }

    // —— 网格坐标：列 × 带内行槽（并行任务按起始槽交错落位，同列防重叠下推）。
    for (const task of tasks) {
      const size = measure ? measure(task) : null;
      task.width = SWIMLANE_CARD_W;
      task.height = size?.height || 48;
      task.x = SWIMLANE_LANE_LEFT + task.laneIndex * SWIMLANE_COL_W + SWIMLANE_CARD_PAD;
    }
    const colBottom = new Array(columns.length).fill(0);
    let y = SWIMLANE_TOP;
    bands.forEach((band, bandIndex) => {
      band.top = y;
      const inBand = tasks.filter((task) => task.bandIndex === bandIndex);
      const slotHeights = [];
      for (const task of inBand) {
        const slot = task.firstIndex - band.firstIndex;
        task.slot = Math.max(0, slot);
        slotHeights[task.slot] = Math.max(
          slotHeights[task.slot] || 0,
          task.height + SWIMLANE_ROW_GAP,
        );
      }
      const slotTop = [];
      let acc = 0;
      for (let s = 0; s < slotHeights.length; s++) {
        slotTop[s] = acc;
        acc += slotHeights[s] || SWIMLANE_ROW_GAP;
      }
      for (const task of inBand) {
        let taskY = band.top + (slotTop[task.slot] || 0);
        const bottom = colBottom[task.laneIndex] || 0;
        if (taskY < bottom) taskY = bottom;
        task.y = taskY;
        colBottom[task.laneIndex] = taskY + task.height + SWIMLANE_ROW_GAP;
      }
      band.bottom = band.top + acc;
      y = band.bottom + SWIMLANE_BAND_GAP;
    });
    const startTask = orderedTasks[0] || null;
    const endTask = orderedTasks[orderedTasks.length - 1] || null;
    const lastBand = bands[bands.length - 1];
    const contentBottom = lastBand ? lastBand.bottom : SWIMLANE_TOP;
    const start = {
      x: startTask
        ? SWIMLANE_LANE_LEFT + startTask.laneIndex * SWIMLANE_COL_W + SWIMLANE_COL_W / 2
        : SWIMLANE_LANE_LEFT + SWIMLANE_COL_W / 2,
      y: SWIMLANE_START_Y,
    };
    const end = {
      x: endTask
        ? SWIMLANE_LANE_LEFT + endTask.laneIndex * SWIMLANE_COL_W + SWIMLANE_COL_W / 2
        : start.x,
      y: contentBottom + 40,
    };
    const worldWidth = SWIMLANE_LANE_LEFT + columns.length * SWIMLANE_COL_W + 16;
    const worldHeight = end.y + SWIMLANE_BOTTOM_PAD;
    return {
      columns,
      bands,
      tasks,
      edges: laneEdges,
      start,
      end,
      worldWidth,
      worldHeight,
      numbering,
      entries,
      laneLeft: SWIMLANE_LANE_LEFT,
      headerHeight: SWIMLANE_HEADER_H,
      columnWidth: SWIMLANE_COL_W,
      cardWidth: SWIMLANE_CARD_W,
      cardPad: SWIMLANE_CARD_PAD,
    };
  }

  /* ---------------- dagre 宏观布局 ---------------- */

  const SENTINEL_SIZE = { width: 88, height: 34 };
  const COMPONENT_GAP_X = 120;
  // 容器卡（外层组卡）几何：头部高度 + 内边距，与 CSS .canvas-group-container 对齐。
  const CONTAINER_HEADER = 52;
  const CONTAINER_PAD = { x: 14, y: 14 };

  function computeComponents(graph) {
    const layoutNodes = graph.nodes.filter((node) => !node.container);
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
    for (const node of layoutNodes) parent.set(node.id, node.id);
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
      if (node.container) continue;
      if (node.type === "group" || node.type === "ungrouped") {
        const size = measure ? measure(node) : undefined;
        node.width = size?.width || 448;
        node.height = size?.height || 120;
      } else if (node.type === "decision") {
        // 菱形判断节点：优先量 DOM 实测尺寸，缺省给足标签空间
        const size = measure ? measure(node) : undefined;
        node.width = size?.width || 168;
        node.height = size?.height || 72;
      } else {
        node.width = SENTINEL_SIZE.width;
        node.height = SENTINEL_SIZE.height;
      }
    }

    // 容器不参与 dagre：无边且尺寸由子节点包围盒决定；以 undefined 尺寸进
    // dagre 会让全部节点的 x 坐标变 NaN（真机实测 Task 视图全卡叠同一点）。
    const components = computeComponents({
      nodes: graph.nodes.filter((node) => !node.container),
      edges: graph.edges,
    });
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
      let edgeSeq = 0;
      for (const edge of graph.edges) {
        if (componentById.get(edge.from) !== component) continue;
        // multigraph 下用唯一边名（平行边互不覆盖），布局后按名取路由点
        edge.dagreName = "e" + edgeSeq++;
        g.setEdge(edge.from, edge.to, { labelpos: "r" }, edge.dagreName);
      }
      dagre.layout(g);
      for (const edge of graph.edges) {
        if (componentById.get(edge.from) !== component) continue;
        const placed = g.edge(edge.from, edge.to, edge.dagreName);
        // dagre 计算的边路由点（含转弯）交给渲染层画折线；
        // 与节点同分量坐标系，补 offsetX 平移到画布坐标。
        if (Array.isArray(placed?.points) && placed.points.length)
          edge.points = placed.points.map((point) => ({
            x: offsetX + point.x,
            y: point.y,
          }));
      }

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
    // dagre 侧世界尺寸（容器包围盒在此之前必须先有基准值，否则
    // Math.max(undefined, …) 产出 NaN，fit/平移随之失效）。
    graph.worldWidth = Math.max(0, offsetX - COMPONENT_GAP_X);
    graph.worldHeight = Math.max(0, worldHeight);
    // —— 容器边界（嵌套分组）：dagre 只排非容器节点；容器 = 其直接子节点
    // 包围盒 + 头部 + 内边距，自最深容器向上逐层包裹，并计入世界尺寸。
    const containers = graph.nodes.filter((node) => node.container);
    const depthOf = (node) => {
      let depth = 0;
      let cur = node;
      while (cur?.containerId) {
        depth++;
        cur = graph.nodes.find((n) => n.id === cur.containerId);
      }
      return depth;
    };
    containers.sort((a, b) => depthOf(b) - depthOf(a));
    for (const container of containers) {
      const kids = graph.nodes.filter(
        (node) => node.containerId === container.id && node.left !== undefined,
      );
      if (!kids.length) continue;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const kid of kids) {
        minX = Math.min(minX, kid.left);
        minY = Math.min(minY, kid.top);
        maxX = Math.max(maxX, kid.left + kid.width);
        maxY = Math.max(maxY, kid.top + kid.height);
      }
      container.left = minX - CONTAINER_PAD.x;
      container.top = minY - CONTAINER_HEADER - CONTAINER_PAD.y;
      container.width = maxX - minX + CONTAINER_PAD.x * 2;
      container.height =
        maxY - minY + CONTAINER_PAD.y * 2 + CONTAINER_HEADER;
      container.cx = container.left + container.width / 2;
      container.cy = container.top + container.height / 2;
    }
    for (const container of containers) {
      if (container.left === undefined) continue;
      graph.worldWidth = Math.max(
        graph.worldWidth,
        container.left + container.width,
      );
      graph.worldHeight = Math.max(
        graph.worldHeight,
        container.top + container.height,
      );
    }
    graph.worldWidth = Math.max(0, graph.worldWidth);
    graph.worldHeight = Math.max(0, worldHeight, graph.worldHeight);
    return true;
  }

  window.FlowGraph = {
    flattenFlowSteps,
    numberingOf,
    groupDepthOf,
    buildGraph,
    buildSwimlane,
    layoutGraph,
  };
})();
